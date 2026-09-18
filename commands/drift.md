---
name: drift
description: Extract the design system that actually exists in this codebase — every color, spacing value, font, radius and shadow in use, clustered into the token set they should collapse to, plus contrast failures. Use for "what are our colors", "how many grays do we have", "audit our design tokens", "why does this look inconsistent", or before building anything new into an existing project.
allowed-tools: Bash, Read, Glob, Grep, Edit
---

Run the scanner over the target directory (the argument if one was given, otherwise the project root):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/drift.mjs" <dir>
```

If that path doesn't exist — `${CLAUDE_PLUGIN_ROOT}` isn't exported to the shell, so it only works when the harness substitutes it into this file — find the script instead with Glob for `**/scripts/drift.mjs` and run the path you get. Don't give up on the command because the variable didn't resolve, and don't reimplement the scan inline.

If the user wants the animations themselves rather than a summary — "grab that fade-in", "what's their hover transition", "I want that animation" — add `--animations`, which prints each `@keyframes` with the timing it's actually used with and a ready-to-paste `animation:` line.

Show its output as-is. It's already aggregated to ~30 lines regardless of repo size, so don't summarize it into prose and don't re-list the values in a different format.

**If a `TOKENS` section is present, lead with it — it is the actual answer.** The project declares colour tokens, and the section says which are honoured, which are `bypassed` by hardcoded near-misses, and which clusters hold two real tokens. A `bypassed` line is the finding: the token exists and people typed a near-identical hex instead. A `KEEP SEPARATE` line is the opposite warning — those values look alike to the clustering but are two intentional tokens, so collapsing them destroys a real distinction. Don't second-guess either from the `COLORS` block above; `TOKENS` had more information when it decided.

Then add at most three lines of your own, covering only what the numbers don't say themselves:
- Which near-duplicates matter, **for clusters `TOKENS` did not already rule on** — a cluster with no declared token in it is still just a count, and whether those values are drift or intent is a judgement call
- Whether the off-scale spacing values are a real drift or just a different base unit — a repo built on 10px is consistent, it just isn't on a 4px scale
- Which contrast failures are likely real text pairings, since the script infers pairings and says so

On motion, read the two sections differently. `TRANSITIONS` is how the interface *feels* — hover, focus, state change — and is the number worth copying. `ANIMATIONS` is keyframe effects, and families marked `[decorative]` are generated per-element (a particle grid, a shimmer); they dominate the raw counts and tell you nothing about the interface.

`TRANSITIONS 0 declarations` has **two** causes and they read identically in the header line, so check which before saying anything:

- If a `UTILITIES` section is present, the motion is in class names (`transition-colors`, `duration-300`) and the scanner prints the count there. Report that, not an absence.
- Only if there is no `UTILITIES` section does zero mean the interaction motion is driven from JS and is genuinely not recoverable.

**When a `UTILITIES` section appears at all, lead with it.** It means the repo is utility-first, so `COLORS`, `SPACING`, `RADIUS` and `TYPE` above it describe the arbitrary values and inline styles — the escape hatches — and not the design system, which lives in class names and a Tailwind theme. Those sections are still worth reading, because hardcoded hexes sitting next to a named theme token are exactly the drift this command exists to find. Just don't present "3 distinct radii" as the radius scale when the `UTILITIES` line says otherwise.

## Boundaries

- Don't edit anything. This command reports; consolidating tokens is a separate decision the user makes after seeing the report.
- When `--animations` output came from a site the user doesn't own, keep the risk note the script prints — don't strip it when summarizing. Timing and easing are functional values; a distinctive signature animation may not be. Say it once, plainly, and don't lecture beyond that.
- If the user then asks to consolidate, do it as a normal edit task — define the custom properties, replace the near-duplicate values, leave the semantically distinct ones alone. Don't invent a full token scale they didn't ask for.
- The suggested names (`--neutral-900`, `--blue-500`) are mechanical, derived from lightness and hue. They are a starting point, not semantic names. Say so rather than presenting them as the recommended API.
- If the scan finds nothing, the directory probably isn't a frontend project. Say that instead of reporting empty sections.

## Relationship to the rest of this plugin

`/website` reads tokens off an external reference. `/drift` reads them off the project you already have. When both exist, the build step reconciles them: the reference supplies the design language, `/drift` supplies the constraints the codebase already imposes.
