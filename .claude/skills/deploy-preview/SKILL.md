---
name: deploy-preview
description: Publish a live, interactive preview of the current branch's app to GitHub Pages, so a human can review UI changes in a browser. Use whenever work touches app/*.css, app/*.js layout/chrome, the header, theme, sidebar, mobile layout, legend or any other visible surface — and before asking anyone to review such a change. Also covers adding a preview variant (light vs dark, custom branding) and troubleshooting a preview that did not update.
---

# Deploy a preview

UI changes in this repo are reviewed **by using them**, not by reading the diff.
Publish a preview and lead with the URL.

Browser-bound modules have no test harness — `AGENTS.md` says so for
`chat-ui.js`, `map-manager.js`, `layout-manager.js`, `map-draw.js`, `h3geo.js`
and `voice-input.js`. This is that harness. Bugs it has caught that no unit
test would have: a `background-image` data URI whose inner quotes voided the
declaration, two CSS specificity ties that silently lost, a flex rule that made
a panel unscrollable on a phone. All produced *valid* CSS that did nothing.

## Publish

One push and one dispatch. Keep working on your feature branch; mirror it to a
`preview/*` ref, because the `github-pages` environment only permits deploys
from `main` and `preview/*`.

```bash
git push -f origin <your-branch>:preview/<name>
gh workflow run gh-pages.yml --ref preview/<name>
```

Then wait for it and confirm it is really live:

```bash
RUN=$(gh run list --workflow gh-pages.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status
```

**Always verify the deployed asset contains your change** before telling anyone
it is live. Pages takes ~15-20s after the run finishes, and a stale page looks
exactly like a working one:

```bash
sleep 20
curl -s https://boettiger-lab.github.io/geo-agent/preview/style.css | grep -c '<the thing you changed>'
```

URL: <https://boettiger-lab.github.io/geo-agent/preview/>

## Keep the fixture on your branch

`preview/layers-input.json` is the config the preview runs on. Put any fixture
change your feature needs (enabling a header, a layer with a slider) **on the
same branch as the feature**. Then publishing stays one mirror push.

Do not maintain a separate throwaway preview branch and cherry-pick onto it.
That was tried; it drifts, and a commit was lost to it.

## Variants

`preview/variants/<name>.json` is a shallow patch over the base fixture,
published at `/preview/<name>/`. Use one when two states need comparing side by
side rather than in sequence:

```json
// preview/variants/light.json  →  /preview/light/
{ "theme": "light" }
```

Top-level keys replace; there is no deep merge, so patch whole blocks.

## Iterating

Expect several rounds. Each one is: change → mirror push → dispatch → verify →
give the URL. Do not batch many changes hoping to get them all right at once;
the point is that the reviewer sees each step.

## Gotchas

- **One preview at a time.** Pages has a single deployment slot, so the next
  `main` push touching `docs/**` replaces the preview with the docs site.
  Re-dispatch to bring it back. Never treat a preview URL as durable.
- **No secrets.** `app/config.json` is gitignored and never deployed, so the
  preview has no API key and no LLM. To exercise chat or voice, set
  `llm.user_provided: true` in the fixture — the viewer supplies their own key.
  Never put a key in `preview/`.
- **Not the client integration path.** The preview serves `app/` in place via
  relative imports, so it does *not* exercise CDN pinning or the runtime config
  merge. A change touching those needs a real downstream pin instead.
- **Clean up.** Delete the `preview/*` ref once the PR merges.

## Do not reach into a downstream app

Pinning `geo-agent-template` (or any deployed app) to an unmerged SHA crosses a
repo boundary and takes over that app's public demo. Previews live here. If a
downstream change really is needed, open a proposal issue in that repo.

## Reference

`preview/README.md` covers what the fixture contains and why each layer is in
it. The staging step lives in `.github/workflows/gh-pages.yml` under
*Stage app preview*.
