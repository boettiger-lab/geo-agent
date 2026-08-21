/**
 * animation-manager.js — Temporal animation layers
 *
 * TrajectoryAnimation: animates points along timestamped LineString
 * trajectories. Each input feature is a LineString with a parallel array
 * of ISO timestamps (one per coordinate). The animation loops the
 * combined time range.
 *
 * Two playback modes, because the two make very different claims about the
 * data:
 *
 *   - `smooth`  — interpolates each entity's position linearly between
 *     waypoints. Reads as continuous tracking, so it is an *illustration* of
 *     the sequence, not a record of the path travelled.
 *   - `stepped` — shows only the observations themselves. An entity appears at
 *     a waypoint for as long as that waypoint was reported and then vanishes
 *     until the next one, with no interpolation and no track line. Where the
 *     observations are grid cells rather than points (`hex_resolution`), the
 *     cell footprint is drawn instead of a dot, so the rendered extent matches
 *     the resolution of the data.
 *
 * Owns MapLibre sublayers (track-lines, cells, dots, labels) and a small
 * playback-controls panel. Lifecycle methods (setVisible / setFilter /
 * destroy) let MapManager treat it like any other layer.
 */

const DEFAULTS = {
    loop: true,
    duration_seconds: 30,
    dot_radius: 7,
    show_track_line: true,
    track_line_opacity: 0.35,
    show_labels: true,
    timestamp_field: 'timestamps',
    id_field: 'id',
    mode: 'smooth',          // 'smooth' | 'stepped'
    mode_toggle: false,      // offer a mode switch in the controls panel
    end_timestamp_field: null,  // parallel array: last time each waypoint held
    hold_hours: null,        // how long an observation stays up (see _holdMs)
    hex_resolution: null,    // H3 resolution of the observations, if gridded
    hex_opacity: 0.55,
};

/** Hold applied to a stepped observation when the data carries no end time. */
const DEFAULT_HOLD_HOURS = 6;

const MODE_LABELS = {
    stepped: 'observed only',
    smooth: 'interpolated',
};

export class TrajectoryAnimation {
    /**
     * @param {maplibregl.Map} map
     * @param {Object} opts
     * @param {string}  opts.layerId       — logical layer id from catalog
     * @param {string}  opts.displayName   — label for the controls panel
     * @param {string}  opts.tracksUrl     — URL of trajectory GeoJSON (LineStrings)
     * @param {string} [opts.staticUrl]    — URL of static-positions GeoJSON
     * @param {Object}  opts.config        — `animation` block from layers-input.json
     * @param {Object} [opts.paint]        — `default_style` from asset config
     */
    constructor(map, opts) {
        this.map = map;
        this.layerId = opts.layerId;
        this.displayName = opts.displayName || opts.layerId;
        this.config = { ...DEFAULTS, ...opts.config };
        this.paint = opts.paint || {};
        this.mode = this.config.mode === 'stepped' ? 'stepped' : 'smooth';

        const safe = this.layerId.replace(/[^a-zA-Z0-9]/g, '-');
        this.sourceIds = {
            lines: `src-${safe}-anim-lines`,
            cells: `src-${safe}-anim-cells`,
            dots:  `src-${safe}-anim-dots`,
            labels: `src-${safe}-anim-labels`,
        };
        this.layerIds = {
            lines: `layer-${safe}-anim-lines`,
            cellFill: `layer-${safe}-anim-cells-fill`,
            cellLine: `layer-${safe}-anim-cells-outline`,
            dots:  `layer-${safe}-anim-dots`,
            labels: `layer-${safe}-anim-labels`,
        };

        this.tracksByEntity = new Map();   // id → { coords, times, endTimes }
        this.staticPositions = new Map();  // id → [lon, lat]
        this.propsByEntity = new Map();    // id → scalar feature properties
        this.allEntities = [];
        this.globalStart = Infinity;
        this.globalEnd = -Infinity;

        this.playing = true;
        this.visible = true;
        this.speed = 1;
        this.animTime = 0;
        this.lastFrame = null;
        this.rafId = null;
        this.filterExpr = null;
        this.allowedIds = null;   // null = all allowed
        this.destroyed = false;

        this._panel = null;
        this._ready = this._init(opts.tracksUrl, opts.staticUrl);
    }

    get ready() { return this._ready; }

    /** Cells are drawn only when the data is gridded and h3-js is loaded. */
    get cellsEnabled() {
        return this.config.hex_resolution != null && typeof h3 !== 'undefined';
    }

