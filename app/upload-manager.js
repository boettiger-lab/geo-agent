/**
 * UploadManager — user-uploaded GeoJSON polygons as agent-addressable layers
 *
 * Opt-in only (never loaded unless `upload_enabled` is set in config). Lets a
 * user drop a small polygon GeoJSON on the map. The file is:
 *   1. parsed + validated + size/feature-capped entirely in the browser,
 *   2. PUT directly to the public-output S3 bucket (browser → S3, a plain
 *      fetch PUT — NOT an SDK chunked upload, which the anonymous endpoint
 *      corrupts), and
 *   3. drawn inline on the map.
 *
 * The upload payload never passes through the LLM — only the resulting URL is
 * exposed to the agent (via the `get_uploaded_dataset` tool wired in main.js),
 * which reads it back with DuckDB `ST_Read(...)` in the existing `query` tool.
 * See geo-agent#325. Large/complex/non-polygon data is out of scope by design;
 * the size cap steers those users to a data-ingest request.
 */

const DEFAULTS = {
    bucketUrl: 'https://s3-west.nrp-nautilus.io/public-output',
    prefix: 'uploads',
    maxBytes: 5 * 1024 * 1024, // 5 MB — inline geojson stays snappy below this
    maxFeatures: 1000,
    ingestUrl: null,
};

/* ── Pure helpers (unit-tested in test/upload-manager.test.js) ─────────────── */

/**
 * Validate that a parsed object is a polygon GeoJSON within limits.
 * @returns {{ok: boolean, error?: string, features?: Array, geometryTypes?: string[]}}
 */
export function validatePolygonGeoJSON(obj, { maxFeatures = DEFAULTS.maxFeatures } = {}) {
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'Not valid JSON.' };
    let features;
    if (obj.type === 'FeatureCollection') features = Array.isArray(obj.features) ? obj.features : [];
    else if (obj.type === 'Feature') features = [obj];
    else return { ok: false, error: 'Expected a GeoJSON Feature or FeatureCollection.' };

    if (features.length === 0) return { ok: false, error: 'GeoJSON contains no features.' };
    if (features.length > maxFeatures) {
        return { ok: false, error: `Too many features (${features.length} > ${maxFeatures}). Please file a data-ingest request for large datasets.` };
    }

    const geometryTypes = [];
    for (const f of features) {
        const t = f?.geometry?.type;
        if (!t) return { ok: false, error: 'A feature is missing geometry.' };
        if (t !== 'Polygon' && t !== 'MultiPolygon') {
            return { ok: false, error: `Only Polygon/MultiPolygon boundaries are supported here (found ${t}). File a data-ingest request for other data.` };
        }
        if (!geometryTypes.includes(t)) geometryTypes.push(t);
    }
    return { ok: true, features, geometryTypes };
}

/**
 * Compute [w, s, e, n] bounds over all coordinates of a polygon GeoJSON.
 * @returns {[number,number,number,number]|null}
 */
export function computeBounds(geojson) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const visit = (coords) => {
        if (typeof coords[0] === 'number') {
            const [lon, lat] = coords;
            if (lon < w) w = lon; if (lon > e) e = lon;
            if (lat < s) s = lat; if (lat > n) n = lat;
        } else {
            for (const c of coords) visit(c);
        }
    };
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    for (const f of features) {
        if (f?.geometry?.coordinates) visit(f.geometry.coordinates);
    }
    return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * Union of property keys across features, capped, for hover tooltips.
 * @returns {string[]}
 */
export function pickTooltipFields(features, max = 8) {
    const keys = [];
    for (const f of features) {
        const props = f?.properties;
        if (!props || typeof props !== 'object') continue;
        for (const k of Object.keys(props)) {
            if (!keys.includes(k)) keys.push(k);
            if (keys.length >= max) return keys;
        }
    }
    return keys;
}

/** Public object URL for an uploaded file. */
export function buildObjectUrl(bucketUrl, prefix, hash) {
    return `${bucketUrl.replace(/\/$/, '')}/${prefix}/${hash}/data.geojson`;
}

/** SHA-256 → first 16 hex chars, a short content-addressed id. */
export async function contentHash(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 16);
}

/* ── DOM / network glue (browser-only, verified manually) ──────────────────── */

export class UploadManager {
    /**
     * @param {import('./map-manager.js').MapManager} mapManager
     * @param {Object} [config] - options object (or {} for defaults)
     */
    constructor(mapManager, config = {}) {
        this.mapManager = mapManager;
        this.map = mapManager.map;
        this.cfg = {
            bucketUrl: config.bucket_url || DEFAULTS.bucketUrl,
            prefix: config.prefix || DEFAULTS.prefix,
            maxBytes: config.max_bytes || DEFAULTS.maxBytes,
            maxFeatures: config.max_features || DEFAULTS.maxFeatures,
            ingestUrl: config.ingest_url || DEFAULTS.ingestUrl,
        };
        /** @type {Array<{url,layerId,displayName,geometryType,propertyKeys,featureCount}>} */
        this.uploads = [];
        this._input = null;
    }

