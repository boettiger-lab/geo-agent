#!/usr/bin/env python3
"""
Generate layers-config.json from STAC catalog entries.

This script reads a JSON input file specifying STAC collections and assets,
then generates layer configurations for the CA Protected Lands maplibre application.

Usage:
    python3 stac-to-layers-config.py --input layers-input.json --output layers-config.json

Example:
    python3 stac-to-layers-config.py \
        --input scripts/layers-input-example.json \
        --output app/layers-config.json
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
from urllib.request import urlopen
from urllib.parse import urljoin


def fetch_json(url: str) -> Dict[str, Any]:
    """Fetch and parse JSON from a URL."""
    try:
        with urlopen(url) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f"Error fetching {url}: {e}", file=sys.stderr)
        sys.exit(1)


def find_collection_url(catalog_url: str, collection_id: str) -> Optional[str]:
    """Find the URL for a collection in the catalog."""
    catalog = fetch_json(catalog_url)
    
    for link in catalog.get("links", []):
        if link.get("rel") == "child":
            # Collection URLs can be relative or absolute
            collection_url = link.get("href", "")
            if not collection_url.startswith("http"):
                collection_url = urljoin(catalog_url, collection_url)
            
            # Check if this is the collection we want
            collection = fetch_json(collection_url)
            if collection.get("id") == collection_id:
                return collection_url
    
    return None


def detect_layer_type(asset: Dict[str, Any]) -> str:
    """Detect whether an asset is PMTiles (vector) or COG (raster)."""
    asset_type = asset.get("type", "")
    href = asset.get("href", "")
    
    if "pmtiles" in asset_type.lower() or href.endswith(".pmtiles"):
        return "pmtiles"
    elif "geotiff" in asset_type.lower() or "cloud-optimized" in asset_type.lower() or href.endswith(".tif"):
        return "cog"
    
    return "unknown"


def generate_layer_config(
    collection: Dict[str, Any],
    asset_id: str,
    layer_key: str,
    display_name: Optional[str] = None,
    titiler_url: str = "https://titiler.nrp-nautilus.io",
    colormap: str = "reds",
    rescale: Optional[str] = None
) -> Dict[str, Any]:
    """Generate a layer configuration from a STAC collection and asset."""
    
    assets = collection.get("assets", {})
    if asset_id not in assets:
        print(f"Error: Asset '{asset_id}' not found in collection '{collection.get('id')}'", file=sys.stderr)
        print(f"Available assets: {', '.join(assets.keys())}", file=sys.stderr)
        sys.exit(1)
    
    asset = assets[asset_id]
    asset_href = asset.get("href", "")
    asset_title = asset.get("title", "")
    layer_type = detect_layer_type(asset)
    
    # Use provided display name or fall back to asset title or collection title
    final_display_name = display_name or asset_title or collection.get("title", layer_key)
    
    # Extract attribution from collection links or providers
    attribution = ""
    about_link = next((link.get("href") for link in collection.get("links", []) if link.get("rel") == "about"), "")
    provider_name = collection.get("providers", [{}])[0].get("name", "")
    if about_link and provider_name:
        attribution = f'<a href="{about_link}" target="_blank">{provider_name}</a>'
    
    # Build layer config based on type
    if layer_type == "pmtiles":
        # Vector layer (PMTiles)
        # Extract source-layer name - use layer_key as default
        source_layer_name = layer_key
        
        layer_config = {
            "displayName": final_display_name,
            "layerIds": [f"{layer_key}-layer"],
            "checkboxId": f"{layer_key}-layer",
            "hasLegend": False,
            "isVector": True,
            "sourceLayer": source_layer_name,  # Required by LayerRegistry validation
            "source": {
                "type": "vector",
                "url":f"pmtiles://{asset_href}",
                "attribution": attribution
            },
            "layer": {
                "type": "fill",
                "source-layer": source_layer_name,
                "minzoom": 0,
                "maxzoom": 22,
                "paint": {
                    "fill-color": "#2E7D32",
                    "fill-opacity": 0.5
                },
                "layout": {
                    "visibility": "none"
                }
            }
        }
        
        # Add filterable properties from STAC table:columns if available
        table_columns = collection.get("table:columns", [])
        if table_columns:
            filterable = {}
            for col in table_columns:
                col_name = col.get("name", "")
                col_type = col.get("type", "string")
                col_desc = col.get("description", "")
                
                # Skip geometry and h3 columns
                if col_name in ["geometry", "h10", "h9", "h8", "h0"]:
                    continue
                
                # Map STAC types to our schema
                if "float" in col_type or "int" in col_type:
                    prop_type = "number"
                else:
                    prop_type = "string"
                
                filterable[col_name] = {
                    "type": prop_type,
                    "description": col_desc
                }
            
            if filterable:
                layer_config["filterableProperties"] = filterable
    
    elif layer_type == "cog":
        # Raster layer (COG via TiTiler)
        # Build TiTiler URL
        tiles_url = f"{titiler_url}/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?url={asset_href}&colormap_name={colormap}"
        if rescale:
            tiles_url += f"&rescale={rescale}"
        
        layer_config = {
            "displayName": final_display_name,
            "layerIds": [f"{layer_key}-layer"],
            "checkboxId": f"{layer_key}-layer",
            "hasLegend": False,
            "isVector": False,
            "source": {
                "type": "raster",
                "tiles": [tiles_url],
                "tileSize": 256,
                "minzoom": 0,
                "maxzoom": 12,
                "attribution": attribution
            },
            "layer": {
                "type": "raster",
                "paint": {
                    "raster-opacity": 0.7
                },
                "layout": {
                    "visibility": "none"
                }
            }
        }
    
    else:
        print(f"Error: Unknown layer type for asset '{asset_id}'", file=sys.stderr)
        sys.exit(1)
    
    return layer_config


def main():
    parser = argparse.ArgumentParser(
        description="Generate layers-config.json from STAC catalog",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to input JSON file specifying layers"
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output path for layers-config.json"
    )
    
    args = parser.parse_args()
    
    # Load JSON input file
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file '{args.input}' not found", file=sys.stderr)
        sys.exit(1)
    
    with open(input_path) as f:
        input_config = json.load(f)
    
    catalog_url = input_config.get("catalog")
    if not catalog_url:
        print("Error: 'catalog' field required in input JSON", file=sys.stderr)
        sys.exit(1)
    
    titiler_url = input_config.get("titiler_url", "https://titiler.nrp-nautilus.io")
    default_colormap = input_config.get("default_colormap", "reds")
    layer_specs = input_config.get("layers", [])
    
    if not layer_specs:
        print("Error: 'layers' array is empty in input JSON", file=sys.stderr)
        sys.exit(1)
    
    # Generate layers configuration
    layers_config = {
        "version": "1.0",
        "description": "Map layer configuration for California Protected Lands application",
        "layers": {}
    }
    
    for spec in layer_specs:
        collection_id = spec.get("collection_id")
        asset_id = spec.get("asset_id")
        layer_key = spec.get("layer_key")
        display_name = spec.get("display_name")
        options = spec.get("options", {})
        
        if not all([collection_id, asset_id, layer_key]):
            print(f"Error: Layer spec missing required fields: {spec}", file=sys.stderr)
            sys.exit(1)
        
        print(f"Processing {collection_id}:{asset_id} -> {layer_key}...", file=sys.stderr)
        
        # Find collection URL
        collection_url = find_collection_url(catalog_url, collection_id)
        if not collection_url:
            print(f"Error: Collection '{collection_id}' not found in catalog", file=sys.stderr)
            sys.exit(1)
        
        # Fetch collection
        collection = fetch_json(collection_url)
        
        # Get options with defaults
        colormap = options.get("colormap", default_colormap)
        rescale = options.get("rescale")
        
        # Generate layer config
        layer_config = generate_layer_config(
            collection,
            asset_id,
            layer_key,
            display_name,
            titiler_url,
            colormap,
            rescale
        )
        
        layers_config["layers"][layer_key] = layer_config
        print(f"✓ Generated config for '{layer_key}'", file=sys.stderr)
    
    # Write output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, "w") as f:
        json.dump(layers_config, f, indent=4)
    
    print(f"\n✓ Wrote {len(layers_config['layers'])} layer(s) to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