    async _init(tracksUrl, staticUrl) {
        const fetches = [fetch(tracksUrl).then(r => r.json())];
        if (staticUrl) fetches.push(fetch(staticUrl).then(r => r.json()));
        const [tracksData, staticData] = await Promise.all(fetches);

        this._parseTracks(tracksData);
        if (staticData) this._parseStatic(staticData);

        this.allEntities = [
            ...new Set([...this.tracksByEntity.keys(), ...this.staticPositions.keys()]),
        ];

        if (this.globalStart === Infinity) {
            // No trajectories — fall back to static dots at their latest position
            this.globalStart = 0;
            this.globalEnd = 1;
        }
        this.animTime = this.globalStart;

        this._addLayers(tracksData);
        this._buildControls();
        this._applyMode();
        this._tick = this._tick.bind(this);
        this.rafId = requestAnimationFrame(this._tick);
    }

    _parseTracks(geojson) {
        const { id_field, timestamp_field, end_timestamp_field } = this.config;
        for (const feat of geojson.features || []) {
            if (!feat.geometry || feat.geometry.type !== 'LineString') continue;
            const id = feat.properties?.[id_field];
            const rawTimes = feat.properties?.[timestamp_field];
            if (id == null || !Array.isArray(rawTimes)) continue;
            const coords = feat.geometry.coordinates;
            const times = rawTimes.map(t => new Date(t).getTime());
            if (coords.length !== times.length || coords.length < 2) continue;
            // Optional parallel array: the last time each waypoint was still
            // being reported. Only honoured when it lines up 1:1 with the
            // waypoints — a mismatched array is data we can't trust.
            const rawEnds = end_timestamp_field
                ? feat.properties?.[end_timestamp_field] : null;
            const endTimes = Array.isArray(rawEnds) && rawEnds.length === times.length
                ? rawEnds.map(t => new Date(t).getTime())
                : null;
            this.tracksByEntity.set(id, { coords, times, endTimes });
            this.propsByEntity.set(id, scalarProps(feat.properties));
            this.globalStart = Math.min(this.globalStart, times[0]);
            this.globalEnd = Math.max(
                this.globalEnd,
                endTimes ? endTimes[endTimes.length - 1] : times[times.length - 1],
            );
        }
    }

    _parseStatic(geojson) {
        const { id_field } = this.config;
        for (const feat of geojson.features || []) {
            const id = feat.properties?.[id_field];
            if (id == null) continue;
            const centroid = this._featureCentroid(feat);
            if (!centroid) continue;
            this.staticPositions.set(id, centroid);
            if (!this.propsByEntity.has(id)) {
                this.propsByEntity.set(id, scalarProps(feat.properties));
            }
        }
    }

    _featureCentroid(feat) {
        const g = feat.geometry;
        if (!g) return null;
        if (g.type === 'Point') return g.coordinates;
        if (g.type === 'Polygon') return _ringCentroid(g.coordinates[0]);
        if (g.type === 'MultiPolygon') return _ringCentroid(g.coordinates[0][0]);
        return null;
    }

    /** Milliseconds an observation stays displayed past the time it was last seen. */
    _holdMs() {
        const hours = this.config.hold_hours != null
            ? this.config.hold_hours
            : (this.config.end_timestamp_field ? 0 : DEFAULT_HOLD_HOURS);
        return Math.max(0, hours) * 3600 * 1000;
    }