    /** Inject the upload button + hidden file input, and wire map drag-drop. */
    init() {
        const controls = document.getElementById('layer-controls-container');
        if (!controls || !controls.parentNode) {
            console.warn('[upload] layer panel not found — upload UI not mounted');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.geojson,.json,application/geo+json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            if (input.files && input.files[0]) this.handleFile(input.files[0]);
            input.value = ''; // allow re-selecting the same file
        });
        this._input = input;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'upload-btn';
        btn.textContent = '+ Upload GeoJSON';
        btn.title = 'Upload a polygon GeoJSON to show on the map and query';
        btn.addEventListener('click', () => input.click());

        this._status = document.createElement('div');
        this._status.className = 'upload-status';

        // Sit at the bottom of the Overlays section, below the layer list
        // (uploaded rows append into the list above, so the button stays last).
        controls.after(btn, input, this._status);

        this._wireDragDrop();
        console.log('[upload] ready');
    }

    _wireDragDrop() {
        const el = this.map.getContainer();
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        el.addEventListener('dragover', (e) => {
            if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { stop(e); el.classList.add('upload-dragover'); }
        });
        el.addEventListener('dragleave', () => el.classList.remove('upload-dragover'));
        el.addEventListener('drop', (e) => {
            if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
            stop(e);
            el.classList.remove('upload-dragover');
            this.handleFile(e.dataTransfer.files[0]);
        });
    }

    _setStatus(msg, isError = false) {
        if (this._status) {
            this._status.textContent = msg;
            this._status.classList.toggle('is-error', isError);
        }
        if (isError) console.warn('[upload]', msg); else console.log('[upload]', msg);
    }

    _fail(msg) {
        this._setStatus(msg, true);
        window.dispatchEvent(new CustomEvent('geojson-upload-error', { detail: { message: msg } }));
        return { success: false, error: msg };
    }

    /**
     * Parse → validate → hash → PUT to S3 → draw → announce.
     * @param {File} file
     */
    async handleFile(file) {
        if (file.size > this.cfg.maxBytes) {
            const mb = (this.cfg.maxBytes / 1024 / 1024).toFixed(0);
            return this._fail(
                `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB > ${mb} MB limit). ` +
                (this.cfg.ingestUrl ? `Please file a data-ingest request: ${this.cfg.ingestUrl}` : 'Please file a data-ingest request for large datasets.'),
            );
        }

        let text;
        try { text = await file.text(); } catch { return this._fail('Could not read the file.'); }

        let parsed;
        try { parsed = JSON.parse(text); } catch { return this._fail('File is not valid JSON/GeoJSON.'); }

        const v = validatePolygonGeoJSON(parsed, { maxFeatures: this.cfg.maxFeatures });
        if (!v.ok) return this._fail(v.error);

        this._setStatus(`Uploading "${file.name}"…`);
        const hash = await contentHash(text);
        const url = buildObjectUrl(this.cfg.bucketUrl, this.cfg.prefix, hash);

        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/geo+json' },
                body: text, // plain PUT — anonymous endpoint corrupts SDK-chunked bodies
            });
            if (!res.ok) return this._fail(`Upload failed (HTTP ${res.status}).`);
        } catch (err) {
            return this._fail(`Upload failed: ${err.message}`);
        }

        const displayName = file.name.replace(/\.(geo)?json$/i, '') || 'Uploaded layer';
        const bounds = computeBounds(parsed);
        const propertyKeys = pickTooltipFields(v.features);

        const added = this.mapManager.addUploadedLayer({
            id: hash, geojson: parsed, displayName, tooltipFields: propertyKeys, bounds,
        });
        if (!added.success) return this._fail(added.error || 'Could not add layer to map.');

        const record = {
            url, layerId: added.layer_id, displayName,
            geometryType: v.geometryTypes.join('+'),
            propertyKeys, featureCount: v.features.length,
        };
        // Keep one record per url (idempotent re-upload).
        this.uploads = this.uploads.filter(u => u.url !== url);
        this.uploads.push(record);

        this._setStatus(`Added "${displayName}" (${record.featureCount} feature${record.featureCount === 1 ? '' : 's'}).`);
        window.dispatchEvent(new CustomEvent('geojson-uploaded', { detail: record }));
        return { success: true, ...record };
    }

    /** All uploaded datasets, most recent last. */
    getUploads() { return this.uploads.slice(); }

    /** Most recently uploaded dataset, or null. */
    getLatest() { return this.uploads.length ? this.uploads[this.uploads.length - 1] : null; }
}
