/**
 * Geocoder — pluggable place-name / address → coordinate resolution.
 *
 * One backend, two consumers:
 *   1. the `geocode` agent tool (map-tools.js) — so the LLM resolves real,
 *      traceable coordinates instead of inventing lat/lng from memory, and
 *   2. the optional maplibre-gl-geocoder search box (map-geocoder.js).
 *
 * All providers are global and CORS-clean from a static browser app:
 *   - nominatim (default) — OSM, free, no key. Rich confidence signals.
 *   - photon              — OSM (Komoot), free, no key. Returns extents.
 *   - maptiler            — high quality, requires an API key.
 *
 * A custom `endpoint` lets an app point a provider at a self-hosted instance
 * (e.g. a private Nominatim) without changing the parsing.
 *
 * Every provider normalizes to the same shape so both consumers — and any
 * future provider — are interchangeable:
 *
 * @typedef {Object} GeocodeResult
 * @property {number} lat
 * @property {number} lon
 * @property {[number, number, number, number]|null} bbox  // [west, south, east, north]
 * @property {string} display_name  // normalized, matched location — echo to the user
 * @property {'high'|'medium'|'low'} match_quality
 * @property {string} source         // provider id
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const PHOTON_BASE = 'https://photon.komoot.io';
const MAPTILER_BASE = 'https://api.maptiler.com/geocoding';

/** Coerce a value to a finite number, or return null. */
function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Map a 0..1 score (Nominatim importance, MapTiler relevance) to a coarse
 * quality bucket. Callers also use result count for disambiguation.
 */
function bucket(score) {
    if (score == null) return 'medium';
    if (score >= 0.5) return 'high';
    if (score >= 0.2) return 'medium';
    return 'low';
}

/* ── Provider: Nominatim ──────────────────────────────────────────────── */

function nominatimUrl(base, query, limit, email) {
    const p = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: String(limit),
        addressdetails: '1',
    });
    if (email) p.set('email', email);   // contact per OSM usage policy
    return `${base}/search?${p}`;
}

function nominatimReverseUrl(base, lat, lon, email) {
    const p = new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
        format: 'jsonv2',
    });
    if (email) p.set('email', email);
    return `${base}/reverse?${p}`;
}

/** Parse a Nominatim search array (or a single reverse object) → results. */
function parseNominatim(json) {
    const rows = Array.isArray(json) ? json : (json ? [json] : []);
    return rows.map((r) => {
        // boundingbox is [south, north, west, east] (strings) → [w, s, e, n]
        let bbox = null;
        const bb = r.boundingbox;
        if (Array.isArray(bb) && bb.length === 4) {
            const [s, n, w, e] = bb.map(num);
            if ([s, n, w, e].every((v) => v != null)) bbox = [w, s, e, n];
        }
        return {
            lat: num(r.lat),
            lon: num(r.lon),
            bbox,
            display_name: r.display_name || r.name || '',
            match_quality: bucket(num(r.importance)),
            source: 'nominatim',
        };
    }).filter((r) => r.lat != null && r.lon != null);
}

/* ── Provider: Photon ─────────────────────────────────────────────────── */

function photonUrl(base, query, limit) {
    const p = new URLSearchParams({ q: query, limit: String(limit) });
    return `${base}/api/?${p}`;
}

function photonReverseUrl(base, lat, lon) {
    const p = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    return `${base}/reverse?${p}`;
}

/** Build the human label Photon omits (it returns address parts, not a string). */
function photonLabel(props) {
    const parts = [
        props.name,
        props.street && props.housenumber ? `${props.housenumber} ${props.street}` : props.street,
        props.city || props.district,
        props.state,
        props.postcode,
        props.country,
    ];
    return parts.filter(Boolean).join(', ');
}

/** Parse a Photon GeoJSON FeatureCollection → results. */
function parsePhoton(json) {
    const feats = json?.features || [];
    return feats.map((f) => {
        const [lon, lat] = f.geometry?.coordinates || [];
        // Photon extent is [minLon, maxLat, maxLon, minLat] → [w, s, e, n]
        let bbox = null;
        const ext = f.properties?.extent;
        if (Array.isArray(ext) && ext.length === 4) {
            const [w, n, e, s] = ext.map(num);
            if ([w, n, e, s].every((v) => v != null)) bbox = [w, s, e, n];
        }
        return {
            lat: num(lat),
            lon: num(lon),
            bbox,
            display_name: photonLabel(f.properties || {}),
            // Photon has no per-result score; rank reflects ordering only.
            match_quality: 'medium',
            source: 'photon',
        };
    }).filter((r) => r.lat != null && r.lon != null);
}

