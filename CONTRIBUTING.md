# Contributing

Thanks for your interest in GLEN — we'd love to hear from you.

This document covers how to contribute, and a note on our policy around AI-generated code.

## Ways to contribute

The most valuable contributions, in roughly increasing order of effort:

1. **Open an issue describing a real problem you hit.** Bug reports grounded in actual use ("I tried to do X and got Y") are gold — they bring information no one inside the lab can get on their own.
2. **Comment on or upvote (👍) an existing issue.** If something is already filed but unsolved, a "+1, I hit this too" tells us it matters to real users and helps us prioritize. This is genuinely more useful to us than an unsolicited PR.
3. **Discuss design** in an existing issue before writing code, especially for non-trivial changes. We're happy to talk through approach so your effort lands somewhere useful.
4. **Open a pull request** — see the policy below.

For all of the above, please be specific. "It doesn't work" is hard to act on; "I loaded layer X in app Y, asked the agent Z, and got error W in the browser console" is something we can fix.

## Pull request policy

We welcome pull requests authored by **humans**, especially where you bring expertise we lack — domain knowledge, real-world usage patterns, accessibility, a platform we don't test on, a language you speak natively, and so on.

We do **not** accept pull requests authored by AI tools from outside contributors. If you used an AI assistant to help write a PR, please tell us in the PR description so we can have an honest conversation about it.

### Why the asymmetry?

The maintainers of this repo use AI assistants extensively — that's not a secret, and it would be hypocritical to pretend otherwise. The distinction we draw isn't "AI vs. no AI"; it's **accountable AI vs. unaccountable AI**:

- **In-house AI** runs in an environment we've configured: it knows our conventions, our in-flight work, our deployment quirks, and our project history. Its commits are attributable to a specific maintainer who reviewed and stands behind every line. When we use AI through our [`boettiger-lab-llm-agent`](https://github.com/apps/boettiger-lab-llm-agent) GitHub App, that identity is declared in the commit/PR record, so anyone reading the history can see when AI was involved.
- **Outside AI** has none of that context. It can't see our in-flight branches, doesn't know our conventions, can't make scope/design tradeoffs that fit the project, and arrives without a maintainer who has reviewed and owns the output. Reviewing such a PR carefully costs us roughly the same as just doing the work ourselves — which we can do in an environment we already trust.

There's a second concern: AI tools are very good at scanning open issues and producing plausible-looking PRs against them. If we accepted those, we'd quickly drown in plausible-looking patches with no underlying human judgment, and our issue tracker would stop being a useful signal about what real users actually need.

### What this means in practice

- **You hit a bug or have a feature idea?** Please open an issue or comment on an existing one. That's the highest-leverage thing you can do.
- **You want to fix something yourself, as a human?** Great — please go ahead. Mention in the PR description what motivated the change (a real use case, a bug you hit, an issue you wanted to close) and we'll engage.
- **You used an AI assistant to write the PR?** Be upfront about it in the PR description. We'll likely close the PR with thanks, and either pick up the underlying issue ourselves or invite you to re-engage as a human (e.g., by describing the use case in an issue). No hard feelings — this isn't about gatekeeping, it's about keeping a sustainable review process.
- **You're a regular contributor or collaborator and want to use AI to help with PRs?** Talk to the maintainers — there's a path for that, via the lab's vetted tooling.

### Approved AI use inside the lab

Lab members and approved collaborators who use AI assistance for contributions to this repo do so through the [`boettiger-lab-llm-agent`](https://github.com/apps/boettiger-lab-llm-agent) GitHub App. Commits and PRs made through this app are identifiable in the repo history. The human operator is still the contributor of record and responsible for the change; the app identity exists so AI involvement is *declared*, not hidden.

If you're a lab member and need access, reach out to a maintainer.

## Code of conduct

Be kind. Assume good faith. We're a small group trying to build something useful.

## Questions

If anything here is unclear, or you're not sure which category your contribution falls into, open an issue and ask. We'd rather talk first than have you spend effort on something we can't accept.
