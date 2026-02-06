/**
 * MCPToolFactory - Dynamic MCP tool generation from layer metadata
 * 
 * Generates MCP (Model Context Protocol) tool definitions dynamically based on
 * LayerRegistry metadata. This allows the chatbot to control any registered layer
 * without hardcoding tool definitions.
 * 
 * Generated tools include:
 * - toggle_map_layer: Show/hide/toggle layers
 * - get_map_layers: List all available layers
 * - filter_map_layer: Apply filters to vector layers
 * - clear_map_filter: Remove filters
 * - get_layer_filter_info: Query filterable properties
 * - set_layer_paint: Apply data-driven styling
 * - reset_layer_paint: Reset styling to defaults
 * 
 * Tools are generated with:
 * - Dynamic enum values from LayerRegistry
 * - Property-aware descriptions
 * - Type-safe schemas
 */

export class MCPToolFactory {
    constructor(layerRegistry, mapController) {
        this.layerRegistry = layerRegistry;
        this.mapController = mapController;
    }

    /**
     * Generate all MCP tool definitions
     * @returns {Array} - Array of tool definition objects
     */
    generateTools() {
        return [
            this.generateToggleLayerTool(),
            this.generateGetLayersTool(),
            this.generateFilterLayerTool(),
            this.generateClearFilterTool(),
            this.generateGetFilterInfoTool(),
            this.generateSetPaintTool(),
            this.generateResetPaintTool(),
            this.generateSetSpeciesRichnessFilterTool()
        ];
    }

