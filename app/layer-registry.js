/**
 * LayerRegistry - Generic layer metadata management system
 * 
 * Provides a centralized registry for map layer metadata including:
 * - Layer identification (keys, display names)
 * - Layer types (raster vs vector)
 * - Filterable properties and their types
 * - MapLibre layer IDs and source layers
 * - UI elements (checkboxes, legends)
 * 
 * Supports loading metadata from:
 * - JSON configuration files
 * - Database queries (e.g., DuckDB schema introspection)
 * - Runtime registration
 */

export class LayerRegistry {
    constructor() {
        this.layers = new Map();
    }

    /**
     * Register a single layer with its metadata
     * @param {string} key - Unique identifier for the layer
     * @param {Object} metadata - Layer metadata
     * @param {string} metadata.displayName - Human-readable name
     * @param {string[]} metadata.layerIds - MapLibre layer IDs (can be multiple for complex layers)
     * @param {string} metadata.checkboxId - ID of the UI checkbox element
     * @param {boolean} metadata.hasLegend - Whether layer has a legend
     * @param {boolean} metadata.isVector - true for vector layers, false for raster
     * @param {string} [metadata.sourceLayer] - Source layer name for vector tiles (required for vector layers)
     * @param {Object} [metadata.filterableProperties] - Properties that can be filtered (for vector layers)
     * @param {Object} [metadata.paintableProperties] - Properties that can be used for styling
     * @param {Object} [metadata.defaultPaint] - Default paint properties
     * @param {string} [metadata.sourceUrl] - PMTiles or data source URL
     * @param {string} [metadata.dataTablePath] - S3/parquet path for corresponding data in DuckDB
     * @param {Object} [metadata.dataTableSchema] - Schema of the data table (for validation)
     */
    register(key, metadata) {
        // Validate required fields
        if (!metadata.displayName) {
            throw new Error(`Layer '${key}' missing displayName`);
        }
        if (!metadata.layerIds || metadata.layerIds.length === 0) {
            throw new Error(`Layer '${key}' missing layerIds`);
        }
        if (metadata.isVector && !metadata.sourceLayer) {
            throw new Error(`Vector layer '${key}' missing sourceLayer`);
        }

        this.layers.set(key, {
            key,
            ...metadata
        });

        console.log(`[LayerRegistry] Registered layer: ${key} (${metadata.isVector ? 'vector' : 'raster'})`);
    }

    /**
     * Register multiple layers from a configuration object
     * @param {Object} config - Configuration object with layer definitions
     */
    registerFromConfig(config) {
        for (const [key, metadata] of Object.entries(config.layers || {})) {
            this.register(key, metadata);
        }
    }

    /**
     * Load layer definitions from a JSON file
     * @param {string} url - URL to the JSON configuration file
     */
    async loadFromJson(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch layer config: ${response.statusText}`);
            }
            const config = await response.json();
            this.registerFromConfig(config);
            console.log(`[LayerRegistry] Loaded ${this.layers.size} layers from ${url}`);
        } catch (error) {
            console.error('[LayerRegistry] Failed to load config:', error);
            throw error;
        }
    }

    /**
     * Update layer properties from database schema introspection
     * This allows the system to discover properties dynamically from data sources
     * @param {string} key - Layer key
     * @param {Object} schema - Schema information from database
     * @param {Object[]} schema.columns - Array of column definitions
     * @param {string} schema.columns[].name - Column name
     * @param {string} schema.columns[].type - Column type
     * @param {string} [schema.columns[].description] - Column description
     */
    updateFromSchema(key, schema) {
        const layer = this.layers.get(key);
        if (!layer) {
            console.warn(`[LayerRegistry] Cannot update unknown layer: ${key}`);
            return;
        }

        if (!layer.isVector) {
            console.warn(`[LayerRegistry] Cannot update schema for raster layer: ${key}`);
            return;
        }

        // Build filterable properties from schema
        const filterableProperties = {};
        for (const column of schema.columns || []) {
            filterableProperties[column.name] = {
                type: this.mapDbTypeToJsonType(column.type),
                description: column.description || `Column: ${column.name}`
            };
        }

        layer.filterableProperties = filterableProperties;
        layer.dataTableSchema = schema;

        console.log(`[LayerRegistry] Updated ${key} with ${Object.keys(filterableProperties).length} properties from schema`);
    }

    /**
     * Map database types to JSON schema types
     * @param {string} dbType - Database type (e.g., 'INTEGER', 'VARCHAR', 'BOOLEAN')
     * @returns {string} - JSON type ('string', 'number', 'boolean', 'object', 'array')
     */
    mapDbTypeToJsonType(dbType) {
        const type = dbType.toUpperCase();
        if (type.includes('INT') || type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('DECIMAL') || type.includes('NUMERIC')) {
            return 'number';
        }
        if (type.includes('BOOL')) {
            return 'boolean';
        }
        if (type.includes('ARRAY') || type.includes('LIST')) {
            return 'array';
        }
        if (type.includes('STRUCT') || type.includes('MAP')) {
            return 'object';
        }
        return 'string'; // Default to string for VARCHAR, TEXT, etc.
    }

    /**
     * Get layer metadata by key
     * @param {string} key - Layer key
     * @returns {Object|null} - Layer metadata or null if not found
     */
    get(key) {
        return this.layers.get(key) || null;
    }

    /**
     * Get all registered layer keys
     * @returns {string[]} - Array of layer keys
     */
    getKeys() {
        return Array.from(this.layers.keys());
    }

    /**
     * Get all vector layer keys
     * @returns {string[]} - Array of vector layer keys
     */
    getVectorKeys() {
        return this.getKeys().filter(key => this.get(key).isVector);
    }

    /**
     * Get all raster layer keys
     * @returns {string[]} - Array of raster layer keys
     */
    getRasterKeys() {
        return this.getKeys().filter(key => !this.get(key).isVector);
    }

    /**
     * Check if a layer exists
     * @param {string} key - Layer key
     * @returns {boolean} - True if layer is registered
     */
    has(key) {
        return this.layers.has(key);
    }

    /**
     * Remove a layer from the registry
     * @param {string} key - Layer key
     * @returns {boolean} - True if layer was removed
     */
    unregister(key) {
        const removed = this.layers.delete(key);
        if (removed) {
            console.log(`[LayerRegistry] Unregistered layer: ${key}`);
        }
        return removed;
    }

    /**
     * Get filterable properties for a layer
     * @param {string} key - Layer key
     * @returns {Object|null} - Filterable properties or null if not a vector layer
     */
    getFilterableProperties(key) {
        const layer = this.get(key);
        if (!layer || !layer.isVector) {
            return null;
        }
        return layer.filterableProperties || {};
    }

    /**
     * Get all layer metadata as a plain object (for serialization)
     * @returns {Object} - All layers as an object
     */
    toJSON() {
        const obj = {};
        for (const [key, metadata] of this.layers) {
            obj[key] = metadata;
        }
        return obj;
    }

    /**
     * Get a summary of all registered layers
     * @returns {Object} - Summary with counts and lists
     */
    getSummary() {
        const vectorLayers = this.getVectorKeys();
        const rasterLayers = this.getRasterKeys();

        return {
            total: this.layers.size,
            vector: vectorLayers.length,
            raster: rasterLayers.length,
            vectorLayers,
            rasterLayers,
            allLayers: this.getKeys()
        };
    }

    /**
     * Clear all registered layers
     */
    clear() {
        this.layers.clear();
        console.log('[LayerRegistry] Cleared all layers');
    }
}

// Export a singleton instance
export const layerRegistry = new LayerRegistry();