    _addLayers(tracksData) {
        const map = this.map;
        const { dot_radius, show_labels, id_field, hex_opacity } = this.config;
        const lineColor = this.paint['line-color'] || '#1976d2';
        const circleColor = this.paint['circle-color'] || '#1976d2';
        const circleStroke = this.paint['circle-stroke-color'] || '#ffffff';
        const lineWidth = this.paint['line-width'] ?? 2;

        // The track-line layer is always added, even when hidden: `setFilter`
        // resolves entity IDs by asking MapLibre to evaluate the filter against
        // this source, and a source with no layer using it is never tiled.
        // Hiding is done with opacity, not `visibility`, for the same reason.
        map.addSource(this.sourceIds.lines, { type: 'geojson', data: tracksData });
        map.addLayer({
            id: this.layerIds.lines,
            source: this.sourceIds.lines,
            type: 'line',
            paint: {
                'line-color': lineColor,
                'line-width': lineWidth,
                'line-opacity': 0,
            },
        });

        const emptyFC = { type: 'FeatureCollection', features: [] };

        if (this.cellsEnabled) {
            map.addSource(this.sourceIds.cells, { type: 'geojson', data: emptyFC });
            map.addLayer({
                id: this.layerIds.cellFill,
                source: this.sourceIds.cells,
                type: 'fill',
                paint: {
                    'fill-color': this.paint['fill-color'] || circleColor,
                    'fill-opacity': hex_opacity,
                },
            });
            map.addLayer({
                id: this.layerIds.cellLine,
                source: this.sourceIds.cells,
                type: 'line',
                paint: {
                    'line-color': this.paint['fill-outline-color'] || '#333333',
                    'line-width': 1,
                },
            });
        }

        map.addSource(this.sourceIds.dots, { type: 'geojson', data: emptyFC });
        map.addLayer({
            id: this.layerIds.dots,
            source: this.sourceIds.dots,
            type: 'circle',
            paint: {
                'circle-radius': dot_radius,
                'circle-color': circleColor,
                'circle-stroke-width': 2,
                'circle-stroke-color': circleStroke,
            },
        });

        if (show_labels) {
            map.addSource(this.sourceIds.labels, { type: 'geojson', data: emptyFC });
            map.addLayer({
                id: this.layerIds.labels,
                source: this.sourceIds.labels,
                type: 'symbol',
                layout: {
                    'text-field': ['get', id_field],
                    'text-size': 11,
                    'text-offset': [0, 1.4],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                },
                paint: {
                    'text-color': '#222',
                    'text-halo-color': '#ffffff',
                    'text-halo-width': 1,
                },
            });
        }
    }

    _buildControls() {
        const panel = document.createElement('div');
        panel.className = 'anim-controls';
        panel.dataset.layerId = this.layerId;
        const modeSelect = this.config.mode_toggle ? `
            <select class="anim-mode" title="Playback mode">
                <option value="stepped">${MODE_LABELS.stepped}</option>
                <option value="smooth">${MODE_LABELS.smooth}</option>
            </select>` : '';
        panel.innerHTML = `
            <span class="anim-label" title="${this.displayName}">${this.displayName}</span>
            <button class="anim-play" title="Play / Pause">❚❚</button>
            <span class="anim-time"></span>
            ${modeSelect}
            <select class="anim-speed" title="Speed">
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
            </select>
        `;
        // Stack multiple panels vertically — count reactive-control sliders too
        // so the two panel types never render on top of each other.
        const existing = document.querySelectorAll('.anim-controls, .reactive-controls').length;
        panel.style.bottom = (12 + existing * 44) + 'px';
        document.body.appendChild(panel);

        this._panel = panel;
        this._playBtn = panel.querySelector('.anim-play');
        this._timeEl = panel.querySelector('.anim-time');
        this._speedEl = panel.querySelector('.anim-speed');
        this._modeEl = panel.querySelector('.anim-mode');

        this._playBtn.addEventListener('click', () => {
            this.playing = !this.playing;
            this._playBtn.textContent = this.playing ? '❚❚' : '▶';
            if (this.playing) this.lastFrame = null;
        });
        this._speedEl.addEventListener('change', () => {
            this.speed = Number(this._speedEl.value) || 1;
        });
        if (this._modeEl) {
            this._modeEl.value = this.mode;
            this._modeEl.addEventListener('change', () => {
                this.setMode(this._modeEl.value);
            });
        }
    }

    /** Switch playback mode ('smooth' | 'stepped') at runtime. */
    setMode(mode) {
        const next = mode === 'stepped' ? 'stepped' : 'smooth';
        if (next === this.mode) return;
        this.mode = next;
        if (this._modeEl) this._modeEl.value = next;
        this._applyMode();
        this._renderFrame();
    }

    /**
     * Per-mode sublayer visibility. The track line only makes sense in smooth
     * mode (it is the interpolation made explicit); cells replace dots in
     * stepped mode when the observations are gridded.
     */
    _layerVisible(key) {
        const smooth = this.mode === 'smooth';
        if (key === 'lines') return smooth && this.config.show_track_line;
        if (key === 'cellFill' || key === 'cellLine') return !smooth;
        if (key === 'dots') return smooth || !this.cellsEnabled;
        return true;   // labels
    }

    _applyMode() {
        const map = this.map;
        if (map.getLayer(this.layerIds.lines)) {
            map.setPaintProperty(
                this.layerIds.lines, 'line-opacity',
                this._layerVisible('lines') ? this.config.track_line_opacity : 0,
            );
        }
        for (const key of ['cellFill', 'cellLine', 'dots']) {
            const id = this.layerIds[key];
            if (!map.getLayer(id)) continue;
            const on = this.visible && this._layerVisible(key);
            map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        }
    }

