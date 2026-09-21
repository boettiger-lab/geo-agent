# Brand assets

Marks that every app in the fleet carries, kept here so a downstream app can
reference them from the CDN at its pinned ref rather than each hosting its own
copy or hotlinking someone's website:

```
https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@<ref>/app/assets/<file>
```

| File | Use |
|---|---|
| `dse-logo-black.png` | DSE mark for **light** backgrounds |
| `dse-logo-white.png` | DSE knockout mark for **dark** backgrounds |

Both are the horizontal lockup, 2162×958. Supply both to a header logo slot
via `src` and `src_dark` so the right one shows in either theme:

```json
"brand": {
  "src": ".../app/assets/dse-logo-black.png",
  "src_dark": ".../app/assets/dse-logo-white.png",
  "alt": "Eric and Wendy Schmidt Center for Data Science & Environment",
  "href": "https://dse.berkeley.edu/"
}
```

Source: the DSE brand drive. These are **third-party brand assets, not
project code** — do not recolour, crop or redraw them; check the DSE brand
guidelines before using them in a new way, and replace them here if DSE
reissues the mark.
