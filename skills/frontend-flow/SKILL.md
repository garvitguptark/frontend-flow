---
name: frontend-flow
description: Use this whenever the user wants a website, landing page or UI built or redesigned, especially one made to feel like an existing site they name rather than link ("build me something like Stripe's site", "clone the vibe of Linear's homepage"), or animated or static. Trigger on "build a site like X", "make a landing page", "redesign this to feel like Y", or any frontend build request, even if the user never says "plugin" or "workflow". This is the entry point for builds, so pick it over frontend-flow:website, which only looks tokens up. It runs the whole flow — resolves a named reference itself instead of asking for the URL, measures the reference's real design tokens, asks two quick preference questions, then builds.
---

# Frontend Flow

Extraction is mechanical and noisy; design judgment is neither. Splitting them across phases keeps scraped markup out of the main conversation entirely — the extraction runs in a subagent that exits, or in a local script that costs no model tokens at all — and turns "what vibe?" into two taps instead of a paragraph.

## Step gates

Someone running this for the first time doesn't know what's coming next, or that they can stop. So don't run the phases straight through — between them, ask with `AskUserQuestion`, naming the step you're about to start:

| After | Ask | Options |
|---|---|---|
| Phase 0 — *only if it ran* | "Architecture picked. Go to Step 1 — Preferences?" | Yes, carry on / Pick a different architecture / Stop here |
| Phase 1 | "Preferences captured. Go to Step 2 — Gather constraints?" | Yes, scan and gather / Skip straight to the build / Stop here |
| Phase 2 | "Constraints gathered. Go to Step 3 — Build?" | Yes, build it / Show me the tokens again first / Stop here |
| Phase 3 | "Build done. Go to Step 3.5 — Look at it?" | Yes, open it in the browser / Skip the render check / Stop here |
| Phase 3.5 | "Render checked. Go to Step 4 — Present?" | Yes, wrap up / Fix something first |

`AskUserQuestion` appends an "Other" choice on its own — don't write one into the options.

Carry one extra option on the **first** gate only: **"Run the rest without asking."** If they pick it, drop every remaining gate for this build. Someone on their third run should not be tapping through four questions to get a landing page.

Don't gate *inside* Phase 3. The builder writes its files in a single subagent run, so there is nothing to interrupt between them — gate around it, not through it.

## Phase 0 — Structural check

**Skip this silently for most requests, and don't mention that you skipped it.** A landing page, a marketing site, a portfolio, a single-page anything — the structure is one page and one build, everybody already knows that, and a gate here taxes the most common request for nothing.

Run it only when the request carries one of these, which are the cases where the structure is genuinely undecided and changes what gets built:

- More than one frontend team, or modules shipping on separate cadences
- A module deliberately on a different stack from the rest ("the old Vue catalog")
- An app shell hosting things built elsewhere
- Live data driving the UI — a feed, a tracker, a dashboard that updates itself

When one applies, run `/architecture` on the request before Phase 1, and carry its answer into Phase 3 as another builder input alongside the `/drift` report. A micro-frontend answer changes what `frontend-builder` is building; a plain answer costs one line and gets discarded.

**Invoke it the way this harness exposes plugin commands** — in Claude Code that is the `Skill` tool with `frontend-flow:architecture`. If that isn't available, read `${CLAUDE_PLUGIN_ROOT}/commands/architecture.md` and follow it directly. Writing `/architecture` as chat text does not run anything, and answering from memory instead throws away the decision table, which is the entire value: the table is ordered cheapest-to-operate first and refuses ambition words, and a model improvising will do neither.

Two things this phase is not:

- **Not a backend review.** If the user is building a UI against an API that already exists, the structural question is about the UI only. Don't offer to restructure a backend nobody asked about.
- **Not a scaffolding step.** `/architecture` will offer to scaffold; decline it here. Phase 3 is the build, and the builder needs the tokens and the motion level that Phases 1 and 2 have not produced yet.

## Phase 1 — Quick preference check

Before doing anything else, if these aren't already clear from the request, ask using the `AskUserQuestion` tool (not free-text prose questions — this is exactly the multiple-choice case it's for):

**How much motion**, as four options rather than an animated/static binary. Each level includes the one above it, so a choice is unambiguous about what it covers:

| Option | What it licenses |
|---|---|
| Static | Nothing moves. No transitions, no keyframes. |
| Interaction only | Hover, focus, active and state changes. Nothing moves on its own. |
| Interaction + entrances | The above, plus content arriving on scroll or load. |
| Everything | The above, plus ambient or looping motion. |

This maps onto the split the scanner already reports: "interaction" is `TRANSITIONS`, "entrances" and "ambient" are `ANIMATIONS`. Pass the chosen level through to the builder in these words, so it and the token report are speaking the same language.

