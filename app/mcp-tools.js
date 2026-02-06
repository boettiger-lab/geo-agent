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

    return [
        {
            name: 'add_layer',
            description: `Add a visible layer to the map. Available layers: ${allLayers.join(', ')}`,
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
            description: `Remove a layer from the map (hide it). Available layers: ${allLayers.join(', ')}`,
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
            description: 'Get information about available layers and their current status (visible/hidden).',
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
            description: `Apply a filter to a layer. 
            
            For 'species_richness', the filter object should contain:
            - species_type: "all" | "threatened"
            - taxon: "combined" | "amphibians" | "birds" | "mammals" | "reptiles" | "fw_fish"
            
            For vector layers (${vectorLayers.join(', ')}), the filter should be a MapLibre filter expression array:
            - ["==", "property", "value"]
            - ["in", "property", "val1", "val2"]
            - [">", "property", 100]
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
            name: 'style_layer',
            description: `Update a layer's style (paint properties).
            
            For vector layers (${vectorLayers.join(', ')}), provide a 'paint' object with keys like 'fill-color', 'line-width', etc.
            Values can be static or MapLibre expressions.
            
            Example: { "fill-color": "red", "fill-opacity": 0.5 }
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
