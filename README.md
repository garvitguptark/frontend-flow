# Frontend Flow

A Claude Code plugin that decides the shape of what you're building, then builds it against a real design reference instead of a guessed one.

Two questions, answered in order. **What shape is this?** — `/architecture` maps a requirement onto one of seven system architectures, walking them cheapest-to-operate first, and tells you what the answer costs. **What should it look like?** — it resolves a site you name ("make it feel like Stripe") into concrete design tokens, reads the design system already in your codebase, and keeps the noisy extraction work off the expensive model.

Structure comes first because it changes what the design step is building. A micro-frontend shell and a single landing page are not the same job.

## Install

One command, from inside Claude Code. It adds the marketplace and installs in the same
step, showing you the source it resolved before it adds anything:

```
/plugin install frontend-flow --marketplace garvitguptark/frontend-flow
```

Note the `owner/repo` shorthand — not a full URL. Needs Claude Code v2.1.275 or later.

<details>
<summary>On an older version, or if you prefer the two steps</summary>

```
/plugin marketplace add garvitguptark/frontend-flow
```

```
/plugin install frontend-flow@frontend-flow
```

The `@frontend-flow` suffix is the **marketplace** name, not a repeat of the plugin name —
this repo's catalog and its one plugin happen to share a name.

Both work as `claude plugin ...` in a shell instead of `/plugin ...` in a session. After
adding the marketplace you can also just run `/plugin` and pick it out of the **Discover**
tab, which shows the context cost and the full list of what gets installed before you
commit.

</details>

**On the Claude desktop app**, `/plugin` isn't available — use the built-in plugin browser
instead. Same marketplace, same plugin.

Requires Node 18+ for the `/drift` and `/website` scanners. No other dependencies, and
nothing is installed from npm.

### Or skip the marketplace entirely

The marketplace exists for **discovery and updates**, not to make the plugin work. If
you've cloned or forked this repo, two shorter paths work straight away.

**Try it without installing anything:**

```bash
claude --plugin-dir ./frontend-flow
```

Loads the plugin for that session only. Nothing is copied, nothing is registered, and
`/reload-plugins` picks up your edits without a restart. This is the right path for
trying it, and for hacking on a fork.

**Install it permanently, no marketplace:**

```bash
cp -r ./frontend-flow ~/.claude/skills/frontend-flow
```

A plugin directory placed in your skills directory auto-loads every session as
`frontend-flow@skills-dir`. **The one thing that makes this work is `.claude-plugin/plugin.json`
coming with it** — copy the whole repo, not a hand-picked subset. Without that manifest the
directory is treated as a bare skill folder: `/drift` and `/website` still register, but the
orchestrator never loads, because a bare skill folder is scanned for a `SKILL.md` at its top
level and this plugin keeps its one at `skills/frontend-flow/SKILL.md`. That failure is
silent and looks like a working install, which is why it is worth knowing about.

So: **use the marketplace if you want `/plugin` to find this and to get updates when the
version is bumped. Use `--plugin-dir` or a skills-directory copy if you just want it to
run.**

## What's in it

| Piece | Type | Job |
|---|---|---|
| `frontend-flow` | skill | The full flow: preferences → constraints → build → verify |
| `/website <name\|url>` | command | Reference tokens only, no build |
| `/drift [dir]` | command | The design system already in your codebase |
| `/architecture [requirement]` | command | Which of 7 system architectures fits, and the trade-off it costs |
| `reference-scout` | subagent (sonnet) | Name → official URL |
| `frontend-builder` | subagent (inherit) | Tokens + preferences → files |

`/architecture` decides the shape. `/website` reads tokens off an external reference, `/drift` reads them off the project you already have, and the build step reconciles all three: the architecture sets what is being built, the reference supplies the design language, `/drift` supplies the constraints your codebase already imposes.

## Why `/architecture` refuses

Ask any model "what architecture for my app, it needs to be scalable and enterprise-grade" and you get microservices, a broker and a service mesh — because the model matches the ambition in the prompt. This one walks a table ordered cheapest-to-operate first and treats ambition words as non-signals. Real runs:

