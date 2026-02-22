/**
 * DatasetCatalog - Unified dataset knowledge from STAC
 * 
 * Fetches STAC collections (filtered by app config), and for each collection
 * builds a unified record containing:
 *   - Metadata (title, description, provider, license)
 *   - Parquet/H3 assets (for SQL queries via MCP)
 *   - Visual assets (PMTiles for vector, COG for raster — for map display)
 *   - Schema (table:columns — for filter/style guidance)
 * 
 * The catalog is the single source of truth for "what data exists"
 * and is injected into both the system prompt and the map layer setup.
 */

export class DatasetCatalog {
    constructor() {
        /** @type {Map<string, DatasetEntry>} keyed by collection ID */
        this.datasets = new Map();
        this.catalogUrl = null;
        this.titilerUrl = null;
    }

    /**
     * Load and process STAC collections specified in the app config.
     * 
     * @param {Object} appConfig - Parsed layers-input.json
     * @param {string} appConfig.catalog - STAC catalog URL
     * @param {string} [appConfig.titiler_url] - TiTiler base URL for COGs
     * @param {Array<Object>} appConfig.collections - Collection specs
     */
    async load(appConfig) {
        this.catalogUrl = appConfig.catalog;
        this.titilerUrl = appConfig.titiler_url || 'https://titiler.nrp-nautilus.io';

        console.log('[Catalog] Loading STAC catalog:', this.catalogUrl);

        // Fetch the root catalog to get child links
        const catalog = await this.fetchJson(this.catalogUrl);
        const childLinks = (catalog.links || []).filter(l => l.rel === 'child');

        // Build a map of collection URLs by fetching each child
        // We'll match against the requested collection IDs
        const requestedIds = new Set(appConfig.collections.map(c =>
            typeof c === 'string' ? c : c.collection_id
        ));

        // Build options map from collection specs
        const optionsMap = new Map();
        for (const c of appConfig.collections) {
            if (typeof c === 'object') {
                optionsMap.set(c.collection_id, c);
            }
        }

        console.log(`[Catalog] Looking for ${requestedIds.size} collections: ${[...requestedIds].join(', ')}`);

        // Fetch all child collections in parallel
        const fetchPromises = childLinks.map(async (link) => {
            try {
                const url = new URL(link.href, this.catalogUrl).href;
                const collection = await this.fetchJson(url);
                if (requestedIds.has(collection.id)) {
                    const options = optionsMap.get(collection.id) || {};
                    return this.processCollection(collection, options);
                }
            } catch (error) {
                console.warn(`[Catalog] Failed to fetch child: ${link.href}`, error.message);
            }
            return null;
        });

        const results = await Promise.allSettled(fetchPromises);
        const loaded = results.filter(r => r.status === 'fulfilled' && r.value).length;
        console.log(`[Catalog] Loaded ${loaded}/${requestedIds.size} collections`);

        // Warn about missing collections
        for (const id of requestedIds) {
            if (!this.datasets.has(id)) {
                console.warn(`[Catalog] Collection not found: ${id}`);
            }
        }
    }

    /**
     * Process a single STAC collection into a DatasetEntry.
     */
    processCollection(collection, options = {}) {
        // Build ordered asset config list.
        // Using an array (not a Map) so the same STAC asset can appear multiple times
        // under different aliases — e.g. one PMTiles split into "fee" and "easement" layers
        // via { id: "pmtiles", alias: "fee", ... } and { id: "pmtiles", alias: "easement", ... }.
        let assetConfigList = null;
        if (Array.isArray(options.assets)) {
            assetConfigList = [];
            for (const a of options.assets) {
                if (typeof a === 'string') {
                    assetConfigList.push({ key: a, assetId: a, config: {} });
                } else if (a && a.id) {
                    const key = a.alias || a.id;
                    assetConfigList.push({ key, assetId: a.id, config: a });
                }
            }
        }

        const entry = {
            id: collection.id,
            title: options.display_name || collection.title || collection.id,
            description: collection.description || '',
            license: collection.license || 'N/A',
            keywords: collection.keywords || [],
            provider: this.extractProvider(collection),
            aboutUrl: this.extractAboutUrl(collection),
            documentationUrl: this.extractDocUrl(collection),

            // Schema from table:columns
            columns: this.extractColumns(collection),

            // Visual assets (for map display) — filtered by config
            mapLayers: this.extractMapLayers(collection, options, assetConfigList),

            // Parquet/H3 assets (for SQL via MCP) — always load all
            parquetAssets: this.extractParquetAssets(collection),

            // Raw STAC extent
            extent: collection.extent,
            summaries: collection.summaries || {},
        };

        this.datasets.set(collection.id, entry);
        console.log(`[Catalog] Registered: ${entry.id} (${entry.mapLayers.length} map layers, ${entry.parquetAssets.length} parquet assets)`);
        return entry;
    }

