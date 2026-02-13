/**
 * H3DynamicLayer for MapLibre GL JS
 * 
 * Dynamically generates H3 hexagons based on the current map viewport and zoom level.
 * Features:
 * - Adaptive Resolution: Automatically switches H3 resolution based on zoom.
 * - Global Coverage: Handles the entire globe, including Res 0 base cells.
 * - Dateline Wrapping: Handles 180th meridian crossing seamlessly.
 * - Performance: Debounced updates and client-side generation.
 * 
 * Usage:
 *   const h3Layer = new H3DynamicLayer(map);
 *   h3Layer.start();
 */
export class H3DynamicLayer {
    constructor(map, options = {}) {
        this.map = map;
        this.sourceId = options.sourceId || 'h3-dynamic';
        this.fillLayerId = options.fillLayerId || 'h3-fill';
        this.outlineLayerId = options.outlineLayerId || 'h3-outline';

        // Default Styles (h3geo.org style)
        this.fillColor = options.fillColor || '#007cbf';
        this.fillOpacity = options.fillOpacity !== undefined ? options.fillOpacity : 0.1;
        this.outlineColor = options.outlineColor || '#000000';
        this.outlineWidth = options.outlineWidth || 1;
        this.outlineOpacity = options.outlineOpacity !== undefined ? options.outlineOpacity : 0.8;

        this.minZoom = options.minZoom || 0;
        this.maxZoom = options.maxZoom || 24;

        this._debouncedUpdate = this._debounce(this.updateHexagons.bind(this), 50);
        this._updateHandler = this._debouncedUpdate;
        this._zoomHandler = this.updateHexagons.bind(this);
    }

    start() {
        if (!this.map) return;

        // Add Source
        if (!this.map.getSource(this.sourceId)) {
            this.map.addSource(this.sourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }

        // Add Layers
        if (!this.map.getLayer(this.fillLayerId)) {
            this.map.addLayer({
                id: this.fillLayerId,
                type: 'fill',
                source: this.sourceId,
                paint: {
                    'fill-color': this.fillColor,
                    'fill-opacity': this.fillOpacity,
                    'fill-outline-color': 'rgba(0,0,0,0)' // No outline on fill layer to avoid artifacts
                }
            });
        }

        if (!this.map.getLayer(this.outlineLayerId)) {
            this.map.addLayer({
                id: this.outlineLayerId,
                type: 'line',
                source: this.sourceId,
                paint: {
                    'line-color': this.outlineColor,
                    'line-width': this.outlineWidth,
                    'line-opacity': this.outlineOpacity
                }
            });
        }

        // Add Events
        this.map.on('moveend', this._updateHandler);
        this.map.on('zoomend', this._zoomHandler); // Immediate update on zoom end

        // Initial Update
        this.updateHexagons();
    }

    stop() {
        if (!this.map) return;
        this.map.off('moveend', this._updateHandler);
        this.map.off('zoomend', this._zoomHandler);

        if (this.map.getLayer(this.fillLayerId)) this.map.removeLayer(this.fillLayerId);
        if (this.map.getLayer(this.outlineLayerId)) this.map.removeLayer(this.outlineLayerId);
        if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
    }

    updateHexagons() {
        if (!this.map || !this.map.getSource(this.sourceId)) return;

        const zoom = this.map.getZoom();
        const res = this._getResolutionForZoom(zoom);
        const bounds = this.map.getBounds();

        // Get bounds
        let north = bounds.getNorth();
        let south = bounds.getSouth();
        let west = bounds.getWest();
        let east = bounds.getEast();

        // Clamp latitude
        if (north > 90) north = 90;
        if (south < -90) south = -90;

        let allH3Indices = new Set();

        try {
            // Special case for Res 0 global view
            if (res === 0) {
                const cells = h3.getRes0Cells();
                cells.forEach(c => allH3Indices.add(c));
            } else {
                // Normalize longitudes to [-180, 180] handling
                let wNorm = west;
                let eNorm = east;

                // Normalize logic
                while (wNorm < -180) wNorm += 360;
                while (wNorm > 180) wNorm -= 360;
                while (eNorm < -180) eNorm += 360;
                while (eNorm > 180) eNorm -= 360;

                const polygons = [];
                // Check if crossing IDL (West > East)
                if (wNorm > eNorm) {
                    // Split into two polygons
                    polygons.push([
                        [north, wNorm], [north, 180], [south, 180], [south, wNorm], [north, wNorm]
                    ]);
                    polygons.push([
                        [north, -180], [north, eNorm], [south, eNorm], [south, -180], [north, -180]
                    ]);
                } else {
                    polygons.push([
                        [north, wNorm], [north, eNorm], [south, eNorm], [south, wNorm], [north, wNorm]
                    ]);
                }

                polygons.forEach(poly => {
                    // isGeoJson=false => expects [lat, lng]
                    const cells = h3.polygonToCells(poly, res, false);
                    cells.forEach(c => allH3Indices.add(c));
                });
            }

            const features = [];

            allH3Indices.forEach(h3Index => {
                const boundary = h3.cellToBoundary(h3Index, true); // [lng, lat]

                // Check for IDL crossing in boundary
                let crossesIdl = false;
                for (let i = 0; i < boundary.length - 1; i++) {
                    if (Math.abs(boundary[i][0] - boundary[i + 1][0]) > 180) {
                        crossesIdl = true;
                        break;
                    }
                }

                if (!crossesIdl) {
                    features.push({
                        type: 'Feature',
                        properties: { h3: h3Index, resolution: res },
                        geometry: { type: 'Polygon', coordinates: [boundary] }
                    });
                } else {
                    // Handle crossing: produce two shifted versions
                    // Version 1: Shift negative to positive
                    const boundaryEast = boundary.map(coord => {
                        const lng = coord[0];
                        return [lng < 0 ? lng + 360 : lng, coord[1]];
                    });
                    features.push({
                        type: 'Feature',
                        properties: { h3: h3Index, resolution: res },
                        geometry: { type: 'Polygon', coordinates: [boundaryEast] }
                    });

                    // Version 2: Shift positive to negative
                    const boundaryWest = boundary.map(coord => {
                        const lng = coord[0];
                        return [lng > 0 ? lng - 360 : lng, coord[1]];
                    });
                    features.push({
                        type: 'Feature',
                        properties: { h3: h3Index, resolution: res },
                        geometry: { type: 'Polygon', coordinates: [boundaryWest] }
                    });
                }
            });

            this.map.getSource(this.sourceId).setData({
                type: 'FeatureCollection',
                features: features
            });

            // Dispatch custom event for stats updates if needed
            const event = new CustomEvent('h3update', {
                detail: { zoom, resolution: res, count: features.length }
            });
            window.dispatchEvent(event);

        } catch (error) {
            console.error("H3DynamicLayer Error:", error);
        }
    }

    _getResolutionForZoom(zoom) {
        if (zoom < 2) return 0;
        if (zoom < 3) return 1;
        if (zoom < 5) return 2;
        if (zoom < 6) return 3;
        if (zoom < 8) return 4;
        if (zoom < 9) return 5;
        if (zoom < 11) return 6;
        if (zoom < 12) return 7;
        if (zoom < 13) return 8;
        if (zoom < 14) return 9;
        if (zoom < 15) return 10;
        return Math.min(Math.floor(zoom - 4), 15);
    }

    _debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }
}
