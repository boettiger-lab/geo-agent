/**
 * animation-manager.js — Temporal animation layers
 *
 * TrajectoryAnimation: animates points along timestamped LineString
 * trajectories. Each input feature is a LineString with a parallel array
 * of ISO timestamps (one per coordinate). The animation loops the
 * combined time range, interpolating each entity's position linearly
 * between waypoints.
 *
 * Owns three MapLibre sublayers (track-lines, dots, labels) and a small
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

        const safe = this.layerId.replace(/[^a-zA-Z0-9]/g, '-');
        this.sourceIds = {
            lines: `src-${safe}-anim-lines`,
            dots:  `src-${safe}-anim-dots`,
            labels: `src-${safe}-anim-labels`,
        };
        this.layerIds = {
            lines: `layer-${safe}-anim-lines`,
            dots:  `layer-${safe}-anim-dots`,
            labels: `layer-${safe}-anim-labels`,
        };

        this.tracksByEntity = new Map();   // id → { coords, times }
        this.staticPositions = new Map();  // id → [lon, lat]
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
        this._tick = this._tick.bind(this);
        this.rafId = requestAnimationFrame(this._tick);
    }

    _parseTracks(geojson) {
        const { id_field, timestamp_field } = this.config;
        for (const feat of geojson.features || []) {
            if (!feat.geometry || feat.geometry.type !== 'LineString') continue;
            const id = feat.properties?.[id_field];
            const rawTimes = feat.properties?.[timestamp_field];
            if (id == null || !Array.isArray(rawTimes)) continue;
            const coords = feat.geometry.coordinates;
            const times = rawTimes.map(t => new Date(t).getTime());
            if (coords.length !== times.length || coords.length < 2) continue;
            this.tracksByEntity.set(id, { coords, times });
            this.globalStart = Math.min(this.globalStart, times[0]);
            this.globalEnd   = Math.max(this.globalEnd, times[times.length - 1]);
        }
    }

    _parseStatic(geojson) {
        const { id_field } = this.config;
        for (const feat of geojson.features || []) {
            const id = feat.properties?.[id_field];
            if (id == null) continue;
            const centroid = this._featureCentroid(feat);
            if (centroid) this.staticPositions.set(id, centroid);
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

    _addLayers(tracksData) {
        const map = this.map;
        const { dot_radius, show_track_line, track_line_opacity, show_labels, id_field } = this.config;
        const lineColor = this.paint['line-color'] || '#1976d2';
        const circleColor = this.paint['circle-color'] || '#1976d2';
        const circleStroke = this.paint['circle-stroke-color'] || '#ffffff';
        const lineWidth = this.paint['line-width'] ?? 2;

        if (show_track_line) {
            map.addSource(this.sourceIds.lines, { type: 'geojson', data: tracksData });
            map.addLayer({
                id: this.layerIds.lines,
                source: this.sourceIds.lines,
                type: 'line',
                paint: {
                    'line-color': lineColor,
                    'line-width': lineWidth,
                    'line-opacity': track_line_opacity,
                },
            });
        }

        const emptyFC = { type: 'FeatureCollection', features: [] };

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
        panel.innerHTML = `
            <span class="anim-label" title="${this.displayName}">${this.displayName}</span>
            <button class="anim-play" title="Play / Pause">❚❚</button>
            <span class="anim-time"></span>
            <select class="anim-speed" title="Speed">
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
            </select>
        `;
        // Stack multiple panels vertically
        const existing = document.querySelectorAll('.anim-controls').length;
        panel.style.bottom = (12 + existing * 44) + 'px';
        document.body.appendChild(panel);

        this._panel = panel;
        this._playBtn = panel.querySelector('.anim-play');
        this._timeEl = panel.querySelector('.anim-time');
        this._speedEl = panel.querySelector('.anim-speed');

        this._playBtn.addEventListener('click', () => {
            this.playing = !this.playing;
            this._playBtn.textContent = this.playing ? '❚❚' : '▶';
            if (this.playing) this.lastFrame = null;
        });
        this._speedEl.addEventListener('change', () => {
            this.speed = Number(this._speedEl.value) || 1;
        });
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
        const fc = this._buildFrame(this.animTime);
        const dotsSrc = this.map.getSource(this.sourceIds.dots);
        if (dotsSrc) dotsSrc.setData(fc);
        if (this.config.show_labels) {
            const labelsSrc = this.map.getSource(this.sourceIds.labels);
            if (labelsSrc) labelsSrc.setData(fc);
        }
        if (this._timeEl) this._timeEl.textContent = this._formatTime(this.animTime);
    }

    _buildFrame(time) {
        const { id_field } = this.config;
        const features = [];
        for (const id of this.allEntities) {
            if (this.allowedIds && !this.allowedIds.has(id)) continue;
            let pos;
            const track = this.tracksByEntity.get(id);
            if (track) {
                pos = interpolate(track, time);
            } else {
                pos = this.staticPositions.get(id);
            }
            if (!pos) continue;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: pos },
                properties: { [id_field]: id },
            });
        }
        return { type: 'FeatureCollection', features };
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
        const vis = visible ? 'visible' : 'none';
        for (const id of Object.values(this.layerIds)) {
            if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
        }
        if (this._panel) this._panel.style.display = visible ? '' : 'none';
        if (visible) this.lastFrame = null;
    }

    /**
     * Apply a filter expression to the animated layers. The track-lines
     * sublayer gets the filter directly (MapLibre handles it). For
     * setData-driven dots/labels we derive the set of entity IDs that
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
        if (!this.map.getSource(this.sourceIds.lines)) {
            // No track-lines source (show_track_line: false) — best-effort:
            // if the filter is a simple equality/in against id_field, honour it.
            this._fallbackFilterIds(expr);
            return;
        }
        const matched = this.map.querySourceFeatures(this.sourceIds.lines, { filter: expr });
        for (const f of matched) {
            const id = f.properties?.[id_field];
            if (id != null) this.allowedIds.add(id);
        }
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

function _ringCentroid(ring) {
    const n = ring.length - 1;   // skip closing vertex
    let lon = 0, lat = 0;
    for (let i = 0; i < n; i++) { lon += ring[i][0]; lat += ring[i][1]; }
    return [lon / n, lat / n];
}

function lerp(a, b, t) {
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
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