    /**
     * Extract map-displayable assets (PMTiles and COGs).
     * Each becomes a potential map layer.
     *
     * When assetConfigList is provided (filtered mode), iterates the config entries
     * in order — supporting multiple logical layers from one STAC asset via alias.
     * When null, all visual assets from the STAC collection are included.
     *
     * @param {Object} collection - STAC collection
     * @param {Object} options - Collection-level options
     * @param {Array|null} assetConfigList - Ordered list of {key, assetId, config}
     */
    extractMapLayers(collection, options = {}, assetConfigList = null) {
        const layers = [];
        const stacAssets = collection.assets || {};

        if (assetConfigList) {
            // Filtered mode: iterate config entries so aliases and ordering are respected
            for (const { key, assetId, config } of assetConfigList) {
                const asset = stacAssets[assetId];
                if (!asset) continue;

                const type = asset.type || '';

                if (type.includes('pmtiles')) {
                    layers.push({
                        assetId: key,
                        layerType: 'vector',
                        title: config.display_name || asset.title || assetId,
                        url: asset.href,
                        sourceLayer: asset['vector:layers']?.[0] || asset['pmtiles:layer'] || assetId,
                        description: asset.description || '',
                        defaultStyle: config.default_style || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                    });
                } else if (type.includes('geotiff') || type.includes('tiff')) {
                    layers.push({
                        assetId: key,
                        layerType: 'raster',
                        title: config.display_name || asset.title || assetId,
                        cogUrl: asset.href,
                        colormap: config.colormap || options.colormap || 'reds',
                        rescale: config.rescale || options.rescale || null,
                        description: asset.description || '',
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                    });
                }
            }
        } else {
            // Unfiltered mode: include all visual assets from the STAC collection
            for (const [assetId, asset] of Object.entries(stacAssets)) {
                const type = asset.type || '';

                if (type.includes('pmtiles')) {
                    layers.push({
                        assetId,
                        layerType: 'vector',
                        title: asset.title || assetId,
                        url: asset.href,
                        sourceLayer: asset['vector:layers']?.[0] || asset['pmtiles:layer'] || assetId,
                        description: asset.description || '',
                        defaultStyle: null,
                        tooltipFields: null,
                        defaultVisible: false,
                        defaultFilter: null,
                    });
                } else if (type.includes('geotiff') || type.includes('tiff')) {
                    layers.push({
                        assetId,
                        layerType: 'raster',
                        title: asset.title || assetId,
                        cogUrl: asset.href,
                        colormap: options.colormap || 'reds',
                        rescale: options.rescale || null,
                        description: asset.description || '',
                        defaultVisible: false,
                        defaultFilter: null,
                    });
                }
            }
        }

        return layers;
    }

    /**
     * Extract parquet/H3 hex assets for SQL queries.
     * All parquet assets are always loaded (no filtering) so the
     * AI agent / DuckDB can query any available data.
     * @param {Object} collection
     */
    extractParquetAssets(collection) {
        const assets = [];
        const rawAssets = collection.assets || {};

        for (const [assetId, asset] of Object.entries(rawAssets)) {
            const type = asset.type || '';
            const href = asset.href || '';

            if (type.includes('parquet') || href.endsWith('.parquet') || href.endsWith('/hex/') || href.endsWith('/hex//')) {
                // Convert HTTPS URL to S3 path for DuckDB
                let s3Path = href;
                if (href.startsWith('https://s3-west.nrp-nautilus.io/')) {
                    s3Path = href.replace('https://s3-west.nrp-nautilus.io/', 's3://');
                }
                // Add wildcard for partitioned directories
                if (s3Path.endsWith('/') || s3Path.endsWith('//')) {
                    s3Path = s3Path.replace(/\/+$/, '') + '/**';
                }

                assets.push({
                    assetId,
                    title: asset.title || assetId,
                    s3Path,
                    originalUrl: href,
                    isPartitioned: href.endsWith('/') || href.endsWith('//'),
                    description: asset.description || '',
                });
            }
        }

        return assets;
    }

    /**
     * Extract table:columns for schema info.
     */
    extractColumns(collection) {
        const columns = collection['table:columns'] || [];
        return columns
            .filter(col => !['geometry', 'geom'].includes(col.name?.toLowerCase()))
            .map(col => ({
                name: col.name,
                type: col.type || 'string',
                description: col.description || '',
            }));
    }