Don't collapse this back into "animated" when you hand it on. **Interaction only** is what most people mean by "animated but not annoying", and it is the level a plain binary cannot express — which is the reason for asking this way.

Then, still in the same `AskUserQuestion` call:
- Single page or multi-page
- Stack, if it isn't obvious from the project (plain HTML/CSS/JS, React, or "whatever fits the existing project")

Skip any question the request already answers — "make it feel alive" settles motion, an existing `package.json` settles stack. Ask all of them in one call rather than one at a time. Don't ask more than this; anything else (copy, content specifics) can be handled inline once building starts.

## Phase 2 — Gather constraints

Two sources, both optional. Skip either if it doesn't apply.

**2a — The project you're building into.** If this isn't an empty directory, run the `/drift` scanner first:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/drift.mjs" .
```

(If that path doesn't exist, locate the script with Glob for `**/scripts/drift.mjs` — the variable is only substituted when the harness renders this file, and isn't a shell env var.)

It returns the colors, spacing, type, radii and shadows already in use, in about 30 lines. Pass that to the builder in Phase 3 so the new work matches what's there instead of starting a competing design system. Skip this for a greenfield build — there's nothing to match.

**2b — The reference.** If the user named a reference site or pasted a URL, extract its tokens with the scanner — not by reading the page yourself, and not by asking a subagent to look at it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/reference.mjs" <url>
```

It fetches the page plus its stylesheets and prints ~30 lines of clustered colors, fonts, transition timings and keyframe families. Add `--animations` if the user asked about specific animations.

If you were given a *name* rather than a URL, resolve it first with the `reference-scout` subagent — spawn it with whichever subagent tool this harness exposes (`Task` in some, `Agent` in others; the operative part is `subagent_type: frontend-flow:reference-scout`). It returns one line: `URL: https://...`. Then run the scanner on that URL. Don't ask the user to paste the URL themselves, and don't ask the scout for tokens — it has no tool that can read them.

**Why a script and not an agent:** measured across four runs, a subagent asked to extract tokens does one page fetch and then narrates — inventing plausible hex values, or citing third-party "design system" blog posts as though it had read the CSS. The scanner reads the actual stylesheets.

If no reference was named, skip 2b entirely — don't invent one.

Show the scanner's output to the user briefly before moving on, so they can correct it if the resolved site is wrong. If it reports no literal colors, say the reference isn't statically extractable rather than filling the gap.

## Phase 3 — Build

Delegate to the `frontend-builder` subagent — again via whichever subagent tool the harness exposes, with `subagent_type: frontend-flow:frontend-builder` — passing:
- The user's original request
- The architecture from Phase 0, if it ran — the four-line report, not a retelling
- The token report from Phase 2b, if any
- The drift report from Phase 2a, if any
- The answers from Phase 1

This is the one phase that should run on the strong model — don't try to shortcut it onto a cheaper one, since design judgment is the part that actually matters here.

## Phase 3.5 — Look at it

The builder has no browser and cannot see what it wrote. You can, so do it — but it has to be served over HTTP. A `file://` URL opens as a static snapshot that the page tools can't act on: no screenshot, no `read_page`, so you learn nothing.

If the project has a dev server, start it by name with `preview_start`. If it's plain HTML with no server, give it one first — `.claude/launch.json`:

```json
{ "version": "0.0.1", "configurations": [
  { "name": "<project>", "runtimeExecutable": "python",
    "runtimeArgs": ["-m", "http.server", "8765", "--directory", "."],
    "port": 8765 } ] }
```

**`cwd` in a launch config must be a relative path inside the project root**, so you cannot point one at a directory elsewhere on disk — a scratch copy, a sibling checkout — by setting `cwd`. For a Node project, pass the location as an argument instead, which sets the script's working directory without the key:

```json
{ "name": "<project>", "runtimeExecutable": "npm",
  "runtimeArgs": ["--prefix", "<absolute path>", "run", "dev", "--", "--port", "5174", "--strictPort"],
  "port": 5174 }
```

For a static directory, `python -m http.server <port> --directory <path>` takes the path the same way. Pick a port nobody else is on. If `preview_start` reports the port is taken by another session, that server is not yours and `preview_stop` won't stop it — check whether it happens to be serving this same project (`curl` it and compare against disk) and reuse it if so, otherwise change the port in `launch.json`. `autoPort` doesn't help here: `python -m http.server` takes its port as a positional argument and ignores the `PORT` environment variable.