    _tick(now) {
        if (this.destroyed) return;
        if (this.visible && this.playing && this.lastFrame !== null) {
            const delta = now - this.lastFrame;
            const durationMs = this.config.duration_seconds * 1000;
            const timeRange = Math.max(1, this.globalEnd - this.globalStart);
            this.animTime += (delta / durationMs) * timeRange * this.speed;
            if (this.animTime > this.globalEnd) {
                this.animTime = this.config.loop ? this.globalStart : this.globalEnd;
                if (!this.config.loop) this.playing = false;
            }
        }
        this.lastFrame = now;

        if (this.visible) this._renderFrame();
        this.rafId = requestAnimationFrame(this._tick);
    }

    _renderFrame() {
        const { points, cells } = this._buildFrame(this.animTime);
        const dotsSrc = this.map.getSource(this.sourceIds.dots);
        if (dotsSrc) dotsSrc.setData(points);
        const cellsSrc = this.map.getSource(this.sourceIds.cells);
        if (cellsSrc) cellsSrc.setData(cells);
        if (this.config.show_labels) {
            const labelsSrc = this.map.getSource(this.sourceIds.labels);
            if (labelsSrc) labelsSrc.setData(points);
        }
        if (this._timeEl) this._timeEl.textContent = this._formatTime(this.animTime);
    }

    /**
     * Build the frame at `time`: a point FeatureCollection (dots and labels)
     * and, in stepped mode with gridded data, the matching cell footprints.
     */
    _buildFrame(time) {
        const { id_field, hex_resolution } = this.config;
        const stepped = this.mode === 'stepped';
        const holdMs = this._holdMs();
        const points = [];
        const cells = [];
        for (const id of this.allEntities) {
            if (this.allowedIds && !this.allowedIds.has(id)) continue;
            let pos;
            const track = this.tracksByEntity.get(id);
            if (track) {
                pos = sampleTrack(track, time, { stepped, holdMs });
            } else {
                // Entities known only from the static-positions asset don't
                // move, so there is nothing to interpolate or to blink out.
                pos = this.staticPositions.get(id);
            }
            if (!pos) continue;
            const props = { ...this.propsByEntity.get(id), [id_field]: id };
            points.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: pos },
                properties: props,
            });
            if (stepped && this.cellsEnabled) {
                const ring = cellBoundary(pos, hex_resolution);
                if (ring) {
                    cells.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [ring] },
                        properties: props,
                    });
                }
            }
        }
        return {
            points: { type: 'FeatureCollection', features: points },
            cells: { type: 'FeatureCollection', features: cells },
        };
    }

    _formatTime(epochMs) {
        if (!isFinite(epochMs) || this.globalEnd === 1) return '';
        const d = new Date(epochMs);
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    }

    // ---- Lifecycle ----

    setVisible(visible) {
        this.visible = visible;
        for (const [key, id] of Object.entries(this.layerIds)) {
            if (!this.map.getLayer(id)) continue;
            const on = visible && this._layerVisible(key);
            // The track line is hidden by opacity (see _addLayers), so its
            // `visibility` only tracks the layer as a whole.
            const vis = (key === 'lines' ? visible : on) ? 'visible' : 'none';
            this.map.setLayoutProperty(id, 'visibility', vis);
        }
        this._applyMode();
        if (this._panel) this._panel.style.display = visible ? '' : 'none';
        if (visible) this.lastFrame = null;
    }

    /**
     * Apply a filter expression to the animated layers. The track-lines
     * sublayer gets the filter directly (MapLibre handles it). For
     * setData-driven dots/cells/labels we derive the set of entity IDs that
     * pass the filter by querying the tracks source with MapLibre's own
     * expression evaluator — no JS re-implementation of filter semantics.
     */
    setFilter(expr) {
        this.filterExpr = expr;
        if (this.map.getLayer(this.layerIds.lines)) {
            this.map.setFilter(this.layerIds.lines, expr);
        }
        if (!expr) {
            this.allowedIds = null;
            return;
        }
        this.allowedIds = new Set();
        const { id_field } = this.config;
        const matched = this.map.getSource(this.sourceIds.lines)
            ? this.map.querySourceFeatures(this.sourceIds.lines, { filter: expr })
            : [];
        for (const f of matched) {
            const id = f.properties?.[id_field];
            if (id != null) this.allowedIds.add(id);
        }
        // No source features to evaluate against (source not yet tiled, or the
        // layer is hidden) — fall back to reading the filter ourselves.
        if (this.allowedIds.size === 0) this._fallbackFilterIds(expr);
    }

    _fallbackFilterIds(expr) {
        // Handles ["==", ["get", field], val], legacy ["==", field, val],
        // and ["match", ["get", field], [vals], true, false] — the forms the
        // agent's set_filter tool actually emits. Unknown shapes → permissive.
        const { id_field } = this.config;
        const getField = (e) => Array.isArray(e) && e[0] === 'get' ? e[1] : e;
        if (!Array.isArray(expr)) { this.allowedIds = null; return; }
        const [op, a, ...rest] = expr;
        if ((op === '==' || op === '!=') && getField(a) === id_field) {
            for (const id of this.allEntities) {
                const hit = op === '==' ? id == rest[0] : id != rest[0];
                if (hit) this.allowedIds.add(id);
            }
            return;
        }
        if (op === 'match' && getField(a) === id_field && Array.isArray(rest[0])) {
            const values = new Set(rest[0]);
            for (const id of this.allEntities) {
                if (values.has(id)) this.allowedIds.add(id);
            }
            return;
        }
        this.allowedIds = null;
    }

    destroy() {
        this.destroyed = true;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        for (const id of Object.values(this.layerIds)) {
            if (this.map.getLayer(id)) this.map.removeLayer(id);
        }
        for (const id of Object.values(this.sourceIds)) {
            if (this.map.getSource(id)) this.map.removeSource(id);
        }
        if (this._panel) this._panel.remove();
    }
}

