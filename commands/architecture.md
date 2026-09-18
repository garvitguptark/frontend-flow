---
name: architecture
description: Pick the system architecture that fits a requirement — monolith, microservices, SOA, event-driven, serverless, layered, or micro-frontend — and then either just recommend it with the trade-off you're accepting, or scaffold it. Use for "what architecture should I use", "should this be microservices", "design the backend for X", or when a build request implies a structural decision nobody has made yet.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

Take the requirement (the argument, if one was given — otherwise the request already in the conversation, otherwise ask for it in one line), map it to one of the seven architectures below, and say which and why. Then ask whether to build it.

Do not run a discovery questionnaire. Most requirements already answer most of this, and the rest defaults safely.

## Step 1 — Read the signals

Six signals decide it. Take each from the requirement if it's there; otherwise use the default and say you assumed it, rather than asking.

| Signal | Default if unstated |
|---|---|
| Team size / number of teams | one team |
| Do parts need to deploy independently | no |
| Real-time or async reaction to things happening | no |
| Traffic shape — steady, spiky, or near-zero between bursts | steady |
| Existing systems that must be integrated, not rewritten | none |
| Is the split in the **frontend** (separate UI teams shipping separately) | no |

If two or more are genuinely unknown *and* they would change the answer, ask once with `AskUserQuestion` — one call, not a sequence. Otherwise proceed on defaults.

## Step 2 — Pick

Two kinds of row, and the difference is the whole method:

- **Base shapes — rows 1, 2, 3 and 6.** Mutually exclusive. Walk *these four only*, top to bottom, and take the first whose trigger is met. The order is not arbitrary: it runs cheapest-to-operate first, so the expensive shapes have to earn the row above them.
- **Modifiers — rows 4, 5 and 7.** Not part of that walk. Add any whose trigger fires, onto whichever base you landed on.

A modifier firing never short-circuits the walk. If row 5 fires because of one legacy system, that is an adapter, not the shape of the whole system.

**A trigger is not enough on its own — read the trade-off column before you stop on a row.** If the cost in that column is fatal for this particular requirement, the row did not really fire and you keep walking. The live example: a service that provisions environments on a GitHub webhook and sits idle the rest of the day matches row 3's trigger word for word, but provisioning takes minutes and row 3's stated cost is execution limits. It belongs on row 1 or 2 with a job queue. Say out loud when you rejected a row this way, so the reasoning is checkable.

| # | Architecture | Trigger — pick it when | What you are accepting |
|---|---|---|---|
| 1 | **Monolith** | Nothing in rows 2, 3 or 6 is triggered. Rows 4, 5 and 7 compose, so they do *not* rule this out. One team, one deploy, MVP or early product. | Gets hard to scale and to keep clean as it grows. Instagram started here. |
| 2 | **Layered (n-tier)** | Same as monolith, but the domain is non-trivial and you want presentation / business logic / data access to stay separable. | Still one deploy. Rigidity, and a change often touches every layer. |
| 3 | **Serverless** | Spiky or near-zero-baseline traffic — scheduled jobs, webhooks, bots, prototypes — **and each unit of work finishes in seconds.** Idle-plus-long-running is not this row. | Cold starts, vendor lock-in, execution limits, awkward local dev. |
| 4 | **Event-driven** | The system has to *react* — real-time updates, fan-out to several consumers, async workflows that must not block. Ride updates, activity feeds. | A broker to run — Redis pub/sub for one team, Kafka only once volume forces it. Eventual consistency, and debugging across hops is genuinely harder. |
| 5 | **SOA** | Existing systems you must integrate rather than rewrite — a reservation system, a core banking ledger. | Coarse services and a bus in the middle. Heavier than microservices per change. |
| 6 | **Microservices** | Multiple teams that must deploy independently, and services with genuinely different scaling profiles. | Real operational cost: service discovery, distributed tracing, network failure as a normal case. Do not pick this for one team. |
| 7 | **Micro-frontend** | The split is in the **UI**: separate frontend teams, or modules on deliberately different stacks, shipping on their own cadence. | Duplicated deps, bundle bloat, and shared state across apps becomes a design problem of its own. |

Modifiers compose onto **any** base, row 6 included. An event-driven monolith is a normal, good answer; so is microservices with an SOA-style anti-corruption adapter in front of one legacy system. Say the combination when it applies instead of forcing a single label.