    /**
     * Generate toggle_map_layer tool
     * @returns {Object} - Tool definition
     */
    generateToggleLayerTool() {
        const allLayers = this.layerRegistry.getKeys();
        const layerDescriptions = allLayers.map(key => {
            const layer = this.layerRegistry.get(key);
            return `"${key}" (${layer.displayName})`;
        }).join(', ');

        return {
            name: 'toggle_map_layer',
            description: `Toggle visibility of map overlay layers. Use this to show or hide data layers on the map. Available layers: ${layerDescriptions}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The layer to control. One of: ${allLayers.join(', ')}`,
                        enum: allLayers
                    },
                    action: {
                        type: 'string',
                        description: 'The action to perform: "show" to make visible, "hide" to make invisible, "toggle" to switch current state',
                        enum: ['show', 'hide', 'toggle']
                    }
                },
                required: ['layer', 'action']
            },
            execute: (args) => {
                let result;
                if (args.action === 'toggle') {
                    result = this.mapController.toggleLayer(args.layer);
                } else {
                    const visible = args.action === 'show';
                    result = this.mapController.setLayerVisibility(args.layer, visible);
                }
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Generate get_map_layers tool
     * @returns {Object} - Tool definition
     */
    generateGetLayersTool() {
        return {
            name: 'get_map_layers',
            description: 'Get a list of all available map layers and their current visibility status. Use this to check what layers exist and which are currently shown.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const layers = this.mapController.getAvailableLayers();
                return JSON.stringify({ success: true, layers: layers });
            }
        };
    }

    /**
     * Generate filter_map_layer tool
     * @returns {Object} - Tool definition
     */
    generateFilterLayerTool() {
        const vectorLayers = this.layerRegistry.getVectorKeys();

        // Build property documentation for each vector layer
        const propertyDocs = vectorLayers.map(key => {
            const layer = this.layerRegistry.get(key);
            const props = layer.filterableProperties || {};
            const propNames = Object.keys(props).slice(0, 10); // Show first 10
            return `${key}: ${propNames.join(', ')}${Object.keys(props).length > 10 ? '...' : ''}`;
        }).join('\n');

        return {
            name: 'filter_map_layer',
            description: `Apply a filter to a vector map layer to show only features matching certain criteria. Only works on vector layers: ${vectorLayers.map(k => this.layerRegistry.get(k).displayName).join(', ')}.

The filter must be a valid MapLibre filter expression array. Common patterns:
- Equality: ["==", "property_name", "value"]
- Not equal: ["!=", "property_name", "value"]
- In list: ["in", "property_name", "val1", "val2", "val3"]
- Comparison: [">=", "property_name", 1000] or ["<", "property_name", 500]
- AND: ["all", ["==", "prop1", "val1"], ["==", "prop2", true]]
- OR: ["any", ["==", "prop1", "val1"], ["==", "prop1", "val2"]]

Available properties by layer:
${propertyDocs}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The vector layer to filter. One of: ${vectorLayers.join(', ')}`,
                        enum: vectorLayers
                    },
                    filter: {
                        type: 'array',
                        description: 'MapLibre filter expression array. Examples: ["==", "property", "value"], ["in", "property", "val1", "val2"], ["all", ["==", "prop1", true], [">=", "prop2", 100]]'
                    }
                },
                required: ['layer', 'filter']
            },
            execute: (args) => {
                const result = this.mapController.setLayerFilter(args.layer, args.filter);
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Generate clear_map_filter tool
     * @returns {Object} - Tool definition
     */
    generateClearFilterTool() {
        const vectorLayers = this.layerRegistry.getVectorKeys();

        return {
            name: 'clear_map_filter',
            description: 'Remove any active filter from a vector map layer, showing all features again. Use this to reset a layer after filtering.',
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The vector layer to clear filter from. One of: ${vectorLayers.join(', ')}`,
                        enum: vectorLayers
                    }
                },
                required: ['layer']
            },
            execute: (args) => {
                const result = this.mapController.clearLayerFilter(args.layer);
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Generate get_layer_filter_info tool
     * @returns {Object} - Tool definition
     */
    generateGetFilterInfoTool() {
        const vectorLayers = this.layerRegistry.getVectorKeys();

        return {
            name: 'get_layer_filter_info',
            description: 'Get information about what properties can be filtered on a vector layer, and the current active filter if any. Use this to understand what filter options are available.',
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The vector layer to get filter info for. One of: ${vectorLayers.join(', ')}`,
                        enum: vectorLayers
                    }
                },
                required: ['layer']
            },
            execute: (args) => {
                const propsResult = this.mapController.getFilterableProperties(args.layer);
                const filterResult = this.mapController.getLayerFilter(args.layer);
                return JSON.stringify({
                    success: true,
                    layer: args.layer,
                    filterableProperties: propsResult.properties,
                    currentFilter: filterResult.filter,
                    currentFilterDescription: filterResult.description
                });
            }
        };
    }

    /**
     * Generate set_layer_paint tool
     * @returns {Object} - Tool definition
     */
    generateSetPaintTool() {
        const vectorLayers = this.layerRegistry.getVectorKeys();

        // Build property suggestions for each layer
        const propertySuggestions = vectorLayers.map(key => {
            const layer = this.layerRegistry.get(key);
            const props = layer.filterableProperties || {};
            const categoricalProps = Object.entries(props)
                .filter(([_, meta]) => meta.type === 'string' || meta.values)
                .map(([name, _]) => name)
                .slice(0, 5);
            const numericProps = Object.entries(props)
                .filter(([_, meta]) => meta.type === 'number')
                .map(([name, _]) => name)
                .slice(0, 3);

            return `${key}: Categorical properties: ${categoricalProps.join(', ') || 'none'}; Numeric properties: ${numericProps.join(', ') || 'none'}`;
        }).join('\n');

        return {
            name: 'set_layer_paint',
            description: `Set paint properties on a vector map layer to color features based on data attributes. Only works on vector layers: ${vectorLayers.map(k => this.layerRegistry.get(k).displayName).join(', ')}.

Use this to create data-driven styling, such as coloring polygons by category. The paint property must be a valid MapLibre paint expression.

Common patterns for fill-color:
- Categorical (match): ["match", ["get", "property_name"], "value1", "#color1", "value2", "#color2", "#defaultColor"]
- Stepped (ranges): ["step", ["get", "property_name"], "#color1", threshold1, "#color2", threshold2, "#color3"]
- Interpolated: ["interpolate", ["linear"], ["get", "property_name"], min, "#minColor", max, "#maxColor"]

Useful properties for coloring by layer:
${propertySuggestions}

IMPORTANT: When explaining colors to users, display them as visual legend boxes using HTML:
<span style="background-color: #colorhex; padding: 4px 12px; border-radius: 3px; color: white; font-weight: bold;">label</span>`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The vector layer to style. One of: ${vectorLayers.join(', ')}`,
                        enum: vectorLayers
                    },
                    property: {
                        type: 'string',
                        description: 'The paint property to set. Common values: "fill-color", "fill-opacity", "line-color", "line-width"',
                        enum: ['fill-color', 'fill-opacity', 'line-color', 'line-width']
                    },
                    value: {
                        description: 'The paint value - either a static value (string/number) or a MapLibre expression array for data-driven styling'
                    }
                },
                required: ['layer', 'property', 'value']
            },
            execute: (args) => {
                const result = this.mapController.setLayerPaint(args.layer, args.property, args.value);
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Generate reset_layer_paint tool
     * @returns {Object} - Tool definition
     */
    generateResetPaintTool() {
        const vectorLayers = this.layerRegistry.getVectorKeys();

        return {
            name: 'reset_layer_paint',
            description: 'Reset the paint styling of a vector layer back to its default appearance. Use this to undo any custom coloring applied with set_layer_paint.',
            inputSchema: {
                type: 'object',
                properties: {
                    layer: {
                        type: 'string',
                        description: `The vector layer to reset. One of: ${vectorLayers.join(', ')}`,
                        enum: vectorLayers
                    }
                },
                required: ['layer']
            },
            execute: (args) => {
                const result = this.mapController.resetLayerPaint(args.layer);
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Generate set_species_richness_filter tool
     * @returns {Object} - Tool definition
     */
    generateSetSpeciesRichnessFilterTool() {
        return {
            name: 'set_species_richness_filter',
            description: `Filter the species richness layer to show different taxonomic groups and species types. Use this to switch between viewing all species or only threatened species, and to focus on specific taxonomic groups like mammals, birds, amphibians, reptiles, or freshwater fish.`,
            inputSchema: {
                type: 'object',
                properties: {
                    species_type: {
                        type: 'string',
                        description: 'The type of species to display: "all" shows all species richness, "threatened" shows only threatened and endangered species',
                        enum: ['all', 'threatened']
                    },
                    taxon: {
                        type: 'string',
                        description: 'The taxonomic group to display: "combined" shows all groups together, or choose a specific group',
                        enum: ['combined', 'amphibians', 'birds', 'mammals', 'reptiles', 'fw_fish']
                    }
                },
                required: ['species_type', 'taxon']
            },
            execute: (args) => {
                const result = this.mapController.setSpeciesRichnessFilter(args.species_type, args.taxon);
                return JSON.stringify(result);
            }
        };
    }

    /**
     * Regenerate tools (useful when LayerRegistry changes)
     * @returns {Array} - Updated array of tool definitions
     */
    regenerate() {
        console.log('[MCPToolFactory] Regenerating tools from current LayerRegistry');
        return this.generateTools();
    }

    /**
     * Get a summary of generated tools
     * @returns {Object} - Summary information
     */
    getSummary() {
        const tools = this.generateTools();
        return {
            totalTools: tools.length,
            toolNames: tools.map(t => t.name),
            vectorLayerCount: this.layerRegistry.getVectorKeys().length,
            totalLayerCount: this.layerRegistry.getKeys().length
        };
    }
}