| Requirement | Answer |
|---|---|
| Solo dev, food delivery, *"scalable and enterprise-grade eventually"*, live driver tracking | **Layered monolith + one event channel.** "Scalable" moved nothing. The live tracking was the only real trigger — and for one developer that channel is Redis pub/sub, not Kafka. |
| Three teams, payments on a PCI release train, search at 50x read traffic, a legacy Oracle system | **Microservices + an anti-corruption adapter.** Every clause stated rather than inferred, so the expensive answer was earned. |
| Nightly PDF job, a webhook 20x a day, solo dev, nothing else running | **Serverless.** The webhook reads like an event and isn't one — 20 calls a day needs an HTTP handler, not a broker. |
| Backend settled, two frontend teams on React and inherited Vue, separate cadences | **Backend untouched; micro-frontend shell over it.** The deploy pressure was in the UI, so nothing licensed restructuring the backend. |

Every answer carries what you're accepting, and what would change it. The runner-up line is the one that earns its place: for the microservices case it names the read-replica option that collapses three splits into one.

## Measured: what the subagent split actually saves

Measured 2026-09-13 against `https://stripe.com/`, the flagship case for "build me something like X".

> **Read this before the numbers.** These rows measure an architecture that has since been
> replaced. At the time, `reference-scout` fetched the page and returned a token sheet
> itself; it now returns only a resolved URL, and `scripts/reference.mjs` does the
> extraction locally. The shape of the saving still holds — keep the bulk payload out of
> the main context — but the specific figures describe a path that no longer exists and
> have not been re-measured. Caveat 3 below is the honest summary: a script doing the
> extraction beats both measured paths.

**Payload sizes**

| Payload | Bytes | ~Tokens |
|---|---:|---:|
| Rendered page HTML | 700,904 | 175,226 |
| Linked CSS bundles (5 files) | 484,244 | 121,061 |
| Web search result | 1,236 | 309 |
| Returned token sheet | 424 | **106** |

**Cost per reference lookup**

| Path | Tokens into main context | Cost |
|---|---:|---:|
| Naive inline (page + CSS read in the main conversation) | 296,596 | $1.48 |
| `reference-scout` subagent | **106** | **$0.12** |

**99.96% less context** — the extraction still cost ~121k tokens, but they were spent inside a subagent that exits, instead of in a context you re-send every turn afterward. That part is the durable claim, and it holds regardless of which model runs the subagent.

The `$0.12` figure does not. It assumed the scout ran on Haiku, and **the scout now runs on Sonnet** — see below for why — so the per-lookup cost is higher than that row says and has not been re-measured. Treat the cost column as historical; the context column is the point.

### Method, and what this number is not

Token counts are `bytes / 4`, not exact — measuring this machine had no API credentials for `messages.count_tokens`. Markup tokenizes denser than prose, so the real counts are likely higher and the ratio roughly holds. Prices were Anthropic first-party list rates as of 2026-06-24, for the Haiku-based routing that existed then.

**Why the scout is no longer on the cheap model.** Given a genuinely ambiguous brand name — `Arc`, which is a browser, a developer-hiring site and an outdoor-clothing brand — Haiku silently picked one and reported it as settled, across two separate sessions, byte-identically. The definition has always told it to name competing candidates instead of choosing silently; that instruction simply never fired. Holding the prompt fixed and changing only the model made it fire immediately. So this was never a prompt problem, and rewriting the instructions would have been work against the wrong cause.

The failure it prevents is silent and expensive in a way a price table cannot show: design tokens scraped from the wrong company's site, with nothing in the output saying so. A few tenths of a cent per lookup is the wrong thing to optimise against that.

Four honest caveats:

1. **One site, one run.** Stripe is representative of the sites people name as references, not of all sites.
2. **Re-send and caching are not modeled.** Context left in the main conversation is re-sent every turn, which makes the naive path worse than the table shows — but prompt caching discounts those re-sends by an amount this measurement didn't isolate.
3. **A disciplined inline implementation beats both.** Piping the CSS through `scripts/drift.mjs` locally and reading only the 554-token summary costs about $0.004 — cheaper than the subagent, because grep does the extraction instead of a model. The scout's real value is the judgment either way: resolving a bare name to the right URL, and picking five brand colors out of 96 clusters. It is not a magic token saver over a careful script.
4. **This measured the architecture that caveat 3 argues against — and which has since been replaced.** At the time, `reference-scout` fetched the page and returned the token sheet itself. It now returns only a resolved URL, and `scripts/reference.mjs` does the extraction. The rows above describe the path that was retired and have not been re-measured.

## Measured: why the scanner reads stylesheets instead of summarizing the page

The same run turned up something worth stating plainly. Asked to extract design tokens from `stripe.com`, `WebFetch` returned:

```
Color Palette   Not inferable - no hex colors visible
Typography      Not inferable
Motion Cues     Not inferable
```

