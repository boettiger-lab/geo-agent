# STAC to Layers Config Generator

This directory contains a helper script to generate `layers-config.json` from STAC catalog entries.

## Quick Start

**Recommended: Use a JSON input file** (clearer what you need to specify vs what comes from STAC):

```bash
python3 scripts/stac-to-layers-config.py \
    --input scripts/layers-input-example.json \
    --output app/layers-config.json
```

## Input JSON Format

Create a JSON file specifying which layers to generate:

```json
{
    "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
    "titiler_url": "https://titiler.nrp-nautilus.io",
    "layers": [
        {
            "collection_id": "cpad-2025b",
            "asset_id": "cpad-units-pmtiles",
            "layer_key": "cpad",
            "display_name": "California Protected Areas (CPAD)",
            "comment": "PMTiles vector - filterable properties auto-extracted from STAC"
        },
        {
            "collection_id": "irrecoverable-carbon",
            "asset_id": "vulnerable-total-2018-cog",
            "layer_key": "carbon",
            "display_name": "Vulnerable Carbon",
            "options": {
                "colormap": "reds",
                "rescale": "0,100"
            },
            "comment": "COG raster - served via TiTiler"
        }
    ]
}
```

### What You Specify vs What Comes from STAC

**User-specified (required):**
- `collection_id`: STAC collection ID
- `asset_id`: Asset ID from the collection
- `layer_key`: Key to use in layers-config.json

**User-specified (optional):**
- `display_name`: Layer display name (falls back to STAC asset title)
- `options.colormap`: Colormap for raster layers (default: "reds")
- `options.rescale`: Rescale range for rasters (e.g., "0,100")

**Auto-extracted from STAC:**
- Attribution (from collection providers/links)
- Filterable properties (from `table:columns` for vector layers)
- Asset URLs and types
- Layer metadata

## Legacy CLI Usage

The script also supports command-line arguments for backward compatibility:

```bash
python3 scripts/stac-to-layers-config.py \
    --catalog https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json \
    --output test-config.json \
    --layer cpad-2025b:cpad-units-pmtiles:cpad:"California Protected Areas (CPAD)"
```

**Generate carbon layer config:**
```bash
python scripts/stac-to-layers-config.py \
    --catalog https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json \
    --output test-config.json \
    --layer irrecoverable-carbon:vulnerable-total-2018-cog:carbon:"Vulnerable Carbon"
```

**Generate both together:**
```bash
python scripts/stac-to-layers-config.py \
    --catalog https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json \
    --output app/layers-config-generated.json \
    --layer cpad-2025b:cpad-units-pmtiles:cpad:"California Protected Areas (CPAD)" \
    --layer irrecoverable-carbon:vulnerable-total-2018-cog:carbon:"Vulnerable Carbon"
```

## Arguments

- `--catalog`: URL to the STAC catalog.json file
- `--output`: Path where the layers-config.json should be written
- `--layer`: Layer specification in format `COLLECTION:ASSET:KEY:NAME` (can be repeated)
  - `COLLECTION`: STAC collection ID (e.g., `cpad-2025b`)
  - `ASSET`: Asset ID from the collection (e.g., `cpad-units-pmtiles`)
  - `KEY`: Layer key to use in the config (e.g., `cpad`)
  - `NAME`: Display name for the layer (optional, will use asset title if omitted)
- `--titiler`: TiTiler base URL for COG tiles (default: `https://titiler.nrp-nautilus.io`)
- `--colormap`: Default colormap for raster layers (default: `reds`)

## How It Works

1. **Reads the STAC catalog** to find collection URLs
2. **Fetches collection metadata** including assets, table columns, and attribution
3. **Detects layer type**:
   - PMTiles assets → vector layers with filterable properties
   - COG (GeoTIFF) assets → raster layers via TiTiler
4. **Extracts metadata**:
   - Display names from asset titles
   - Attribution from collection providers
   - Filterable properties from `table:columns` (for vector layers)
5. **Generates layer config** in the format expected by the application

## Finding Asset IDs

To find available collections and assets, browse the STAC catalog:
- **STAC Browser**: https://radiantearth.github.io/stac-browser/#/external/s3-west.nrp-nautilus.io/public-data/stac/catalog.json
- **Catalog JSON**: https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json

Or use this command to list assets in a collection:
```bash
curl -s https://s3-west.nrp-nautilus.io/public-cpad/stac-collection.json | \
    python -m json.tool | grep -A 5 '"assets"'
```

## Notes

- The script automatically detects vector vs raster layers based on asset type
- For PMTiles layers, it extracts filterable properties from STAC `table:columns`
- For COG layers, it generates TiTiler tile URLs with appropriate colormaps
- Generated configs may need manual adjustment for:
  - Layer source-layer names (PMTiles)
  - Colormap settings (raster)
  - Additional UI parameters (like species_richness filters)
