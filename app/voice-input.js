/**
 * VoiceInput - MediaRecorder wrapper for capturing chat voice input.
 *
 * Exploratory: records audio via the browser mic, returns a base64-encoded
 * blob ready to be passed as an OpenAI `input_audio` content part to
 * audio-capable chat models (gemma4 in our configured stack).
 *
 * Capability gating lives in chat-ui.js — this file only handles capture.
 */

export class VoiceInput {
    constructor() {
        this.recorder = null;
        this.chunks = [];
        this.stream = null;
        this.mimeType = null;
    }

    /**
     * True if the browser exposes the APIs we need. Does NOT check mic
     * permission (which requires a user gesture).
     */
    static isSupported() {
        return typeof navigator !== 'undefined'
            && !!navigator.mediaDevices?.getUserMedia
            && typeof MediaRecorder !== 'undefined';
    }

    /**
     * Begin recording. Resolves once the MediaRecorder is actually running.
     */
    async start() {
        if (this.recorder) throw new Error('Already recording');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.chunks = [];

        // Prefer webm/opus (broad browser support, small files). The LLM
        // side may need wav/PCM16 — we surface the container type so the
        // caller can decide whether to transcode.
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
        ];
        this.mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';

        this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
        this.recorder.addEventListener('dataavailable', e => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        });
        this.recorder.start();
    }

    /**
     * Stop recording and return { data, format, mimeType } where `data` is
     * base64 (no data: prefix) and `format` is a hint for the API payload.
     */
    async stop() {
        if (!this.recorder) throw new Error('Not recording');
        const rec = this.recorder;
        const stream = this.stream;
        const mimeType = this.mimeType;

        const blob = await new Promise((resolve) => {
            rec.addEventListener('stop', () => {
                resolve(new Blob(this.chunks, { type: mimeType || 'audio/webm' }));
            }, { once: true });
            rec.stop();
        });

        stream.getTracks().forEach(t => t.stop());
        this.recorder = null;
        this.stream = null;
        this.chunks = [];

        const wav = await this._toWav(blob);
        const data = await this._blobToBase64(wav);
        return { data, format: 'wav', mimeType: 'audio/wav', size: wav.size };
    }

    async _toWav(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();

        const numChannels = decoded.numberOfChannels;
        const sampleRate = decoded.sampleRate;
        const numFrames = decoded.length;
        const pcm = new Int16Array(numFrames * numChannels);

        for (let ch = 0; ch < numChannels; ch++) {
            const samples = decoded.getChannelData(ch);
            for (let i = 0; i < numFrames; i++) {
                pcm[i * numChannels + ch] = Math.max(-32768, Math.min(32767, samples[i] * 32768));
            }
        }

        return this._buildWavBlob(pcm, numChannels, sampleRate);
    }

    _buildWavBlob(pcm, numChannels, sampleRate) {
        const byteRate = sampleRate * numChannels * 2;
        const blockAlign = numChannels * 2;
        const dataSize = pcm.byteLength;
        const buf = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buf);
        const write = (off, str) => [...str].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

        write(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        write(8, 'WAVE');
        write(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);          // PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);         // bits per sample
        write(36, 'data');
        view.setUint32(40, dataSize, true);
        new Int16Array(buf, 44).set(pcm);

        return new Blob([buf], { type: 'audio/wav' });
    }

    /**
     * Abort an in-progress recording without returning any data.
     */
    cancel() {
        if (!this.recorder) return;
        try { this.recorder.stop(); } catch { /* ignore */ }
        this.stream?.getTracks().forEach(t => t.stop());
        this.recorder = null;
        this.stream = null;
        this.chunks = [];
    }

    _blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result || '';
                // strip "data:audio/...;base64," prefix
                const comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    _guessFormat(mimeType) {
        if (!mimeType) return 'webm';
        if (mimeType.includes('webm')) return 'webm';
        if (mimeType.includes('ogg')) return 'ogg';
        if (mimeType.includes('mp4')) return 'mp4';
        if (mimeType.includes('wav')) return 'wav';
        if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
        return 'webm';
    }
}
