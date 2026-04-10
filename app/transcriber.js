/**
 * Transcriber — sends audio to a speech-to-text model and returns plain text.
 *
 * The transcription model is configured separately from the main agent model
 * via `config.transcription_model`, so voice input works regardless of which
 * reasoning model the user has selected for the agentic loop.
 *
 * Backend-agnostic: any OpenAI-compatible chat-completions endpoint that
 * accepts the `input_audio` content part will work. Currently tested against
 * gemma4 on the NRP llm-proxy; a dedicated Whisper deployment can be
 * substituted by changing `transcription_model` in config.json.
 */

export class Transcriber {
    /**
     * @param {Object} modelCfg - transcription model config
     *   { value, endpoint, api_key }
     */
    constructor(modelCfg) {
        if (!modelCfg?.value) {
            throw new Error('Transcriber requires a model config with a `value` field');
        }
        this.modelCfg = modelCfg;
    }

    /**
     * Transcribe a base64-encoded audio blob to plain text.
     *
     * @param {{data: string, format: string}} audio
     *   data: base64 payload (no data: URL prefix)
     *   format: 'wav' | 'mp3' | ... (hint for the API)
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<string>} trimmed transcript
     */
    async transcribe(audio, opts = {}) {
        let endpoint = this.modelCfg.endpoint || 'https://llm-proxy.nrp-nautilus.io/v1';
        if (!endpoint.endsWith('/chat/completions')) {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }

        const messages = [
            {
                role: 'system',
                content:
                    'You are a speech-to-text transcriber. Transcribe the following audio exactly as spoken. ' +
                    'Output only the transcribed text with no commentary, labels, quotation marks, or formatting.',
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'input_audio',
                        input_audio: { data: audio.data, format: audio.format },
                    },
                ],
            },
        ];

        const payload = {
            model: this.modelCfg.value,
            messages,
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.modelCfg.api_key || 'EMPTY'}`,
            },
            body: JSON.stringify(payload),
            signal: opts.signal ?? AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Transcription API error (${response.status}): ${errorText.substring(0, 200)}`
            );
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        return text.trim();
    }
}
