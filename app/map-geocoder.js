/**
 * MapGeocoder — optional on-map search box.
 *
 * A thin adapter that drives the @maplibre/maplibre-gl-geocoder UI control with
 * the SAME backend the `geocode` agent tool uses (geocoder.js). Lazy-loads the
 * library from CDN only when `geocoder.search_box` is enabled — mirrors
 * map-draw.js (opt-in, SRI-pinned). Never loaded otherwise.
 */

const GEOCODER_JS = 'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-geocoder@1.9.4/dist/maplibre-gl-geocoder.min.js';
const GEOCODER_JS_SRI = 'sha384-RGV5vfoJd7alk8HE+71IyVfu19ciH1FKA15+AuXs6OeBM2npXrmTPFqG23yMiHXi';
const GEOCODER_CSS = 'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-geocoder@1.9.4/dist/maplibre-gl-geocoder.css';
const GEOCODER_CSS_SRI = 'sha384-UkDpPApjTpHJHpcJiSNAmbobh30W0/dmt0DoKm4V8CWYRYvQ/Jhd/ijFz0tFdVnH';

/** Load a JS script by URL, resolves when loaded. */
function loadScript(url, integrity) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        if (integrity) {
            s.integrity = integrity;
            s.crossOrigin = 'anonymous';
        }
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

/** Load a CSS stylesheet by URL. */
function loadCSS(url, integrity) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    if (integrity) {
        link.integrity = integrity;
        link.crossOrigin = 'anonymous';
    }
    document.head.appendChild(link);
}

/**
 * Convert a normalized GeocodeResult (geocoder.js) into the Carmen GeoJSON
 * feature shape maplibre-gl-geocoder expects. Pure — exported for tests.
 *
 * @param {import('./geocoder.js').GeocodeResult} r
 * @returns {Object} Carmen GeoJSON Feature
 */
export function toCarmenFeature(r) {
    const center = [r.lon, r.lat];
    const feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: center },
        properties: { match_quality: r.match_quality, source: r.source },
        place_name: r.display_name,
        place_type: ['place'],
        center,
        text: r.display_name,
    };
    if (r.bbox) feature.bbox = r.bbox;
    return feature;
}

/**
 * Build the maplibre-gl-geocoder API object backed by our geocoder. Pure
 * (no DOM) — exported for tests. The control passes `{ query, limit }` for
 * forward lookups and `{ query: [lon, lat] }` for reverse.
 *
 * @param {{ forwardGeocode: Function, reverseGeocode: Function }} geocoder
 */
export function buildGeocoderApi(geocoder) {
    return {
        forwardGeocode: async (config) => {
            try {
                const results = await geocoder.forwardGeocode(config.query, { limit: config.limit || 5 });
                return { features: results.map(toCarmenFeature) };
            } catch {
                return { features: [] };
            }
        },
        reverseGeocode: async (config) => {
            try {
                const [lon, lat] = config.query || [];
                const r = await geocoder.reverseGeocode(lat, lon);
                return { features: r ? [toCarmenFeature(r)] : [] };
            } catch {
                return { features: [] };
            }
        },
    };
}

/**
 * Add the search box to the map.
 *
 * @param {maplibregl.Map} map
 * @param {{ forwardGeocode: Function, reverseGeocode: Function }} geocoder
 * @param {Object} [options]
 * @param {string} [options.position='top-left']
 * @param {string} [options.placeholder='Search address or place…']
 * @returns {Promise<Object>} the MaplibreGeocoder control instance
 */
export async function addSearchBox(map, geocoder, options = {}) {
    loadCSS(GEOCODER_CSS, GEOCODER_CSS_SRI);
    await loadScript(GEOCODER_JS, GEOCODER_JS_SRI);

    /* global MaplibreGeocoder */
    const ctrl = new MaplibreGeocoder(buildGeocoderApi(geocoder), {
        maplibregl: window.maplibregl,
        marker: !!window.maplibregl,            // markers need the maplibregl module
        showResultsWhileTyping: true,
        minLength: 3,
        placeholder: options.placeholder || 'Search address or place…',
        // Forward bbox-framing / fly handled below so it works without markers.
        flyTo: false,
    });

    map.addControl(ctrl, options.position || 'top-left');

    // Frame the result: fit its bbox when present, else fly to the point.
    ctrl.on('result', (e) => {
        const r = e.result || {};
        if (Array.isArray(r.bbox) && r.bbox.length === 4) {
            map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 48, maxZoom: 16 });
        } else if (Array.isArray(r.center)) {
            map.flyTo({ center: r.center, zoom: 14 });
        }
    });

    return ctrl;
}