/* ── Provider: MapTiler ───────────────────────────────────────────────── */

function maptilerUrl(base, query, limit, key) {
    const p = new URLSearchParams({ key, limit: String(limit) });
    return `${base}/${encodeURIComponent(query)}.json?${p}`;
}

function maptilerReverseUrl(base, lat, lon, key) {
    const p = new URLSearchParams({ key });
    return `${base}/${lon},${lat}.json?${p}`;
}

/** Parse a MapTiler geocoding GeoJSON FeatureCollection → results. */
function parseMaptiler(json) {
    const feats = json?.features || [];
    return feats.map((f) => {
        const [lon, lat] = f.center || f.geometry?.coordinates || [];
        // MapTiler features carry a standard GeoJSON bbox: [w, s, e, n]
        let bbox = null;
        if (Array.isArray(f.bbox) && f.bbox.length === 4) {
            const b = f.bbox.map(num);
            if (b.every((v) => v != null)) bbox = b;
        }
        return {
            lat: num(lat),
            lon: num(lon),
            bbox,
            display_name: f.place_name || f.text || '',
            match_quality: bucket(num(f.relevance)),
            source: 'maptiler',
        };
    }).filter((r) => r.lat != null && r.lon != null);
}

/* ── Factory ──────────────────────────────────────────────────────────── */

/**
 * Build a geocoder for the configured provider.
 *
 * @param {Object} [config]
 * @param {'nominatim'|'photon'|'maptiler'} [config.provider='nominatim']
 * @param {string} [config.endpoint]      // base URL override (e.g. self-hosted Nominatim)
 * @param {string} [config.maptiler_key]  // required for the maptiler provider
 * @param {string} [config.email]         // contact passed to Nominatim per usage policy
 * @param {typeof fetch} [config.fetchImpl=fetch]  // injectable for tests
 * @returns {{ provider: string, forwardGeocode: Function, reverseGeocode: Function }}
 */
export function createGeocoder(config = {}) {
    const provider = config.provider || 'nominatim';
    const fetchImpl = config.fetchImpl || ((...a) => fetch(...a));

    const bases = {
        nominatim: config.endpoint || NOMINATIM_BASE,
        photon: config.endpoint || PHOTON_BASE,
        maptiler: config.endpoint || MAPTILER_BASE,
    };

    if (provider === 'maptiler' && !config.maptiler_key) {
        throw new Error('geocoder provider "maptiler" requires config.maptiler_key');
    }
    if (!bases[provider]) {
        throw new Error(`Unknown geocoder provider "${provider}". Use nominatim, photon, or maptiler.`);
    }

    async function get(url, signal) {
        const res = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
        return res.json();
    }

    /**
     * Resolve free text → ranked candidates.
     * @param {string} query
     * @param {{ limit?: number, signal?: AbortSignal }} [opts]
     * @returns {Promise<GeocodeResult[]>}
     */
    async function forwardGeocode(query, opts = {}) {
        const q = (query || '').trim();
        if (!q) return [];
        const limit = Math.max(1, Math.min(opts.limit || 5, 10));
        const base = bases[provider];
        let url;
        if (provider === 'nominatim') url = nominatimUrl(base, q, limit, config.email);
        else if (provider === 'photon') url = photonUrl(base, q, limit);
        else url = maptilerUrl(base, q, limit, config.maptiler_key);

        const json = await get(url, opts.signal);
        if (provider === 'nominatim') return parseNominatim(json);
        if (provider === 'photon') return parsePhoton(json);
        return parseMaptiler(json);
    }

    /**
     * Resolve coordinates → the place at that point (best single match).
     * @param {number} lat
     * @param {number} lon
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<GeocodeResult|null>}
     */
    async function reverseGeocode(lat, lon, opts = {}) {
        const la = num(lat), lo = num(lon);
        if (la == null || lo == null) return null;
        const base = bases[provider];
        let url;
        if (provider === 'nominatim') url = nominatimReverseUrl(base, la, lo, config.email);
        else if (provider === 'photon') url = photonReverseUrl(base, la, lo);
        else url = maptilerReverseUrl(base, la, lo, config.maptiler_key);

        const json = await get(url, opts.signal);
        let results;
        if (provider === 'nominatim') results = parseNominatim(json);
        else if (provider === 'photon') results = parsePhoton(json);
        else results = parseMaptiler(json);
        return results[0] || null;
    }

    return { provider, forwardGeocode, reverseGeocode };
}

// Exported for unit tests — not part of the public surface.
export const _internal = { parseNominatim, parsePhoton, parseMaptiler, bucket };