    extractProvider(collection) {
        const producers = (collection.providers || []).filter(p =>
            (p.roles || []).includes('producer')
        );
        return producers[0]?.name || 'Unknown';
    }

    extractAboutUrl(collection) {
        const about = (collection.links || []).find(l => l.rel === 'about');
        return about?.href || null;
    }

    extractDocUrl(collection) {
        const doc = (collection.links || []).find(l =>
            l.rel === 'describedby' || l.rel === 'documentation'
        );
        return doc?.href || null;
    }

    // ---- Public API ----

    /**
     * Get a dataset entry by collection ID.
     * @param {string} id 
     * @returns {DatasetEntry|null}
     */
    get(id) {
        return this.datasets.get(id) || null;
    }

    /**
     * Get all dataset IDs.
     * @returns {string[]}
     */
    getIds() {
        return [...this.datasets.keys()];
    }

    /**
     * Get all dataset entries.
     * @returns {DatasetEntry[]}
     */
    getAll() {
        return [...this.datasets.values()];
    }

    /**
     * Generate a text summary of all datasets for injection into the LLM system prompt.
     * Includes both SQL (parquet) and map (visual) information.
     */
    generatePromptCatalog() {
        const sections = [];

        for (const ds of this.datasets.values()) {
            let section = `### ${ds.title}\n`;
            section += `**Collection ID:** ${ds.id}\n`;
            section += `**Description:** ${ds.description}\n`;
            section += `**Provider:** ${ds.provider}\n`;

            // Parquet assets for SQL
            if (ds.parquetAssets.length > 0) {
                section += `\n**SQL Data (use with \`query\` tool):**\n`;
                for (const pa of ds.parquetAssets) {
                    section += `- ${pa.title}: \`read_parquet('${pa.s3Path}')\`\n`;
                }
            }

            // Map layers for visualization
            if (ds.mapLayers.length > 0) {
                section += `\n**Map Layers (use with map tools):**\n`;
                for (const ml of ds.mapLayers) {
                    const layerId = `${ds.id}/${ml.assetId}`;
                    section += `- layer_id: \`${layerId}\` — ${ml.title} (${ml.layerType})\n`;
                }
            }

            // Schema
            if (ds.columns.length > 0) {
                const cols = ds.columns
                    .filter(c => !['h0', 'h8', 'h9', 'h10'].includes(c.name))
                    .slice(0, 15); // Limit to most important
                if (cols.length > 0) {
                    section += `\n**Key Columns:**\n`;
                    for (const col of cols) {
                        section += `- \`${col.name}\` (${col.type}): ${col.description}\n`;
                    }
                    // Note H3 columns separately
                    const h3Cols = ds.columns.filter(c => ['h0', 'h8', 'h9', 'h10'].includes(c.name));
                    if (h3Cols.length > 0) {
                        section += `- H3 index columns: ${h3Cols.map(c => c.name).join(', ')}\n`;
                    }
                }
            }

            if (ds.aboutUrl) {
                section += `\n**More info:** ${ds.aboutUrl}\n`;
            }

            sections.push(section);
        }

        return sections.join('\n---\n\n');
    }

    /**
     * Generate a flat list of all map layer IDs and their configs.
     * Used by MapManager to create layers.
     * 
     * @returns {Array<{layerId: string, datasetId: string, config: Object}>}
     */
    getMapLayerConfigs() {
        const configs = [];

        for (const ds of this.datasets.values()) {
            for (const ml of ds.mapLayers) {
                const layerId = `${ds.id}/${ml.assetId}`;

                if (ml.layerType === 'vector') {
                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        displayName: ml.title,
                        type: 'vector',
                        source: {
                            type: 'vector',
                            url: `pmtiles://${ml.url}`,
                        },
                        sourceLayer: ml.sourceLayer,
                        paint: ml.defaultStyle || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 },
                        columns: ds.columns,
                        tooltipFields: ml.tooltipFields || null,
                        defaultVisible: ml.defaultVisible || false,
                        defaultFilter: ml.defaultFilter || null,
                    });
                } else if (ml.layerType === 'raster') {
                    let tilesUrl = `${this.titilerUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(ml.cogUrl)}&colormap_name=${ml.colormap}`;
                    if (ml.rescale) tilesUrl += `&rescale=${ml.rescale}`;

                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        displayName: ml.title,
                        type: 'raster',
                        source: {
                            type: 'raster',
                            tiles: [tilesUrl],
                            tileSize: 256,
                        },
                        paint: { 'raster-opacity': 0.7 },
                        columns: [], // rasters don't have filterable columns
                    });
                }
            }
        }

        return configs;
    }

    // ---- Utilities ----

    async fetchJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        return response.json();
    }
}