**The default is row 1 or 2, and that is usually correct.** A requirement mentioning scale, growth, or "enterprise-grade" is not a trigger; a stated number of teams or a stated independent-deploy requirement is. If you are about to recommend microservices to one developer, re-read the table — you skipped a row.

For a brownfield project, check what is already there before picking (`docker-compose.yml`, `serverless.yml`, workspaces in `package.json`, Module Federation config, a `controllers/services/repositories` layout, a Kafka or RabbitMQ dependency). Matching the architecture that exists beats the one that scores best on paper — say that plainly if the two disagree.

## Step 3 — Report it

Four lines, no more:

```
Architecture:  <name>
Because:       <the one signal that triggered it>
Trade-off:     <what they are accepting, from the table>
Runner-up:     <the nearest real alternative, and the signal that would flip it — often
                the row *above*, or the same base with a composed row dropped, not the
                next row down>
```

The runner-up line matters more than it looks — it is what makes the recommendation falsifiable instead of an oracle pronouncement. Name the condition that would change your answer.

## Step 4 — Offer to build

Ask with `AskUserQuestion`: **Scaffold it** / **Recommendation only** / **Show me the runner-up first**. (`AskUserQuestion` adds its own "Other" — do not write one in.)

On **Scaffold it**, write the minimum that makes the shape real and runnable. Not a reference implementation:

| Architecture | Minimum scaffold |
|---|---|
| Monolith | One app, one entrypoint, one datastore. No `src/core/` ceremony. |
| Layered | The layer directories, with one real path wired end to end through all of them. |
| Serverless | One function, its handler signature, and the config that deploys it. |
| Event-driven | One producer, one consumer, the broker in compose, and the event's schema. |
| SOA | The service contract and one adapter against the system being integrated. |
| Microservices | **Two** services, not seven. Their contract, and how they find each other. |
| Micro-frontend | The shell and one remote, with the boundary they share made explicit. |

Plus a short `ARCHITECTURE.md` — the four lines from Step 3, and the one rule a future change has to respect. Nothing longer; an architecture document nobody reads is worse than none.

**Scaffold inline in every case, frontend included. Do not invoke `frontend-builder` from this command.** A micro-frontend scaffold is a shell, one remote, the composition mechanism and the boundary contract — plumbing, not design. That agent requires a token report and a motion level as inputs (`agents/frontend-builder.md` says so outright), and `/architecture` produces neither, so calling it from here means handing it nothing or inventing its inputs.

Give a frontend scaffold only enough CSS to make the boundary visible. The design pass is a separate step: the `frontend-flow` skill runs it once a reference has been scanned and a motion level chosen, and it builds into the shell you leave behind.

Prefer the composition mechanism the platform already has. Import maps plus custom elements give runtime composition with no build step and no dependency; reach for Module Federation only when remotes need shared-dependency deduplication, which is a toolchain to maintain rather than a default.

## Token discipline

The picking is a table lookup, not research, so it runs inline on whatever model is already loaded — no subagent, no web search, no framework comparison. This whole file only enters context when `/architecture` is invoked. The two paths that genuinely are expensive (a real frontend build, a reference token scan) already route to their own agents elsewhere in this plugin. If a scaffold turns into a large multi-service build, hand it off rather than growing it in the main conversation.

## Boundaries

- One architecture, named. Not a comparison matrix of all seven — they asked which one, and a survey is how you avoid answering.
- Do not scaffold before Step 4. Someone asking what architecture fits has not asked for files yet.
- Do not add a broker, a queue, a service mesh, or a second service that no signal triggered. Every row below 2 costs real operational time, forever.
- Say when the honest answer is "start with row 1 and split later if X happens." Premature microservices is the most expensive mistake in this table, and it is the one the word "scalable" in a requirement talks people into.
- Name the trade-off every time. An architecture recommendation without its cost is marketing.

## Relationship to the rest of this plugin

`/website` and `/drift` supply the *design* constraints — tokens from a reference, tokens from your codebase. `/architecture` supplies the *structural* one, and it runs first when the shape has not been decided: a micro-frontend answer changes what the `frontend-flow` build step is even building. For a plain single-page site, skip it — the answer is row 1, and you already knew that.
