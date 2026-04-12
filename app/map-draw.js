/**
 * MapDraw — polygon drawing for spatial queries
 *
 * Dynamically loads @mapbox/mapbox-gl-draw from CDN, wraps it with
 * single-polygon semantics, and exposes the drawn region as WKT.
 * Opt-in only — never loaded unless draw_enabled is set in config.
 */

const DRAW_JS  = 'https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.js';
const DRAW_CSS = 'https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.css';

/** Load a JS script by URL, resolves when loaded. */
function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(s);
    });
}

/** Load a CSS stylesheet by URL. */
function loadCSS(url) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
}

/**
 * Convert a GeoJSON Polygon to WKT.
 * @param {Object} geojson — GeoJSON Feature with Polygon geometry
 * @returns {string} WKT POLYGON string
 */
function toWKT(geojson) {
    const ring = geojson.geometry.coordinates[0];
    const coords = ring.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
    return `POLYGON((${coords}))`;
}

/**
 * Map zoom level → suggested H3 resolution.
 * Conservative: prefers slightly lower resolution to avoid expensive hex ops.
 *   zoom 2→1, 4→2, 6→3, 8→4, 10→5, 12→6, 14→7, 16+→8
 */
function zoomToH3Resolution(zoom) {
    return Math.min(8, Math.max(1, Math.floor(zoom / 2)));
}

export class MapDraw {
    /**
     * @param {maplibregl.Map} map
     */
    constructor(map) {
        this.map = map;
        this.draw = null;          // MapboxDraw instance (set after library loads)
        this._currentFeatureId = null;
        this._zoomAtDraw = null;   // map zoom when polygon was completed
        this._drawActive = false;  // whether draw mode is currently active
        this._button = null;
    }

    /** Initialize: load library, add controls, wire events. */
    async init() {
        loadCSS(DRAW_CSS);
        await loadScript(DRAW_JS);

        /* global MapboxDraw */
        this.draw = new MapboxDraw({
            displayControlsDefault: false,
            defaultMode: 'simple_select',
            styles: this._drawStyles(),
        });

        // Add draw to map (no visible controls — we provide our own button)
        this.map.addControl(this.draw, 'top-left');

        // Hide the empty mapbox-gl-draw control container
        const containers = this.map.getContainer()
            .querySelectorAll('.mapboxgl-ctrl-group, .maplibregl-ctrl-group');
        for (const el of containers) {
            if (el.children.length === 0) el.style.display = 'none';
        }

        // Add our custom draw button as a MapLibre control
        this.map.addControl(new DrawButtonControl(this), 'top-left');

        // Wire draw events
        this.map.on('draw.create', (e) => this._onDrawCreate(e));
        this.map.on('draw.update', () => {}); // silent update — no re-notification
        this.map.on('draw.delete', () => this._onDrawDelete());
        this.map.on('draw.modechange', (e) => {
            // If user presses Escape or finishes, update button state
            if (e.mode === 'simple_select' || e.mode === 'direct_select') {
                this._drawActive = false;
                this._updateButton();
            }
        });
    }

    // ---- Public API ----

    /** Get the current drawn polygon as WKT, or null. */
    getRegionWKT() {
        if (!this.draw) return null;
        const all = this.draw.getAll();
        if (!all.features.length) return null;
        return toWKT(all.features[0]);
    }

    /** Get the suggested H3 resolution based on zoom at draw time. */
    getSuggestedH3Resolution() {
        if (this._zoomAtDraw == null) return null;
        return zoomToH3Resolution(this._zoomAtDraw);
    }

    /** Clear the drawn polygon. */
    clear() {
        if (!this.draw) return;
        this.draw.deleteAll();
        this._currentFeatureId = null;
        this._zoomAtDraw = null;
        this._drawActive = false;
        this._updateButton();
        window.dispatchEvent(new CustomEvent('region-cleared'));
    }

    /** Enter polygon draw mode. */
    startDrawing() {
        if (!this.draw) return;
        // Clear any existing polygon first
        this.draw.deleteAll();
        this._currentFeatureId = null;
        this.draw.changeMode('draw_polygon');
        this._drawActive = true;
        this._updateButton();
    }