The raw HTML for that same page contains **66 distinct hex colors**, and the linked CSS bundles contain **262**. The summarizer discarded them.

Fetching the stylesheets directly recovers the genuine design system:

```
#635bff   Stripe's brand purple
#0a2540   navy ink
#32325d   slate
#f6f9fc   page background
sohne-var Söhne, their actual typeface
```

This is the finding the whole design rests on, and it is why `scripts/reference.mjs` fetches the raw HTML and its linked stylesheets itself rather than asking a model to look at the page. Markdown conversion drops `<head>`, which is exactly where the stylesheets are referenced — so a summarizing fetch cannot see the design system even in principle.

When the stylesheets genuinely yield nothing — a site that defines every value as `var(--x)` with the definitions loaded from JS — the scanner prints a `NOTE:` saying the reference is not statically extractable, and the flow reports that instead of filling the gap with invented values. On the single most likely reference site, the naive fetch path returns nothing usable and the scanner returns 262 colors.

> **Note:** `reference-scout` used to do this fetching itself. It no longer does — it resolves a name to a URL and nothing else. The extraction moved into the scanner, for the reason in caveat 3 below.

## Measured: motion, and the trap in it

Run across six animation-heavy sites (Linear, Vercel, emilkowal.ski, Framer, GSAP, Lusion).

`drift.mjs` separates **transitions** (hover, focus, state change — how the interface feels) from **keyframe animations** (effects). That split matters more than it sounds:

| Site | Transitions | Keyframe families | Reduced motion |
|---|---|---|---|
| vercel.com | 332 decls, median 200ms | 59 | **honoured** |
| lusion.co | 72 decls, median 400ms | 2 | not handled |
| emilkowal.ski | 30 decls, median 150ms | 7 | not handled |
| gsap.com | 30 decls, median 200ms | 0 | not handled |
| framer.com | 5 decls | 5 (3 unused) | not handled |
| linear.app | **0 — JS-driven** | 4 (3 decorative) | not handled |

**`prefers-reduced-motion` is unhandled on 5 of 6**, including the two sites whose business is animation.

### The Linear trap

Linear reports 76 `@keyframes` and, before the family fix, 301 motion declarations at a median of 2800ms — a confident-looking profile that was entirely a **decorative background grid of blinking dots**, one generated animation per dot:

```
animation: grid-dot-0-0-upDown 2800ms steps(1, end) infinite
```

Collapsing generated names (`grid-dot-#-#-upDown`) into families reduces 76 keyframes to 4 and marks three `[decorative]`. What's left is the honest answer: `TRANSITIONS 0 declarations - no interaction motion in CSS`. The crisp ~150ms feel people mean by "make it like Linear" is driven from JS and is not statically recoverable. Reporting nothing is correct; reporting the dot grid was not.

### Extracting an animation you liked

`--animations` prints each keyframe with the timing it's used with, ready to paste:

```
popoverEnter
used 1x, 150ms, ease-out

@keyframes popoverEnter {
  0% { opacity:0; transform:scale(.9) }
  to { opacity:1; transform:scale(1) }
}
.your-element { animation: popoverEnter 150ms ease-out both; }
```

On a JS-animated site it says so instead of inventing something: `No @keyframes found. This site animates from JS, not CSS.`

## Known limitations

- **`color-mix()` is not resolved.** Measured on Vercel: of 169 occurrences, 79 are the compiler artifact `color-mix(in lab, red, red)` and the rest reference `var(--ds-*)` tokens that can't be resolved statically. Parsing it would recover close to nothing, so it isn't parsed.
- **Fully variable-driven sites yield nothing.** Linear declares every color as `var(--color-brand-bg)` with the definitions outside the fetched files, so it reports 0 colors. That is the correct answer, not a bug — but it means "no colors found" can mean "tokenized elsewhere" rather than "no design system".
- **Spacing is raw.** Hundreds of px values with no layout context. Useful for spotting off-scale drift in your own code, not for copying a reference's rhythm.
- **System and locale font stacks read as design.** Pages serving CJK fallbacks report `Hiragino Sans`, `Yu Gothic UI` and similar as distinct families.

## Reproducing

```bash
curl -sL https://stripe.com/ -o page.html
grep -oE 'https://[^"]+\.css' page.html | sort -u | head -6 | xargs -I{} curl -sL {} -O
node scripts/drift.mjs .
```

`node scripts/drift.mjs . --animations` prints reusable keyframes.
`node scripts/drift.mjs --selftest` runs the color, clustering, and motion-parsing assertions.

## License

MIT
