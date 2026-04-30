/**
 * DatasetCatalog - Unified dataset knowledge from STAC
 * 
 * Fetches STAC collections (filtered by app config), and for each collection
 * builds a unified record containing:
 *   - Metadata (title, description, provider, license)
 *   - Parquet/H3 assets (for SQL queries via MCP)
 *   - Visual assets (PMTiles/GeoJSON for vector, COG for raster — for map display)
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
        this.catalogToken = null;
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
        this.appConfig = appConfig;
        this.catalogUrl = appConfig.catalog;
        this.catalogToken = appConfig.catalog_token || null;
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

        // Collections with explicit collection_url are fetched directly — no catalog traversal needed
        const directFetches = appConfig.collections
            .filter(c => typeof c === 'object' && c.collection_url)
            .map(async (c) => {
                try {
                    const collection = await this.fetchJson(c.collection_url);
                    const options = optionsMap.get(c.collection_id) || {};
                    return this.processCollection(collection, options);
                } catch (error) {
                    console.warn(`[Catalog] Failed to fetch direct collection: ${c.collection_url}`, error.message);
                }
                return null;
            });

        // Remaining collections are resolved by scanning the root catalog's child links
        const directIds = new Set(appConfig.collections
            .filter(c => typeof c === 'object' && c.collection_url)
            .map(c => c.collection_id));
        const catalogIds = new Set([...requestedIds].filter(id => !directIds.has(id)));

        // When child links carry an `id` field (see boettiger-lab/data-workflows#105),
        // filter before fetching so we only request the collections we need.
        // Falls back to fetching all children for catalogs without IDs.
        const linksToFetch = childLinks.filter(link =>
            !link.id || catalogIds.has(link.id)
        );

        // Fetch matching child collections in parallel
        const fetchPromises = linksToFetch.map(async (link) => {
            try {
                const url = new URL(link.href, this.catalogUrl).href;
                const collection = await this.fetchJson(url);
                if (catalogIds.has(collection.id)) {
                    const options = optionsMap.get(collection.id) || {};
                    return this.processCollection(collection, options);
                }
            } catch (error) {
                console.warn(`[Catalog] Failed to fetch child: ${link.href}`, error.message);
            }
            return null;
        });

        const results = await Promise.allSettled([...directFetches, ...fetchPromises]);
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
    async processCollection(collection, options = {}) {
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

        // Extract parquet assets and columns from this collection
        let parquetAssets = this.extractParquetAssets(collection);
        let columns = this.extractColumns(collection);

        // One-level child expansion: if this collection has child links,
        // fetch them to find additional parquet/hex assets and column schemas
        // that aren't on the parent (e.g. wyoming-wildlife-lands has per-species
        // sub-collections each with h3-parquet assets). Does NOT recurse further.
        const childLinks = (collection.links || []).filter(l => l.rel === 'child');
        let childIds = [];
        const rawChildren = [];
        if (childLinks.length > 0) {
            const childResults = await Promise.allSettled(
                childLinks.map(async (link) => {
                    try {
                        const url = new URL(link.href, this.catalogUrl).href;
                        return await this.fetchJson(url);
                    } catch (e) {
                        console.warn(`[Catalog] Failed to fetch sub-collection: ${link.href}`, e.message);
                        return null;
                    }
                })
            );
            for (const r of childResults) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const child = r.value;
                rawChildren.push(child);
                if (child.id) childIds.push(child.id);
                const childParquet = this.extractParquetAssets(child);
                if (childParquet.length > 0) {
                    parquetAssets = parquetAssets.concat(childParquet);
                }
                // Use child columns if parent has none
                if (columns.length === 0) {
                    columns = this.extractColumns(child);
                }
            }
        }

        const rawGroup = options.group || null;
        const groupName = rawGroup && typeof rawGroup === 'object' ? rawGroup.name : rawGroup;
        const groupCollapsed = rawGroup && typeof rawGroup === 'object' ? rawGroup.collapsed === true : false;

        const entry = {
            id: collection.id,
            group: groupName,
            groupCollapsed,
            title: options.display_name || collection.title || collection.id,
            description: collection.description || '',
            license: collection.license || 'N/A',
            keywords: collection.keywords || [],
            provider: this.extractProvider(collection),
            aboutUrl: this.extractAboutUrl(collection),
            documentationUrl: this.extractDocUrl(collection),

            // Schema from table:columns
            columns,

            // Child collection IDs (for parent container detection)
            childIds,

            // Whether to inject full schema into the prompt catalog
            preload: options.preload === true,

            // Visual assets (for map display) — filtered by config
            mapLayers: this.extractMapLayers(collection, options, assetConfigList),

            // Parquet/H3 assets (for SQL via MCP) — always load all
            parquetAssets,

            // Raw STAC extent
            extent: collection.extent,
            summaries: collection.summaries || {},

            // Raw STAC kept for inline forwarding to MCP (avoids a re-fetch).
            _rawStac: collection,
            _rawChildren: rawChildren.length > 0 ? rawChildren : null,
        };

        this.datasets.set(collection.id, entry);
        console.log(`[Catalog] Registered: ${entry.id} (${entry.mapLayers.length} map layers, ${entry.parquetAssets.length} parquet assets)`);
        return entry;
    }

    /**
     * Extract map-displayable assets (PMTiles, GeoJSON, and COGs).
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

                // Asset-level group is always a plain string (group reassignment).
                // Tolerate object form { name } for robustness, but ignore collapsed
                // — collapsed is a group-level concern, set on the collection's group.
                const rawAssetGroup = config.group || null;
                const assetGroup = rawAssetGroup && typeof rawAssetGroup === 'object'
                    ? rawAssetGroup.name : rawAssetGroup;

                // ── Versioned asset: multiple STAC assets behind one logical layer ──
                if (config.versions && Array.isArray(config.versions)) {
                    const versions = [];
                    for (const v of config.versions) {
                        const vAsset = stacAssets[v.asset_id];
                        if (!vAsset) continue;
                        const vType = vAsset.type || '';
                        if (vType.includes('pmtiles')) {
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'vector',
                                url: vAsset.href,
                                sourceLayer: vAsset['vector:layers']?.[0] || vAsset['pmtiles:layer'] || v.asset_id,
                                description: vAsset.description || '',
                            });
                        } else if (vType.includes('geotiff') || vType.includes('tiff')) {
                            const band0 = vAsset['raster:bands']?.[0];
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'raster',
                                cogUrl: vAsset.href,
                                legendClasses: band0?.['classification:classes'] || null,
                                nodata: config.nodata ?? band0?.nodata ?? null,
                                description: vAsset.description || '',
                            });
                        } else if (vType.includes('geo+json') || vAsset.href?.endsWith('.geojson')) {
                            versions.push({
                                label: v.label,
                                assetId: v.asset_id,
                                layerType: 'vector',
                                sourceType: 'geojson',
                                url: vAsset.href,
                                description: vAsset.description || '',
                            });
                        }
                    }
                    if (versions.length === 0) continue;

                    // Resolve default version index
                    const defaultLabel = config.default_version;
                    let defaultIndex = defaultLabel
                        ? versions.findIndex(v => v.label === defaultLabel)
                        : -1;
                    if (defaultIndex < 0) defaultIndex = 0;

                    // All versions must share a layer type (vector or raster)
                    const layerType = versions[0].layerType;

                    layers.push({
                        assetId: key,
                        layerType,
                        group: assetGroup,
                        title: config.display_name || collection.title || key,
                        description: versions[defaultIndex].description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        colormap: config.colormap || options.colormap || 'reds',
                        rescale: config.rescale || options.rescale || null,
                        paint: config.paint || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || null,
                        // Versioned metadata
                        versions,
                        defaultVersionIndex: defaultIndex,
                    });
                    continue;
                }

                // ── Standard (non-versioned) asset ──
                const asset = stacAssets[assetId];
                if (!asset) continue;

                const type = asset.type || '';

                if (type.includes('pmtiles')) {
                    layers.push({
                        assetId: key,
                        sourceAssetId: assetId,  // original STAC key — used to share one MapLibre source across aliases
                        layerType: 'vector',
                        group: assetGroup,
                        title: config.display_name || asset.title || assetId,
                        url: asset.href,
                        sourceLayer: asset['vector:layers']?.[0] || asset['pmtiles:layer'] || assetId,
                        description: asset.description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                    });
                } else if (type.includes('geotiff') || type.includes('tiff')) {
                    const band0 = asset['raster:bands']?.[0];
                    layers.push({
                        assetId: key,
                        layerType: 'raster',
                        group: assetGroup,
                        title: config.display_name || asset.title || assetId,
                        cogUrl: asset.href,
                        colormap: config.colormap || options.colormap || 'reds',
                        rescale: config.rescale || options.rescale || null,
                        paint: config.paint || null,
                        legendLabel: config.legend_label || null,
                        legendType: config.legend_type || null,
                        legendClasses: band0?.['classification:classes'] || null,
                        nodata: config.nodata ?? band0?.nodata ?? null,
                        description: asset.description || '',
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                    });
                } else if (type.includes('geo+json') || asset.href?.endsWith('.geojson')) {
                    // Resolve static_positions_asset reference (another STAC asset
                    // in this same collection) to a URL, so MapManager doesn't
                    // need to know about STAC.
                    let animation = null;
                    if (config.animation && typeof config.animation === 'object') {
                        animation = { ...config.animation };
                        const staticKey = config.animation.static_positions_asset;
                        if (staticKey && stacAssets[staticKey]?.href) {
                            animation.static_positions_url = stacAssets[staticKey].href;
                        }
                    }
                    layers.push({
                        assetId: key,
                        sourceAssetId: assetId,
                        layerType: 'vector',
                        sourceType: 'geojson',
                        group: assetGroup,
                        title: config.display_name || asset.title || assetId,
                        url: asset.href,
                        description: asset.description || '',
                        defaultStyle: config.default_style || null,
                        outlineStyle: config.outline_style || null,
                        renderType: config.layer_type || null,
                        tooltipFields: config.tooltip_fields || null,
                        defaultVisible: config.visible === true,
                        defaultFilter: config.default_filter || null,
                        animation,
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
                } else if (type.includes('geo+json') || asset.href?.endsWith('.geojson')) {
                    layers.push({
                        assetId,
                        layerType: 'vector',
                        sourceType: 'geojson',
                        title: asset.title || assetId,
                        url: asset.href,
                        description: asset.description || '',
                        defaultStyle: null,
                        tooltipFields: null,
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
                ...(col.values?.length ? { values: col.values } : {}),
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
     * Build a STAC collection dict for inline forwarding to MCP.
     *
     * Returns the raw STAC JSON received during load(), with one level of
     * resolved sub-collections embedded as `children: [...]` per the contract
     * in mcp-data-server PR #107. Returns null if the dataset isn't in the
     * catalog.
     *
     * @param {string} id - Collection ID
     * @returns {Object|null}
     */
    toStacDict(id) {
        const ds = this.datasets.get(id);
        if (!ds || !ds._rawStac) return null;
        const out = { ...ds._rawStac };
        if (ds._rawChildren && ds._rawChildren.length > 0) {
            out.children = ds._rawChildren;
        }
        return out;
    }

    /**
     * Generate a text summary of all datasets for injection into the LLM system prompt.
     *
     * Includes paths and map layer IDs — the "table of contents" for the app.
     * Column schemas are NOT included here; the model calls get_schema for those.
     */
    generatePromptCatalog() {
        const preamble = 'The following datasets are pre-loaded for this app. Paths are shown below — use them directly in SQL. Call `get_schema(dataset_id)` before your first SQL query against a dataset to get column names and coded values.\n';
        const sections = [preamble];

        for (const ds of this.datasets.values()) {
            // Parent container: has children but no own columns — render as directory node
            const isParentContainer = ds.columns.length === 0 && ds.childIds.length > 0;
            if (isParentContainer) {
                let section = `### ${ds.title}\n`;
                section += `**Collection ID:** ${ds.id}\n`;
                section += `**Description:** ${ds.description}\n`;
                const listed = ds.childIds.slice(0, 20);
                section += `Sub-datasets — call \`get_stac_details\` with one of these IDs:\n`;
                section += `  ${listed.join(', ')}\n`;
                if (ds.childIds.length > 20) {
                    section += `  (${ds.childIds.length - 20} more — call \`get_stac_details("${ds.id}")\` for the full list)\n`;
                }
                sections.push(section);
                continue;
            }

            let section = `### ${ds.title}\n`;
            section += `**Collection ID:** ${ds.id}\n`;
            section += `**Description:** ${ds.description}\n`;
            section += `**Provider:** ${ds.provider}\n`;

            // SQL assets with actual paths
            section += this._renderSqlPaths(ds);

            // Map layers for visualization
            if (ds.mapLayers.length > 0) {
                section += `\n**Map Layers (use with map tools):**\n`;
                for (const ml of ds.mapLayers) {
                    const layerId = `${ds.id}/${ml.assetId}`;
                    let layerLine = `- layer_id: \`${layerId}\` — ${ml.title} (${ml.layerType})`;
                    if (ml.versions?.length > 1) {
                        const labels = ml.versions.map(v => v.label).join(', ');
                        layerLine += ` [versions: ${labels}]`;
                    }
                    if (ml.defaultFilter) {
                        layerLine += ` [default filter: ${JSON.stringify(ml.defaultFilter)}]`;
                    }
                    section += layerLine + '\n';
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
     * Render SQL asset paths only (no columns) for the system prompt.
     * Uses the client-direct parquetAssets extracted during load().
     * @private
     */
    _renderSqlPaths(ds) {
        if (ds.parquetAssets.length === 0) return '';
        let out = '\n**SQL assets:**\n';
        for (const pa of ds.parquetAssets) {
            out += `- ${pa.title}: \`read_parquet('${pa.s3Path}')\`\n`;
        }
        return out;
    }

    /**
     * Generate a flat list of all map layer IDs and their configs.
     * Used by MapManager to create layers.
     * 
     * @returns {Array<{layerId: string, datasetId: string, config: Object}>}
     */
    getMapLayerConfigs() {
        const configs = [];

        // Iterate in the order specified by appConfig.collections so that
        // layer insertion order on the map matches the user's config order.
        const orderedIds = this.appConfig?.collections
            ? this.appConfig.collections.map(c => typeof c === 'string' ? c : c.collection_id)
            : [...this.datasets.keys()];

        for (const id of orderedIds) {
            const ds = this.datasets.get(id);
            if (!ds) continue;
            for (const ml of ds.mapLayers) {
                const layerId = `${ds.id}/${ml.assetId}`;

                // ── Versioned layer: build per-version configs for MapManager ──
                if (ml.versions && ml.versions.length > 0) {
                    const versionConfigs = ml.versions.map(v => {
                        if (v.layerType === 'vector' && v.sourceType === 'geojson') {
                            const srcKey = v.assetId.replace(/[^a-zA-Z0-9]/g, '-');
                            return {
                                label: v.label,
                                type: 'vector',
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${srcKey}`,
                                source: { type: 'geojson', data: v.url },
                            };
                        } else if (v.layerType === 'vector') {
                            const srcKey = v.assetId.replace(/[^a-zA-Z0-9]/g, '-');
                            return {
                                label: v.label,
                                type: 'vector',
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${srcKey}`,
                                source: { type: 'vector', url: `pmtiles://${v.url}` },
                                sourceLayer: v.sourceLayer,
                            };
                        } else {
                            let tilesUrl = `${this.titilerUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(v.cogUrl)}`;
                            if (ml.legendType === 'categorical' && v.legendClasses?.length) {
                                const cmap = {};
                                for (const cls of v.legendClasses) {
                                    const h = cls['color-hint'] || cls.color_hint;
                                    if (h) cmap[String(cls.value)] = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 255];
                                }
                                tilesUrl += `&colormap=${encodeURIComponent(JSON.stringify(cmap))}`;
                            } else {
                                tilesUrl += `&colormap_name=${ml.colormap || 'reds'}`;
                                if (ml.rescale) tilesUrl += `&rescale=${ml.rescale}`;
                            }
                            if (v.nodata != null) tilesUrl += `&nodata=${encodeURIComponent(v.nodata)}`;
                            return {
                                label: v.label,
                                type: 'raster',
                                sourceId: `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${v.assetId.replace(/[^a-zA-Z0-9]/g, '-')}`,
                                source: { type: 'raster', tiles: [tilesUrl], tileSize: 256 },
                            };
                        }
                    });

                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        displayName: ml.title,
                        type: ml.layerType,
                        paint: ml.defaultStyle || (ml.layerType === 'raster'
                            ? (ml.paint || { 'raster-opacity': 0.7 })
                            : { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 }),
                        outlinePaint: ml.outlineStyle || null,
                        renderType: ml.renderType || null,
                        columns: ds.columns,
                        tooltipFields: ml.tooltipFields || null,
                        defaultVisible: ml.defaultVisible || false,
                        defaultFilter: ml.defaultFilter || null,
                        colormap: ml.colormap || null,
                        rescale: ml.rescale || null,
                        legendLabel: ml.legendLabel || null,
                        legendType: ml.legendType || null,
                        // Versioned metadata
                        versions: versionConfigs,
                        defaultVersionIndex: ml.defaultVersionIndex,
                    });
                    continue;
                }

                // ── Standard (non-versioned) layer ──
                if (ml.layerType === 'vector') {
                    // Use original STAC asset key for source ID so alias layers share one source
                    const sourceAssetKey = (ml.sourceAssetId || ml.assetId).replace(/[^a-zA-Z0-9]/g, '-');
                    const sharedSourceId = `src-${ds.id.replace(/[^a-zA-Z0-9]/g, '-')}-${sourceAssetKey}`;

                    const isGeoJson = ml.sourceType === 'geojson';
                    const layerConfig = {
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        displayName: ml.title,
                        type: 'vector',
                        sourceId: sharedSourceId,
                        source: isGeoJson
                            ? { type: 'geojson', data: ml.url }
                            : { type: 'vector', url: `pmtiles://${ml.url}` },
                        paint: ml.defaultStyle || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 },
                        outlinePaint: ml.outlineStyle || null,
                        renderType: ml.renderType || null,
                        columns: ds.columns,
                        tooltipFields: ml.tooltipFields || null,
                        defaultVisible: ml.defaultVisible || false,
                        defaultFilter: ml.defaultFilter || null,
                        animation: ml.animation || null,
                        tracksUrl: isGeoJson ? ml.url : null,
                    };
                    if (!isGeoJson) layerConfig.sourceLayer = ml.sourceLayer;

                    configs.push(layerConfig);
                } else if (ml.layerType === 'raster') {
                    let tilesUrl = `${this.titilerUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(ml.cogUrl)}`;
                    if (ml.legendType === 'categorical' && ml.legendClasses?.length) {
                        // Build inline colormap JSON from STAC classification:classes color_hint values
                        const colormap = {};
                        for (const cls of ml.legendClasses) {
                            const h = cls['color-hint'] || cls.color_hint;
                            if (h) {
                                colormap[String(cls.value)] = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 255];
                            }
                        }
                        tilesUrl += `&colormap=${encodeURIComponent(JSON.stringify(colormap))}`;
                    } else {
                        tilesUrl += `&colormap_name=${ml.colormap}`;
                        if (ml.rescale) tilesUrl += `&rescale=${ml.rescale}`;
                    }
                    if (ml.nodata != null) tilesUrl += `&nodata=${encodeURIComponent(ml.nodata)}`;

                    configs.push({
                        layerId,
                        datasetId: ds.id,
                        group: ml.group || ds.group,
                        groupCollapsed: ds.groupCollapsed || false,
                        displayName: ml.title,
                        type: 'raster',
                        defaultVisible: ml.defaultVisible || false,
                        colormap: ml.colormap,
                        rescale: ml.rescale,
                        legendLabel: ml.legendLabel,
                        legendType: ml.legendType,
                        legendClasses: ml.legendClasses,
                        source: {
                            type: 'raster',
                            tiles: [tilesUrl],
                            tileSize: 256,
                        },
                        paint: ml.paint || { 'raster-opacity': 0.7 },
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
