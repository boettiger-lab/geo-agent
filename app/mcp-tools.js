/**
 * MCP Tools - Simplified generic map control tools
 * 
 * Provides generic tools for affecting map state:
 * - add_layer(layer_id)
 * - remove_layer(layer_id)
 * - update_layer(layer_id, params)
 * - get_layer_info()
 */

export function generateTools(layerRegistry, mapController) {
    const allLayers = layerRegistry.getKeys();
    const vectorLayers = layerRegistry.getVectorKeys();

    // Helper to generate property documentation
    const getLayerPropsDoc = () => {
        return vectorLayers.map(layerId => {
            const props = layerRegistry.getFilterableProperties(layerId);
            if (!props || Object.keys(props).length === 0) return '';

            const propList = Object.entries(props)
                .map(([key, details]) => `  - ${key} (${details.type}): ${details.description}`)
                .join('\n');

            return `\nAvailable properties for '${layerId}':\n${propList}`;
        }).join('\n');
    };

    const layerPropsDoc = getLayerPropsDoc();

    return [
        {
            name: 'add_layer',
            description: `Show/display/visualize a layer on the map. Use this when the user asks to "show", "display", "visualize", or "add" a layer. Available layers: ${allLayers.join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: {
                        type: 'string',
                        enum: allLayers,
                        description: 'The ID of the layer to add.'
                    }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapController.setLayerVisibility(args.layer_id, true);
                return JSON.stringify(result);
            }
        },
        {
            name: 'remove_layer',
            description: `Hide/remove a layer from the map. Use this when the user asks to "hide", "remove", or "turn off" a layer. Available layers: ${allLayers.join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: {
                        type: 'string',
                        enum: allLayers,
                        description: 'The ID of the layer to remove.'
                    }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapController.setLayerVisibility(args.layer_id, false);
                return JSON.stringify(result);
            }
        },
        {
            name: 'get_layer_info',
            description: 'List all available layers and check which layers are currently visible. Use this ONLY when the user explicitly asks "what layers are available?" or "which layers are visible?". Do NOT use this before adding a layer - just add it directly.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const layers = mapController.getAvailableLayers();
                return JSON.stringify({ success: true, layers });
            }
        },
        {
            name: 'filter_layer',
            description: `Apply a filter to a layer and check how many features match.
            
            IMPORTANT: After filtering, the result includes 'featuresInView' - the number of visible features matching your filter.
            - If featuresInView is 0, your filter may be too restrictive or use incorrect property values
            - If you get 0 results, consider using the 'query' tool to check what values actually exist in the data
            - Common mistakes: wrong property name, exact match when partial needed, case sensitivity
            
            For example, if you filter by property name and get 0 results, query the data first to see available values. 
            
            For 'species_richness', the filter object should contain:
            - species_type: "all" | "threatened"
            - taxon: "combined" | "amphibians" | "birds" | "mammals" | "reptiles" | "fw_fish"
            
            For vector layers (${vectorLayers.join(', ')}), the filter should be a MapLibre filter expression array:
            - ["==", "property", "value"]
            - ["in", "property", "val1", "val2"]
            - [">", "property", 100]

            ${layerPropsDoc}
            `,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: {
                        type: 'string',
                        enum: allLayers,
                        description: 'The ID of the layer to filter.'
                    },
                    filter: {
                        description: 'The filter to apply. Either a MapLibre filter expression (array) for vector layers, or a parameter object for specific layers like species_richness.',
                        anyOf: [
                            { type: 'array' },
                            { type: 'object' }
                        ]
                    }
                },
                required: ['layer_id', 'filter']
            },
            execute: (args) => {
                const result = mapController.filterLayer(args.layer_id, args.filter);
                return JSON.stringify(result);
            }
        },
        {
            name: 'clear_filter',
            description: `Remove all filters from a layer, showing all features again. Use this when the user asks to "clear filters", "remove filters", "show all", or "reset" a layer. Available layers: ${allLayers.join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: {
                        type: 'string',
                        enum: allLayers,
                        description: 'The ID of the layer to clear filters from.'
                    }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                // Clear filter by passing null
                const result = mapController.filterLayer(args.layer_id, null);
                return JSON.stringify(result);
            }
        },
        {
            name: 'style_layer',
            description: `Update a layer's style (paint properties).
            
            For vector layers (${vectorLayers.join(', ')}), provide a 'paint' object with keys like 'fill-color', 'line-width', etc.
            Values can be static or MapLibre expressions.
            
            Example: { "fill-color": "red", "fill-opacity": 0.5 }
            
            You can use data-driven styling with 'match', 'step', or 'interpolate' expressions using the layer properties.
            ${layerPropsDoc}
            `,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: {
                        type: 'string',
                        enum: allLayers,
                        description: 'The ID of the layer to style.'
                    },
                    style: {
                        type: 'object',
                        description: 'Object containing paint properties to update.',
                    }
                },
                required: ['layer_id', 'style']
            },
            execute: (args) => {
                const result = mapController.styleLayer(args.layer_id, args.style);
                return JSON.stringify(result);
            }
        }
    ];
}