**Bust the cache before you trust anything you see.** This is the step that makes the difference between a real render check and a fake one. The browser will happily serve you a cached stylesheet from the *previous* version of the site while the HTML is new — which renders as an unstyled or half-styled page and looks exactly like the builder shipped something broken. Two things that do *not* work: `ctrl+shift+r` through the `computer` tool never reaches the page, and cache-busting the page URL (`/?cb=1`) reloads the HTML while leaving `<link href="/css/site.css">` cached. Reload the stylesheets explicitly:

```js
document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
  l.href = l.href.split('?')[0] + '?cb=' + Date.now();
});
```

Re-apply this on **every** page you navigate to, not once per session — each new page loads its stylesheet from cache again.

Then confirm it took by reading back `document.styleSheets[…].cssRules.length`. That is the one signal that updates immediately: a rule count far below what the file contains means you are still on the old CSS. **Do not trust `getComputedStyle` or a screenshot to tell you this** — after a stylesheet swap both lag, sometimes for several seconds, and both will confidently show you the old design while the new sheet is already attached. Polling `getComputedStyle` does not fix it; re-reading in a later tool call does.

The giveaway that you are looking at a lagging read is that it contradicts itself — a computed `background` that disagrees with the `--bg` custom property it is defined from, or an `opacity: 0` on an element the screenshot plainly shows. When two signals disagree, re-read rather than believing either. To settle it definitively, append a probe element styled from the same custom property and read *its* computed value; a fresh element has no stale value to return.

If a screenshot times out, just retry it; that is common and is not a render failure.

**Before judging any motion, check whether the environment is asking for none.** Read it from the page:

```js
matchMedia('(prefers-reduced-motion: reduce)').matches
```

If that is `true` — and it is on at least some machines, from an OS animation setting rather than anything the build did — then a correct build will have skipped every entrance and every transition, and the page you are looking at proves nothing about its motion either way. Reporting "the animations don't fire" from that state is wrong, and so is reporting that they work.

To actually exercise the motion path, fetch the script, replace the reduced-motion test with `false`, and import the patched source as a blob module:

```js
const src = await (await fetch('js/site.js?t=' + Date.now())).text();
const patched = src.replace("matchMedia('(prefers-reduced-motion: reduce)').matches", 'false');
await import(URL.createObjectURL(new Blob([patched], { type: 'text/javascript' })));
```

Then scroll and count what is still hidden — `[...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity === '0').length` should reach 0. Run the same patch a second time with the animation library's CDN URL rewritten to an unreachable host: content must still end up visible, which is the fail-open invariant the builder was told to satisfy, actually tested rather than read.

A tab's capture can also get stuck returning a **uniformly blank frame** while the page underneath is fine — you will see it disagree with the DOM, e.g. a blank white image at a scroll position where the tile's computed `background` is near-black. Retrying in the same tab does not clear it. Open a fresh tab and load the URL there; that does. Never report a blank capture as a blank page without checking what the DOM says is in view.

Check the things a screenshot is bad at by asking the page directly, rather than squinting: horizontal overflow (`documentElement.scrollWidth > clientWidth`), images that failed (`naturalWidth === 0`), content left stranded at `opacity: 0` by a scroll reveal that never fired, and the console. Then look at the screenshot for the things only eyes catch.

Fix anything obviously broken — overflow, collapsed layout, invisible text, an image that didn't resolve. One pass. This is a sanity check that the page renders, not a design critique; don't loop on polish here. Before concluding a page *is* broken, rule out the cache: `curl` the served bytes and diff them against the file on disk. Reporting a working build as broken, and then "fixing" it, is worse than skipping this phase.

## Phase 4 — Present

Present the result the normal way for whatever was built (files via the project's file-sharing convention, or inline code). Don't re-paste the token report or re-ask the preference questions — they were already shown earlier in the conversation.

**Always end with the exact command that runs it, and a warning if double-clicking won't work.** A static build that uses root-relative paths (`/css/site.css`, `/read`) loads nothing at all from a `file://` URL — every stylesheet and script 404s against the filesystem root, and the page renders as naked HTML: default serif, blue underlined links, no background. It looks like a broken build rather than a viewing mistake, and the person will reasonably blame the build.

So finish with something like:

```
Run it:  python -m http.server 8765 --directory <project>
Open:    http://localhost:8765
```

and say in one line that opening the file directly will show it unstyled. If you left a `.claude/launch.json` behind in Phase 3.5, name it — that is the same server, one command shorter. Check what the build actually emitted before writing this: if every asset and link is relative, `file://` is fine and there is nothing to warn about.

## If you're not in Claude Code

The model routing and the `/drift` script both depend on Claude Code — subagents that declare their own model, and a shell. Elsewhere, the phase order still applies; run it all on the current model and say plainly that the cost routing isn't available here rather than implying it happened.
