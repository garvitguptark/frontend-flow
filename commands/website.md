---
name: website
description: Look up a site by name or URL and return its design tokens (colors, type, spacing, motion) without doing a full build. Use for "what does X's site look like", "grab the colors/fonts from X", or as a quick reference check before deciding what to build.
---

Extract the reference's design tokens with the scanner:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/reference.mjs" <url> [--animations]
```

(If that path doesn't resolve, locate it with Glob for `**/scripts/reference.mjs` — the variable is substituted when this file is rendered and is not a shell env var.)

If the user gave a brand *name* rather than a URL, resolve it first with the `reference-scout` subagent — spawn it with whichever subagent tool this harness exposes (`Task` or `Agent`; what matters is `subagent_type: frontend-flow:reference-scout`). It returns one line, `URL: https://...` — then run the scanner on that.

Show the scanner output as-is. Don't expand it into prose, don't re-derive the values by eye, and don't start building anything unless the user asks for a build (in which case hand off to the full `frontend-flow` skill).

Add at most two lines of interpretation: which clusters look like the brand palette rather than incidental colors, and whether the transition timings represent real interaction motion or only decorative keyframes. If the scanner reports no literal colors, say the site defines everything as CSS variables loaded from JS and isn't statically extractable — do not substitute plausible-looking values.