// ---- helpers ----

/**
 * The feature's scalar properties, carried onto every frame feature so paint
 * expressions can style by any attribute (pack, agency, species…) and not just
 * `id_field`. Arrays and objects are dropped — that's where the per-waypoint
 * timestamp arrays live, and copying them onto each frame would be dead weight.
 */
function scalarProps(props) {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || typeof v !== 'object') out[k] = v;
    }
    return out;
}

function _ringCentroid(ring) {
    const n = ring.length - 1;   // skip closing vertex
    let lon = 0, lat = 0;
    for (let i = 0; i < n; i++) { lon += ring[i][0]; lat += ring[i][1]; }
    return [lon / n, lat / n];
}

function lerp(a, b, t) {
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * Position of a track at `time`. Pure, and exported for tests.
 *
 * Smooth mode interpolates between waypoints and therefore always returns a
 * position inside the track's time range. Stepped mode returns the waypoint
 * that was actually being reported at `time` — the last one whose observation
 * window (its own timestamp through `endTimes`, plus `holdMs`) covers `time` —
 * and `null` in the gaps between windows, so nothing is drawn for a period
 * with no observation.
 *
 * @param {{coords: Array, times: Array, endTimes: ?Array}} track
 * @param {number} time — epoch ms
 * @param {{stepped?: boolean, holdMs?: number}} [opts]
 * @returns {?Array} [lon, lat], or null when there is nothing to show
 */
export function sampleTrack(track, time, opts = {}) {
    const { coords, times, endTimes } = track;
    if (!coords?.length) return null;
    if (opts.stepped) {
        const holdMs = opts.holdMs || 0;
        for (let i = times.length - 1; i >= 0; i--) {
            if (time < times[i]) continue;
            const until = (endTimes ? endTimes[i] : times[i]) + holdMs;
            return time <= until ? coords[i] : null;
        }
        return null;
    }
    return interpolate(track, time);
}

function interpolate(track, time) {
    const { coords, times } = track;
    if (time <= times[0]) return coords[0];
    if (time >= times[times.length - 1]) return coords[coords.length - 1];
    // Binary search would be faster for very long tracks; linear is fine here.
    for (let i = 0; i < times.length - 1; i++) {
        if (time >= times[i] && time < times[i + 1]) {
            const frac = (time - times[i]) / (times[i + 1] - times[i]);
            return lerp(coords[i], coords[i + 1], frac);
        }
    }
    return coords[coords.length - 1];
}

/**
 * Closed [lon, lat] ring of the H3 cell containing `pos` — the footprint the
 * observation actually represents. Returns null if h3-js isn't loaded.
 */
export function cellBoundary(pos, resolution, h3lib) {
    const lib = h3lib || (typeof h3 !== 'undefined' ? h3 : null);
    if (!lib || resolution == null) return null;
    const cell = lib.latLngToCell(pos[1], pos[0], resolution);
    const ring = lib.cellToBoundary(cell, true);   // [lng, lat]
    return [...ring, ring[0]];
}
