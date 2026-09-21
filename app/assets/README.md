# Brand assets

Marks that every app in the fleet carries, kept here so a downstream app can
reference them from the CDN at its pinned ref rather than each hosting its own
copy or hotlinking someone's website:

```
https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@<ref>/app/assets/<file>
```

| File | Use |
|---|---|
| `favicon.svg` | Browser-tab icon. **Placeholder** — a plain hexagon, nodding to the H3 grid, until GLEN has a mark |
| `dse-mark.png` | Monogram — "DSE" + sprout, no wordmark. Legible small; **light** backgrounds |
| `dse-mark-white.png` | Monogram, knockout, for **dark** backgrounds. **Derived, not official** — see below |
| `dse-logo-black.png` | Full horizontal lockup for **light** backgrounds |
| `dse-logo-white.png` | Full lockup, knockout, for **dark** backgrounds |

The lockups are 2162×958; the monogram is 1255×958. At a header's ~24px height
the lockup's wordmark is unreadable, so prefer the monogram where it fits.

> **`dse-mark-white.png` is derived, not official.** The brand drive ships no
> knockout monogram — only the full lockup has a `ko` variant. This one was
> made from `dse-mark.png` by recolouring the navy ink to white and leaving
> the green sprout untouched, preserving alpha so the edges stay clean. That
> mirrors the treatment DSE already applies to the lockup, but it is still our
> derivation. **Replace it with an official asset** when DSE supplies one, and
> do not derive further variants from it. Supply both to a header logo slot
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

## Favicon

`favicon.svg` is a placeholder: a single filled hexagon, kept plain so it
survives a 16px browser tab. It stands in until GLEN has a real mark, at which
point replace it here.

Downstream apps link it from their `index.html`:

```html
<link rel="icon" type="image/svg+xml"
      href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@<ref>/app/assets/favicon.svg">
```

An app with its own branding should point this at its own icon instead.
