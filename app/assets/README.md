# Brand assets

Marks that every app in the fleet carries, kept here so a downstream app can
reference them from the CDN at its pinned ref rather than each hosting its own
copy or hotlinking someone's website:

```
https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@<ref>/app/assets/<file>
```

| File | Use |
|---|---|
| `dse-mark.png` | Monogram — "DSE" + sprout, no wordmark. Legible small; **light backgrounds only** |
| `dse-logo-black.png` | Full horizontal lockup for **light** backgrounds |
| `dse-logo-white.png` | Full lockup, knockout, for **dark** backgrounds |

The lockups are 2162×958; the monogram is 1255×958. At a header's ~24px height
the lockup's wordmark is unreadable, so prefer the monogram where it fits.

> **Gap:** there is no knockout (white) monogram in the DSE brand drive — only
> the full lockup has a `ko` variant. So a dark header currently has to fall
> back to the lockup. Ask DSE for a knockout monogram rather than recolouring
> `dse-mark.png`, which would be deriving a brand asset we do not own. Supply both to a header logo slot
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