    /** Whether a completed polygon exists. */
    hasRegion() {
        if (!this.draw) return false;
        return this.draw.getAll().features.length > 0 && !this._drawActive;
    }

    // ---- Internal ----

    _onDrawCreate(e) {
        const feature = e.features[0];
        // Enforce single polygon: delete any previous
        const all = this.draw.getAll();
        for (const f of all.features) {
            if (f.id !== feature.id) this.draw.delete(f.id);
        }
        this._currentFeatureId = feature.id;
        this._zoomAtDraw = this.map.getZoom();
        this._drawActive = false;
        this._updateButton();
        window.dispatchEvent(new CustomEvent('region-drawn'));
    }

    _onDrawDelete() {
        this._currentFeatureId = null;
        this._zoomAtDraw = null;
        this._drawActive = false;
        this._updateButton();
        window.dispatchEvent(new CustomEvent('region-cleared'));
    }

    _updateButton() {
        if (!this._button) return;
        this._button.classList.toggle('active', this._drawActive || this.hasRegion());
        this._button.title = this._drawActive
            ? 'Drawing\u2026 click map to add vertices, double-click to finish'
            : this.hasRegion()
                ? 'Region drawn \u2014 click to redraw, right-click to clear'
                : 'Draw a region on the map';
    }

    /** Custom draw styles — semi-transparent fill, dashed outline while drawing. */
    _drawStyles() {
        return [
            // Polygon fill
            {
                id: 'gl-draw-polygon-fill',
                type: 'fill',
                filter: ['all', ['==', '$type', 'Polygon']],
                paint: {
                    'fill-color': '#3b82f6',
                    'fill-opacity': 0.15,
                },
            },
            // Polygon outline
            {
                id: 'gl-draw-polygon-stroke',
                type: 'line',
                filter: ['all', ['==', '$type', 'Polygon']],
                paint: {
                    'line-color': '#3b82f6',
                    'line-width': 2,
                    'line-dasharray': [2, 2],
                },
            },
            // Vertex points
            {
                id: 'gl-draw-point',
                type: 'circle',
                filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#3b82f6',
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                },
            },
            // Midpoints
            {
                id: 'gl-draw-midpoint',
                type: 'circle',
                filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
                paint: {
                    'circle-radius': 3,
                    'circle-color': '#3b82f6',
                },
            },
            // Line while drawing
            {
                id: 'gl-draw-line',
                type: 'line',
                filter: ['all', ['==', '$type', 'LineString']],
                paint: {
                    'line-color': '#3b82f6',
                    'line-width': 2,
                    'line-dasharray': [2, 2],
                },
            },
        ];
    }
}

/**
 * Custom MapLibre IControl — a single toggle button for polygon drawing.
 * Styled to match the navigation control (same container class).
 */
class DrawButtonControl {
    constructor(mapDraw) {
        this._mapDraw = mapDraw;
    }

    onAdd() {
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        const btn = document.createElement('button');
        btn.id = 'draw-toggle';
        btn.type = 'button';
        btn.title = 'Draw a region on the map';
        // Pentagon SVG icon
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polygon points="12,2 22,9 18,21 6,21 2,9"/></svg>';

        btn.addEventListener('click', () => {
            if (this._mapDraw._drawActive) {
                // Cancel current drawing
                this._mapDraw.draw.changeMode('simple_select');
                this._mapDraw._drawActive = false;
                this._mapDraw._updateButton();
            } else if (this._mapDraw.hasRegion()) {
                // Redraw — clear and start new
                this._mapDraw.startDrawing();
            } else {
                // Start drawing
                this._mapDraw.startDrawing();
            }
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this._mapDraw.hasRegion()) {
                this._mapDraw.clear();
            }
        });

        this._mapDraw._button = btn;
        this._container.appendChild(btn);
        return this._container;
    }

    onRemove() {
        this._container.remove();
    }
}
