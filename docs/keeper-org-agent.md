# Keeper: a durable organizational agent for Buzz

Status: **Draft for discussion** · 2026-10-05 · Working name: *Keeper* (each
organization picks the display name and avatar) · Decided so far: the durable
research agent ships first (D3), and the code lives in a `keeper/` package in
this repository (D2)

Builds on:
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)
(1.0.x, experimental) ·
[practical information flow for Buzz agents](practical-information-flow-for-buzz-agents.md)
(draft) · [NIP-AR channel artifacts](nips/NIP-AR.md) ·
[remote agents](remote-agents.md) · [VISION.md](../VISION.md)

> **TL;DR.** Keeper is one agent shared by the whole organization. It is a
> normal Buzz member with its own key: it listens where it has been let in,
> remembers durably, turns discussion into decisions and action items, and does
> work people ask for in plain language — research, tracking tasks, reminders,
> automations. Inside, a trusted **broker** holds the key and enforces
> information-flow rules, and one **pi-durable harness per audience** runs the
> conversations. Every model turn, tool call and queued message is committed
> before it is shown, so a crash or redeploy resumes work instead of losing or
> repeating it. Keeper never tells anyone something they could not already read
> in Buzz, and it never publishes private information more widely without a
> human approving the exact text. It ships in phases, each useful on its own.
> The first product is a durable research agent built on Keeper's
> foundations; org memory, workspace management, and scale and governance
> follow.

## Contents

1. [The problem](#1-the-problem)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Principles](#3-principles)
4. [The experience](#4-the-experience)
5. [Architecture overview](#5-architecture-overview)
6. [Identity, presence and access](#6-identity-presence-and-access)
7. [Listening: subscriptions and routing](#7-listening-subscriptions-and-routing)
8. [The durable runtime](#8-the-durable-runtime)
9. [Information flow and authority](#9-information-flow-and-authority)
10. [Org memory: the ledger](#10-org-memory-the-ledger)
11. [Tools, MCP, skills and sandboxes](#11-tools-mcp-skills-and-sandboxes)
12. [Workspace management](#12-workspace-management)
13. [Extensibility](#13-extensibility)
14. [Configuration and governance](#14-configuration-and-governance)
15. [Deployment and operations](#15-deployment-and-operations)
16. [Phased delivery](#16-phased-delivery)
17. [Testing and validation](#17-testing-and-validation)
18. [Decisions needed and open questions](#18-decisions-needed-and-open-questions)
19. [Appendices](#appendices)

**Reading guide.** To decide whether to build this, read §1–4, §16 and §18.
To build it, read §5–15 and §17. §9 (information flow and authority) is the
part every reviewer should read.

---

## 1. The problem

People and agents in Buzz already work things out in channels and threads.
The decisions, commitments and good ideas made there then scroll away:

> Monday in `#launch`, Priya and Marco agree to move the beta to October 20.
> Marco says he will update the pricing page. Someone suggests checking what
> competitors charge. Nobody writes any of it down. On Thursday the pricing
> page is stale, the research never happened, and a new teammate asks "when is
> the beta?" in `#general`.

Today's Buzz agents cannot fix this, for reasons that are structural rather
than a matter of prompting:

| Limitation today | Where | Consequence |
|---|---|---|
| Agents are **personal**: DMs are admitted only from the owner or sibling agents, and memory (NIP-AE) is encrypted per agent–owner pair. | `crates/buzz-acp/src/lib.rs`, [NIP-AE](nips/NIP-AE.md) | Nobody can give an agent to the whole organization. |
| Sessions are **in memory**. A restart drops them; a new session rebuilds its context from 12 messages (`BUZZ_ACP_CONTEXT_MESSAGE_LIMIT`). | `crates/buzz-acp/src/pool.rs`, `config.rs` | Work in flight is lost; long threads are forgotten. |
| Agents react to **mentions**. The `all` mode turns every message into a full model turn; there is no "listen and remember" path. | `crates/buzz-acp/src/config.rs`, `lib.rs` | No condensation without burning a turn per message. |
| The agent process **holds the signing key** (`BUZZ_PRIVATE_KEY` reaches the agent and its tools). | `crates/buzz-acp/src/acp.rs`, `base_prompt.md` | A prompt-injected agent can publish anything, anywhere — the confused-deputy problem in the [information-flow draft](practical-information-flow-for-buzz-agents.md). |
| The harness **never posts the answer**; the model must remember to run `buzz messages send`. | `crates/buzz-acp/src/base_prompt.md` | Silent failures when it forgets. |
| The harness's own scheduling is a **heartbeat prompt** with no channel context. Workflow cron can wake an agent only by posting in a channel. | `crates/buzz-acp/src/config.rs`, `crates/buzz-workflow` | No reliable follow-ups or personal reminders. |

The organization needs one agent that everyone can talk to in plain language.
It should remember across days, notice what was decided and promised, and turn
intent into finished work — without leaking what one group discussed privately
to another.

---

## 2. Goals and non-goals

**Goals**

| # | Goal |
|---|---|
| G1 | Anyone in the organization can ask Keeper for something in plain language, in any thread or DM where Keeper is present, and get a visible, durable result. |
| G2 | **Durable:** no accepted request is lost or answered twice across crashes, deploys or restarts. |
| G3 | **Multiplayer:** Keeper works with several people in one thread. Anyone present can add context, redirect it, or stop it mid-task. |
| G4 | **Org memory:** Keeper condenses discussion into decisions, action items, open questions and summaries, each linked to its sources, which people can see and correct. |
| G5 | **Execution:** Keeper researches, tracks tasks, reminds, drafts automations and delegates, asking a human before anything consequential. |
| G6 | **Safe by construction:** Keeper never discloses information to someone who could not already read it in Buzz, and never acts beyond the authority of the people it acts for. |
| G7 | **Extensible:** admins add MCP servers, skills and packs by configuration; developers add capabilities as pi-durable extensions, without forking Keeper. |
| G8 | **Incremental:** each phase ships something useful and leaves clean seams for the next. |

**Non-goals** (for now)

- A privileged reader that bypasses channel membership. The relay has no such
  reader today and the vision rules it out: "Channel membership is the only
  gate" ([VISION.md](../VISION.md#access)).
- Reading human-to-human DMs, or private channels Keeper was not invited into.
- Replacing the workflow engine. Keeper drafts and triggers workflows; it does
  not reimplement them.
- Solving prompt injection in general. Keeper contains its consequences with
  information-flow rules, authority checks and approvals (§9).
- Memory shared across communities. Each community is its own world.
- A new management plane. Status, steering and shutdown stay on the relay, as
  for remote agents ([VISION_REMOTE_AGENTS.md](../VISION_REMOTE_AGENTS.md#the-only-tether)).

---

## 3. Principles

| Principle | What it means for Keeper | Traces to |
|---|---|---|
| **Buzz is the pipe, not the brain.** | Keeper is a relay client with its own key. Relay changes it needs are generic features (kinds, rate tiers), never a "Keeper mode". | [VISION.md](../VISION.md) |
| **Membership is the only gate.** | Keeper reads only what the relay's membership rules let any member in its position read. Admins decide where it is present, and its presence is visible. | [VISION.md § Access](../VISION.md#access) |
| **Keeper only tells you what you could already read.** | A result may go to a destination only if everyone there could read every input (`A(dest) ⊆ R(info)`). Wider release needs a human to approve the exact text. | [Information-flow draft](practical-information-flow-for-buzz-agents.md) |
| **Zero noise by default.** | Keeper speaks when asked. Proactive behaviour is opt-in per channel and per person. | [VISION.md § Home Feed](../VISION.md#home-feed--notifications) |
| **The relay is the record; the runtime is the engine.** | Everything people see or decide — answers, memory, tasks, approvals — lives on the relay as signed events. The pi-durable store keeps work in flight and could be lost without losing the record. | "Durable knowledge belongs on the relay" ([VISION_REMOTE_AGENTS.md](../VISION_REMOTE_AGENTS.md#honest-costs)) |
| **Visible work.** | Every action reads as a sentence — verb, object, outcome. Waiting and failure are shown, never silence. | [VISION_ACTIVITY.md](../VISION_ACTIVITY.md) |
| **Humans decide consequential things.** | Approvals are signed events from people with the authority to give them. | [VISION.md § Workflows](../VISION.md#workflows) |
| **Configuration as code.** | Organization settings, skills and packs live in a git repository on the relay and are reviewed like code. | [VISION_PROJECTS.md](../VISION_PROJECTS.md) |

**Tensions this design accepts on purpose**

1. *"Free access" versus membership.* Keeper gets broad access the honest
   way. Admins add it to channels or let it read every open channel (the relay
   already allows any member to read open channels). Private channels invite it
   explicitly. DMs reach it when people write to it. There is no hidden read
   path (§6).
2. *Always-on versus self-reaping.* Remote agents are built to exit after
   inactivity, and the Kubernetes provider refuses "never stop"
   (`crates/buzz-backend-kubernetes/src/config.rs`). Keeper is a *resident*
   agent with persistent state, so it needs a deployment class of its own
   (§15).
3. *Org-wide condensation versus privacy.* There is no single org brain that
   mixes everything. Keeper condenses per audience: the org-wide digest draws
   only on open channels, while one person's briefing can draw on everything
   that person can read (§9, §10).

---

## 4. The experience

### 4.1 Who uses Keeper

| Who | How |
|---|---|
| Everyone | @mention Keeper in a thread, DM it, react to its proposals, tell it to stop. |
| Channel members and admins | Choose how talkative Keeper is in their channel; invite it to private channels. |
| Workspace admins | Turn Keeper on, decide where it listens, connect tools (MCP), approve packs, set budgets and approvers. |
| Developers and operators | Write packs and extensions; deploy, monitor and upgrade Keeper. |

### 4.2 Scenarios

Each scenario names the phase (§16) that delivers it.

1. **Catch me up** (P1). In a 200-message thread: "@Keeper what did we decide,
   and who is doing what?" Keeper replies in the thread with the decisions,
   owners and open questions, each linked to the message it came from.
2. **Steer it while it works** (P1). Priya asks Keeper to draft the launch FAQ.
   While it works, Marco writes "use October 20, not the 13th". Keeper picks
   that up after its current step, without starting over. Anyone in the thread
   can say "stop".
3. **Durable research** (P1). "@Keeper find out what our top five competitors
   charge for team plans; report by Friday." Keeper posts a plan, works in the
   background for hours, survives restarts, posts progress, delivers a report
   in the thread, and answers follow-up questions there.
4. **Remember for the channel** (P2). In channels that opted in, Keeper keeps a
   running tracker of decisions, action items and open questions, each linked
   to its source. Anyone in the channel can confirm, edit or dismiss an item.
5. **My briefing** (P2). In a DM: "Every weekday at 9, tell me what needs my
   attention." Keeper sends a short briefing drawn only from channels that
   person belongs to.
6. **Turn talk into tracked work** (P3). After a planning thread Keeper asks:
   "I found three action items — track them?" A ✅ creates the tasks with
   owners and due dates. Keeper reminds owners and reports completion back to
   the thread.
7. **Automations in plain language** (P3). "Every Monday, post a summary of
   `#sales` wins to `#leadership`." Keeper drafts a Buzz workflow, shows it in
   plain words, and has the right person sign it. Each Monday the workflow wakes
   Keeper. If `#sales` is private, its content cannot reach `#leadership`
   unannounced: Keeper asks a `#sales` member to approve each summary before
   posting it (§9.5).
8. **Delegate to specialist agents** (P3). "Ask the coding agent to fix the
   broken link on the pricing page." Keeper mentions the agent in the right
   channel, tracks the result, and reports back.

### 4.3 The interaction contract

This is the promise Keeper makes to every user, in plain language:

- **It answers where you asked.** It does not post anywhere else unless you ask
  and the right person approves.
- **It shows what it is doing:** 👀 when it has seen your message, typing while
  it works, a progress note on long tasks, and a final answer with sources.
- **It asks before anything consequential:** posting in other channels,
  messaging people, creating automations, spending past a budget, or using an
  external tool that writes.
- **Anyone in the thread can steer or stop it.**
- **It never tells you something you could not read yourself.** If an answer
  needs information from somewhere you cannot see, it says so instead of
  hinting.
- **It is transparent about memory.** Ask "what do you know about this
  channel?" or "what do you remember about me?" and it shows you. Ask it to
  forget and it does.

Some phrases are handled by Keeper's own code, never by the model, so they
always work:

| Say to Keeper | Effect | Who may |
|---|---|---|
| `stop` | Aborts the current work in this thread and withdraws queued requests. | Anyone in the conversation |
| `status` | What Keeper is doing here, what is queued, what it has spent. | Anyone in the conversation |
| `forget this thread` | Resets the thread's context and retracts memory derived only from it. | Anyone in the conversation, with confirmation |
| `quiet` / `normal` / `proactive` | Sets how talkative Keeper is in this channel (§14.2). | Channel owners and admins |
| `leave` | Keeper leaves the channel. | Channel owners and admins |

---

## 5. Architecture overview

Keeper is one service with a trusted outer layer and untrusted inner workers.
The outer layer talks to the relay, holds the key and enforces policy. The
inner workers are model-driven conversations that can act only through tools.

```mermaid
flowchart LR
    relay["Buzz relay<br/>(one community)"]
    subgraph keeper["Keeper service"]
        gateway["Gateway<br/>connections · cursors · outbox"]
        router["Router<br/>attention rules"]
        broker["Broker<br/>key · labels · authority · approvals"]
        domains["Domain harnesses<br/>pi-durable, one per audience"]
        ledger["Ledger<br/>labeled memory index"]
        scheduler["Scheduler<br/>timers · cadences"]
        registry["Extension registry<br/>Buzz tools · MCP · skills · packs"]
    end
    sandboxes["Sandboxes<br/>one per audience"]
    mcp["MCP servers"]
    models["Model providers<br/>pi-ai · Buzz Mesh"]

    relay -- "verified events" --> gateway --> router --> domains
    domains -- "semantic actions" --> broker -- "checked, signed events" --> gateway -- "publish" --> relay
    domains <--> ledger
    scheduler --> domains
    registry -. "tools, sections, hooks" .-> domains
    domains -- "commands, files" --> sandboxes
    domains -- "tool calls" --> mcp
    domains --> models
```

| Component | Responsibility | State it owns | Trust |
|---|---|---|---|
| **Gateway** | NIP-42 auth; channel subscriptions; backfill/live overlap; cursors; dedupe; publishing with retry. | Relay connections; per-channel cursors (control store). | Trusted |
| **Router** | Decides what each event means: ignore, memory intake, context for a conversation, a request, a control phrase, an approval. | Routing rules from configuration. | Trusted |
| **Broker** | Derives audiences from relay state; checks every read and publish (§9); checks authority; runs approvals; constructs and signs events. | **Keeper's private key**; membership cache; approval grants. | Trusted — the only holder of the key |
| **Domain manager** | Maps each audience to its domain harness; opens, suspends, resumes and rotates them. | Domain registry (control store). | Trusted |
| **Domain harness** | A pi-durable `Harness` for one audience: conversations, runs, tasks, documents. | One SQLite file per domain. | Trusted code driving an untrusted model |
| **Ledger** | Labeled org memory: writes NIP-AR records, indexes them, answers label-filtered searches (§10). | A derived index per domain, rebuildable from the relay. | Trusted |
| **Scheduler** | Durable timers and cadences; wakes suspended domains. | Wake table (control store). | Trusted |
| **Extension registry** | Tools, prompt sections, hooks and tasks from Keeper core, packs and MCP adapters. | Code and configuration. | Trusted code; configured content |
| **Sandboxes** | Run commands, files and stdio MCP servers for one audience. | A workspace volume per audience. | **Untrusted** |

**One request, end to end.** Priya posts "@Keeper what did we decide?" in a
thread in the private channel `#launch`:

1. The gateway receives the event on its `#launch` subscription.
2. The router sees a mention: a *request* for the thread's conversation in the
   `#launch` domain.
3. The domain manager opens the `#launch` harness if it was suspended, and finds
   or creates the thread's conversation, backfilling the thread's earlier
   messages.
4. pi-durable commits the request before anything else happens. Keeper reacts
   with 👀 and shows typing.
5. The model calls `read_thread` and `ledger_search`. The broker checks each
   read against the `#launch` audience.
6. The model's answer is committed. The outbox signs it through the broker and
   publishes it to the thread exactly once (§8.5).
7. If the process dies at any point, reopening the domain resumes from the
   last commit.

**The model is never trusted.** It sees only its own conversation's context
and acts only through tools. Tools that touch Buzz go through the broker,
tools that execute code run in the audience's sandbox, and the key never
leaves the broker.

**Process model.** Phase 1 runs every component in one Node.js process per
community. Later phases split a coordinator (gateway, router, broker,
scheduler) from domain workers (§15.4).

**Where the code lives.** A new TypeScript package, `keeper/`, in this
repository as a pnpm workspace member. It depends on the published
`@earendil-works/pi-durable`, `pi-ai`, `pi-mcp` and `chord` packages at exact
pinned versions.

- *TypeScript* because pi-durable is TypeScript and Buzz already ships
  TypeScript (desktop, web).
- *This repository* because Keeper must change in lockstep with kinds, relay
  limits, information-flow rules and desktop rendering, and can reuse Buzz's
  fixtures, local relay and CI.
- Fixes Keeper needs in pi go upstream (Appendix C).

---

## 6. Identity, presence and access

### 6.1 Keeper's identity

- **Its own keypair**, a kind:0 profile, and a kind:10100 agent profile with
  `channel_add_policy` set to `anyone`, so any member can add Keeper to a
  channel they are in. Private channels still need an existing member to add
  it. Keeper holds the `bot` role in every channel. It self-adds to open
  channels with a kind:9000 carrying `role=bot`, as
  [`examples/countdown-bot`](../examples/countdown-bot/README.md) does. People
  who add it to private channels give it the same role, which is not an
  elevated role, so any member may grant it.
- **Owned by the organization, not by a person.** Keeper is admitted as a relay
  member in its own right, either by an admin (NIP-43 kind:9030) or with
  `buzz-admin add-member`. It does not use a NIP-OA attestation tied to one
  human, for two reasons:
  - If that person left the company, Keeper would be cut off.
  - Under NIP-AA virtual membership, banning the owner also bans the agent.

  Keeper's profile can still say who operates it.
- **SSO communities.** Where NIP-FI is enforced, Keeper needs an issuer
  assertion. NIP-FI admits client-subject (`at+jwt`) tokens for service
  identities. It also caps each connection's lifetime and offers no in-band
  renewal, so the gateway reconnects before the deadline (§7.2).
- **Key custody.** The broker loads the key from the deployment's secret store
  and is its only holder. The key never appears in an environment variable a
  child process could inherit, in a sandbox, or in a tool result.
- **Rate tier.** The relay allows agents 120 stored events per minute. Elevated
  (300) and platform (600) tiers are configured but never assigned
  (`crates/buzz-auth/src/rate_limit.rs`). Phase 1 paces itself. Assigning a
  higher tier to Keeper is a relay ask (Appendix C).

### 6.2 Where Keeper can read

Relay facts this section relies on:

- **Open channels:** any admitted member can read every open channel, history
  and live, without joining. The accessible set is memberships plus all open
  channels (`get_accessible_channel_ids` in
  `crates/buzz-db/src/store/channel_members.rs`).
- **Private channels and DMs** require membership.
  - Only an existing member can add Keeper to a private channel.
  - DMs are channels whose participant set never changes; adding a person
    creates a new DM.
- **No privileged readers.** Community owners and admins get no extra read
  access.
- **Unreadable kinds.** Some kinds are never readable by anyone but their
  author or addressee: reminders, observer frames, other agents' engrams.

So "free access to the workspace" breaks down like this:

| Space | Keeper reads it when | How it gets there | Visible to members |
|---|---|---|---|
| Open channels | Its observation mode includes them | Joins itself (kind:9000, `role=bot`) or reads without joining | Joining shows Keeper as a member and posts a "joined" row |
| Private channels | A member adds it | That member adds Keeper (kind:9000, `role=bot`) | Yes |
| DMs and group DMs with Keeper | Someone writes to it or includes it | The person opens the DM | Yes |
| DMs between humans | Never | — | — |
| Forums, canvases, artifacts | Same as their channel | — | — |
| Profiles, repos, projects, long-form notes | Always (they belong to no channel) | — | — |

**Observation modes** are an admin setting (§14). Whatever the mode, people
must be able to see where Keeper listens.

| Mode | Behaviour |
|---|---|
| `member` (default) | Keeper observes only channels where it is a member. An admin may add it to every open channel. Visible and consent-based. |
| `open-read` (opt-in) | Keeper observes every open channel without joining, which the relay already permits. Requirements:<ul><li>Keeper announces this once in a workspace-wide channel.</li><li>It answers "where are you listening?"</li><li>The desktop shows an indicator in observed channels (Phase 2).</li><li>New open channels are found by polling kind:39000, because channel metadata is not pushed to global subscriptions.</li></ul> |
| Opt-outs | Channel admins can set `quiet` or tell Keeper to `leave`. An admin deny list excludes channels entirely. |

### 6.3 Whom Keeper answers

- **Members.** Any community member who can post where Keeper is present. Personal
  agents default to `owner-only` (`crates/buzz-acp/src/config.rs`); Keeper's
  default is everyone.
- **Guests.** They can talk to Keeper in their channels, but their requests are
  limited to read-and-reply actions (§9.4).
- **Other agents.** Ignored as triggers by default, which prevents agent
  ping-pong. An admin allowlist enables specific agents, and a loop guard caps
  agent-triggered runs per thread per hour.
- **Workflows.** A relay-signed workflow message that mentions Keeper is a
  request from the workflow's owner. The relay stamps `buzz:workflow-owner`,
  and `buzz-acp` treats it the same way.

---

## 7. Listening: subscriptions and routing

### 7.1 What Keeper subscribes to

Every filter names its kinds explicitly: a filter without kinds trips the
relay's p-gate.

**Per channel** (`#h` filters, for every observed channel):

| Kinds | What | Keeper uses it for |
|---|---|---|
| 9, 40002 | Stream messages | Requests, conversation context, memory intake |
| 45001, 45003 | Forum posts and comments | Same as messages, in forum channels |
| 40003 | Edits | Replace the edited text in context; re-run intake |
| 5, 9005 | Deletions and moderator removals | Hide the message from context; retract memory derived from it |
| 7 | Reactions | Approvals on Keeper's cards, confirmations of memory items, feedback |
| 45010, 45011 | NIP-AR artifacts and their removals | The ledger and tasks (§10, §12), including human edits |
| 40100 | Canvas | A knowledge source, and documents Keeper maintains |
| 40099 | System rows (joins, leaves, renames) | Audience changes, context |
| 39000–39003 | Channel metadata, admins, members, roles (stored per channel) | Audience labels, epochs, routing |
| 40008 | Diffs | Project channels (project pack) |

Reactions and deletions without an `h` tag still match `#h` through the
channel they were stored in.

**Global** (filters on `#p` = Keeper, or channel-less kinds):

| Kinds | What | Keeper uses it for |
|---|---|---|
| 44100, 44101 | Member added or removed (`#p` = Keeper) | Open or close channel subscriptions; epoch changes |
| 0, 10100 | Profiles and agent profiles | Display names for attribution; agent detection |
| 1621, 1630–1633, 30617, 30618, 30621 | Issues, issue status, repos, repo state, projects | Project and workspace-manager packs (§12) |
| 48100–48103 | Huddle lifecycle | Meeting-notes pack (§12.6) |

**Not subscribed**:

- 20001 and 20002: ephemeral presence and typing.
- 24200 and 44200: other agents' observer frames and metrics, which are p-gated
  anyway.
- 30300: reminders, which only their author can read.
- 1059: gift wraps, which no Buzz client produces.

### 7.2 Subscription mechanics

**Batching.** The relay accepts 10 filters per REQ, 128 explicit `#h` values
per request and 1,024 subscriptions per connection
(`crates/buzz-relay/src/handlers/req.rs`, `protocol.rs`). A live subscription
is channel-scoped only if every filter has `#h`, and channel events are never
fanned out to global subscriptions. So the gateway:

- groups observed channels into REQs of up to 128 `#h` values;
- keeps one separate `#p` REQ for global kinds.

(`buzz-acp` opens one REQ per channel. Batching is an optimisation, not a
requirement.)

**Backfill and live must overlap** ([AGENTS.md](../AGENTS.md#review-proven-rules),
rule 2).

- Within one REQ the relay registers the live subscription before running the
  history query, so there is no gap. Duplicates are possible.
- Each filter returns at most 1,000 events (`DEFAULT_MAX_PAGE_LIMIT` in
  `crates/buzz-db/src/store/event.rs`; the 500 in ARCHITECTURE.md is stale).
- A larger backlog is paged with `until` + `before_id` keyset REQs while the
  live REQ stays open.

**Cursors replay with a 15-minute overlap.**

- *Problem.* The relay accepts any `created_at` within ±900 seconds of its own
  clock (`MAX_TIMESTAMP_DRIFT_SECS` in
  `crates/buzz-relay/src/handlers/ingest.rs`). An event stored now can
  therefore carry a timestamp up to 15 minutes old. A reconnect that replays
  from `last_seen − 5s`, as `buzz-acp` does (`SINCE_SKEW_SECS`), can miss it.
- *Solution.* Keeper keeps a per-channel high-water mark `(created_at, id)` in
  the control store. It advances the mark only after the router's effects for
  that event are committed, replays from `mark − 900s`, and drops duplicates by
  event id.

**Every effect is idempotent by event id.**

| Effect | How it is deduplicated |
|---|---|
| Conversation submissions | `requestId` = the event id; pi-durable deduplicates per conversation. |
| Memory intake | Keyed by event id. |
| NIP-AR records | Deterministic `d` values (§10.2). |

**Live delivery is best-effort.**

- *Problem.*
  - An `OK` from the relay means the event is stored. Fan-out happens afterwards.
  - A connection whose buffer fills is cancelled.
  - A failed Redis publish is only logged.
- *Solution.* The gateway runs a periodic reconciliation sweep per active
  channel: a finite REQ from the cursor. It catches anything live delivery
  missed.

**Connections.**

- Reconnect with jittered exponential backoff and re-authenticate with NIP-42,
  plus NIP-FI where enforced. Reconnect before the NIP-FI lifetime cap.
- Stay within 10 REQ/EVENT operations per second per connection (enforced as 50
  per 5 seconds) and 300 HTTP calls per minute.

**Membership changes** come from two sources. Kinds 44100/44101 are p-gated,
so they only ever report Keeper's own membership.

- *When Keeper is added to a channel* (44100): subscribe, and replay from the
  add event.
- *When it is removed* (44101): unsubscribe, drain the queue, and close the
  domain's conversations for that channel.
- *When anyone else joins or leaves:* the channel subscription delivers the
  updated member list (39002) and a system row (40099). The broker recomputes
  that channel's audience (§9.3).

**Keeper's own events** never trigger Keeper. They are taken in as context
where that helps, for example when a background research task posts its report
into a thread.

### 7.3 Routing: what each event means

| Event | Condition | Effect |
|---|---|---|
| Message (9, 40002, 45001, 45003) | Mentions Keeper (`p` tag), replies to a Keeper message, or is in a DM with Keeper | **Request** to that thread's or DM's conversation (§8.4) |
| Message | Is a control phrase addressed to Keeper (§4.3) | **Control**, handled by Keeper core, never the model |
| Message | In a thread Keeper is part of, not addressed to it | **Context** for that conversation |
| Message | In an observed channel | **Intake** for the channel's caretaker (§10.3); no model turn |
| Message | Relay-signed workflow message mentioning Keeper | **Request**; the requester is the workflow's owner |
| Message | Written by another agent | Not a trigger unless allowlisted; still context and intake |
| Edit (40003) | Target is in a conversation | **Context edit**: replace the target's text; re-run intake |
| Deletion (5, 9005) | Target is known | **Context edit**: omit the target; retract memory derived from it |
| Reaction (7) | On a Keeper approval card | **Approval** to the broker (§9.5) |
| Reaction (7) | On a Keeper memory proposal | Confirm or dismiss the item (§10.3) |
| Keeper's membership (44100/44101) | Keeper added or removed | Open or close the channel's subscription and conversations |
| Channel roster (39002, 40099) | Someone else joins or leaves | Recompute the audience; epoch rules (§9.3) |
| Artifact (45010) | A human edited a type Keeper tracks | Update the index; human edits win (§10.3) |

**Top-level mentions.** In stream channels a top-level message starts a topic.
Keeper replies in a thread rooted at the mention, as `buzz-acp`'s `thread`
policy does. The conversation key is *(channel, thread root)*.

**Busy conversations.** While Keeper works in a thread:

- A message *addressed* to Keeper in that thread **steers** the running work.
  It is placed after the current tool round.
- An *unaddressed* message there becomes **context** at the same boundary.
  Keeper sees teammates' remarks mid-task without restarting.
- Other threads run in parallel, because each is its own conversation.

**Fairness.** pi-durable's scheduler starts every eligible task and has no
concurrency cap. Keeper enforces its own limits on model access:

- a global semaphore;
- per-domain and per-requester caps;
- a visible queue position in `status`.

---

## 8. The durable runtime

### 8.1 Why pi-durable

**Problem.** Keeper's work spans seconds to days, and its process will die in
the middle of some of it: deploys, node drains, crashes.

**Example.** A research run is three tool calls into a fifteen-minute job when
its pod is rescheduled.

- *With `buzz-acp`:* the in-memory session and queue are gone, because the
  harness persists no state. The request is answered only if it happens to be
  delivered again. Any partial work is lost or repeated, and a message the
  agent already posted may be posted twice.
- *With pi-durable:* everything was committed before it was shown — the
  request, each model response, each tool call's intent and partial output.
  Reopening the storage resumes the run:
  - model requests are re-sent with the same pinned messages;
  - a tool call reruns only if it is declared `replay: "safe"`;
  - any other tool call returns an `interrupted` result carrying the output
    committed so far, so the model decides what to do.

**What Keeper uses from pi-durable** (see its
[README](https://github.com/earendil-works/pi/tree/main/packages/durable)):

| Feature | What Keeper uses it for |
|---|---|
| Conversations of immutable entries | One per thread or DM |
| Atomic commits | All-or-nothing writes |
| Typed documents | Keeper's own state next to each transcript |
| Tasks with checkpoints | Durable state machines that survive restarts |
| Submissions with `requestId` deduplication | Exactly-once intake |
| An inbox with steer, follow-up and write | Multiplayer timing |
| Hooks and extensions in a live-reloadable registry | Capabilities and policy |
| Compaction, reset with handoff | Long-lived conversations |
| Ownership-scoped abort | `stop` reaches exactly the right work |
| Background tasks | Research jobs, tickers |
| Per-conversation usage and cost | Budgets |
| Watchable views | Status and dashboards |

### 8.2 One harness per audience

**Problem.** One pi-durable Session for the whole organization would put every
channel's commits through one line. That includes streaming partial output,
which is committed up to every 100 ms per running generation. Audiences would
be separated only by code discipline, and everything would live in one
ever-growing file. pi-durable allows one process per storage, with no
cross-process locking.

**Solution.** Keeper runs one Session — one SQLite file — per *domain*. A
domain is an audience: the set of people allowed to see what happens inside
it.

| Domain | Audience | Holds |
|---|---|---|
| `public` | Every admitted member of the community | Threads in open channels; the steward conversation; caretakers of open channels |
| `channel:<uuid>` | Members of one private channel | Its threads; its caretaker |
| `dm:<uuid>` | The participants of one DM or group DM (fixed) | The DM conversation; for a 1:1 DM, that person's briefings |

This is the information-flow draft's "agent instance per audience", made
structural:

1. **No context crosses audiences.** No conversation, document or task in one
   domain can see another domain's state.
2. **Domains commit in parallel**, each on its own line.
3. **Idle domains suspend.** Keeper closes their harness and reopens it on
   demand; pi-durable resumes pending work on open.
4. **Domains shard.** Later phases spread them across worker processes (§15.4).
5. **Damage stays contained.** A corrupted or poisoned store affects one
   audience.

The cost is that coordination across domains goes only through the relay and
the ledger. That is what information flow requires anyway. Keeper also has to
sum usage across domains itself.

```text
/var/lib/keeper/<community>/
├── control.sqlite                 # domain registry, cursors, wake table, outbox index
├── domains/
│   ├── public/session.sqlite
│   ├── channel-<uuid>/session.sqlite
│   └── dm-<uuid>/session.sqlite
├── index/<domain>/ledger.sqlite   # derived; rebuildable from the relay
└── sandboxes/<domain>/workspace/  # per-audience workspace volume (§11.4)
```

**One writer per domain.** The process that owns a domain holds an OS lock on
its directory, as pi's experimental durable host does with `proper-lockfile`.
The deployment also holds a lease so that only one Keeper instance runs per
community (§15).

### 8.3 Conversations inside a domain

| Conversation | Key | Created | Lifetime |
|---|---|---|---|
| **Thread** | (channel, thread root) | When Keeper is first addressed in the thread; a top-level mention roots a new thread | Long; compacted; reset with a handoff note after long idle |
| **DM** | DM channel | On the first DM | Long; compacted; periodic handoff resets |
| **Caretaker** | Channel | When observation is on for the channel | Background only: digests, extraction, cadences (§10.3) |
| **Research** | Owning task | By the `research` tool (§12.1) | Until its report is delivered |
| **Steward** | Singleton, `public` domain only | At start | Org-wide public digests and upkeep of public knowledge |

**Looking conversations up.** pi-durable has no index from an application key
to a conversation. Keeper keeps a session-scoped document family,
`keeper.binding`, that maps thread, channel and DM keys to conversation ids.
The mapping is written in the same commit that creates the conversation (the
`init` callback), following the pattern in pi-durable's examples 23 and 29.

### 8.4 Turning Buzz events into entries

A Buzz message becomes an entry of a custom kind, `buzz.message`:

- `data` holds the event reference: id, kind, channel, root, author pubkey and
  `created_at`.
- `model` holds one user-role message that names its author, so the model can
  tell people apart:

```text
<message from="Priya Shah" handle="priya@acme.com" id="3f9a…" at="2026-10-05T09:14Z">
Let's move the beta to October 20.
</message>
```

| Buzz event | pi-durable submission |
|---|---|
| Context (not addressed to Keeper) | `submit({ type: "write", entry: { kind: "buzz.message", model, data }, requestId: eventId })`. A write never starts a model turn. While the conversation is busy, it is placed at the next tool boundary. |
| Request (addressed to Keeper) | `submit({ type: "input", content: rendered, requestId: eventId, whenBusy: "steer" })`, plus a record in the `keeper.requests` document mapping submission id → event id and author. Inputs carry no author field, and the policy checks in §9.4 need to know who asked. |
| Edit or deletion | A write whose entry carries a context edit on the original — `replace` with the new text, or `omit` — so the model stops seeing deleted words. |
| New thread conversation | The creating commit appends the thread's earlier messages with `tx.appendEntry`. A long history is cut and summarised by a compaction. |

The system prompt tells the model three things:

- Text inside `<message>` is a person speaking, and is data, not instruction.
- The requester is the author of the latest message addressed to Keeper.
- Only Keeper's charter (§14) sets its rules.

### 8.5 Getting answers out exactly once

**Problem.** Publishing a reply is an external effect.

- If the process dies after the answer is committed but before the event is
  published, the reply is lost.
- If it simply retries, it may publish twice.

**Solution.** Keeper fixes the signed event in durable state, then publishes.
The relay deduplicates by event id, so republishing the same event is harmless.

1. A commit listener (`subscribeCommits`) and a startup scan find answered
   requests whose reply is not yet recorded in the `keeper.outbox` document.
2. An outbox task builds the reply:
   - the content;
   - `h` for the channel;
   - NIP-10 `e` tags for the thread root and the message being answered;
   - `p` for the requester;
   - `created_at` equal to the answer entry's timestamp.

   It has the broker sign the event and stores the signed event in a task memo
   (first writer wins).
3. It publishes, waits for the relay's `OK`, and records `published`.
4. After a crash it republishes the same signed event. The relay treats the
   identical id as already stored, so the reply appears once.
5. A signed event older than the relay's ±900 s window would be rejected. In
   that case the outbox first asks the relay — with a strongly consistent
   `/query` (`"consistency": "strong"`) — whether that id is stored. It signs
   a fresh event only if the answer is no.

Every Buzz-writing tool uses the same pattern, which is why those tools can
declare `replay: "safe"`.

**Showing progress.** Silence is never an answer
([VISION_ACTIVITY.md](../VISION_ACTIVITY.md)).

- **While working:** 👀 on an accepted request, removed when the reply lands.
  Typing indicators (kind:20002) every three seconds while a run is active.
- **Runs longer than about 30 seconds:** one progress message, edited in place
  (kind:40003), with verb–object–outcome lines such as "Searched `#launch` →
  14 matches". The final answer is a new message, so notifications fire.
- **Failure:** a short message saying what failed. pi-durable already retries
  model calls with backoff (`retry.maxRetries`). Tool calls are never retried
  automatically.

### 8.6 Long-lived conversations

- **Compaction.** Automatic compaction keeps context bounded, with
  `reserveTokens`, `keepRecentTokens` and background compaction tuned per
  model tier.
- **Idle resets.** A thread idle for days gets `reset(handoff)`: a short
  summary replaces old context and drops stale instructions.
- **The channel brief.** What Keeper knows about a channel enters the system
  prompt as a section (§10.4). It changes rarely, which keeps provider prompt
  caches warm.
- **Storage growth.** pi-durable never deletes raw history; compaction only
  appends a summary. Keeper bounds storage by archiving domain stores on epoch
  rotation and by retention policy (§15.5).

### 8.7 Configuring each conversation

pi-durable stores each conversation's agent as names in `pi.agent`. Keeper
sets it with `configure()` when it creates a conversation, from the domain and
the channel's profile (§14):

- **Model tier:** fast for caretakers and routing, standard for threads, deep
  for research and planning.
- **Selected extensions and tools.**
- **Instructions.**

A configuration change applies from the next model request. Running work keeps
the configuration it started with.

### 8.8 What Keeper builds on top of pi-durable

| Need | pi-durable today | Keeper's answer |
|---|---|---|
| Who asked | Inputs have no author or data field | `keeper.requests` document, read by policy checks |
| Find a conversation by Buzz key | No application-key index | `keeper.binding` session document family, written in `init` |
| Timers | Only `TaskRuntime.sleep(until)`; durable because the deadline sits in the checkpoint | Background ticker tasks that `sleep(until)` and commit a new checkpoint each pass (the no-progress rule faults a phase that doesn't); a wake table in the control store reopens suspended domains |
| Concurrency limits | The scheduler starts every eligible task | Semaphores around model access (global, per domain, per requester) |
| Single writer | No cross-process locking | OS lock per domain plus a deployment lease |
| MCP | No integration | An adapter extension around `pi-mcp` (§11.2) |
| Identity-aware policy | Tasks run without the submitter's identity | The broker reads requesters from durable state |
| Telemetry | Not wired into pi-durable | Keeper emits spans around requests, tools and publishes (§15.3) |

---

## 9. Information flow and authority

### 9.1 Keeper implements the broker from the information-flow draft

The [information-flow draft](practical-information-flow-for-buzz-agents.md)
proposes a trusted broker that holds an agent's key. The agent instances it
runs are keyless and bound to one audience. Keeper is that broker, built for an
organization-owned agent. It exposes the draft's semantic actions — read,
reply, post, memory search, memory write, declassification request — so that
personal agents can adopt the same broker later.

| Draft requirement | Keeper mechanism |
|---|---|
| The broker holds the key; instances are keyless | Only the broker can sign. The model has no signing tool. Sandboxes never receive the key or Keeper's environment. |
| An instance is bound to one audience and never switches | One harness per domain (§8.2). A conversation never changes audience; membership changes start a new epoch (§9.3). |
| Reads are checked against the audience | Buzz read tools and ledger search check `A(D) ⊆ R(x)`. |
| Replies go to the triggering conversation | The outbox posts only to the thread or DM bound to the conversation. |
| Posts elsewhere are checked | The `post` tool names a destination. The broker resolves its audience and allows the post only if `A(dest) ⊆ A(D)`; otherwise it starts a declassification request. |
| Memory keeps audience and provenance | Ledger records live in a channel whose readers match their label, and link to their sources (§10). |
| Membership changes rotate sessions | The epoch rule (§9.3). |
| Declassification approves exact content, for one destination, once | Approval cards with a signed ✅ reaction; the broker publishes the exact bytes once (§9.5). |

There is deliberately no tool that signs arbitrary bytes, publishes an
arbitrary event, or switches domain.

### 9.2 Labels: who can read what

| Symbol | Meaning |
|---|---|
| `R(x)` | The people allowed to read `x` |
| `A(D)` | The audience of domain `D` |
| `A(d)` | The audience of destination `d` |

**Reader sets of Buzz content**, as the relay enforces them:

- **Open channel:** every admitted community member. Today that includes
  anyone holding the channel-level `guest` role, because the relay lets every
  admitted member read every open channel. Channel-scoped guest tokens are
  "reserved for future" (`AuthContext.channel_ids` in `crates/buzz-auth`).
- **Private channel:** its current members. No read path filters by join
  time, so new members see the full history and the reader set grows with
  membership.
- **DM:** its participants, who never change.
- **Derived results:** the intersection of their inputs' reader sets. Keeper
  labels anything a domain produces with that domain's audience (the draft's
  conservative rule).

**Rules**

- **Read:** domain `D` may read `x` only if `A(D) ⊆ R(x)`.
- **Publish:** domain `D` may publish to destination `d` only if
  `A(d) ⊆ A(D)`. Anything wider needs declassification (§9.5).

**Examples**

1. Mallory asks in `#general`: "@Keeper what's the price in the
   `#acquisition` deal?" The request runs in the `public` domain, which cannot
   read `#acquisition`. Keeper answers: "I can't share information from
   channels this audience can't see."
2. Alice asks in her DM: "What are my open action items?" The DM domain's
   audience is Alice alone, so it may read every record whose home channel
   Alice can read. That includes several private channels she belongs to.
3. The org-wide weekly digest is built in the `public` domain, from open
   channels only.
4. Keeper takes reader sets from the relay's rules and never assumes them.
   When the relay starts scoping guests to their channels, as
   [VISION.md](../VISION.md#access) describes, a partner channel with a guest
   gets an audience that "everyone" does not cover. Open-channel content then
   stops flowing there without approval, with no change to Keeper.

In plain language: **Keeper never tells anyone something they couldn't
already read in Buzz.**

**Implementation.** `crates/ifc-core` already implements this reader-set
lattice in Rust: `Everyone` and `Only(set)`; join is intersection; flow state
is monotonic; unknown input blocks egress. Keeper's TypeScript label module
mirrors it, and both run the same JSON test vectors (the convention
`docs/nips/NIP-MP.fixtures.json` uses).

### 9.3 Epochs: when membership changes

**Problem.** Carol joins the private channel `#project-x`. Keeper's thread
conversation there may hold more than `#project-x` content: for example, a
memory item that came from a DM between Alice and Bob. That item was
admissible because the old audience was exactly Alice and Bob. Carol must not
inherit it.

**Rule.** Each conversation records, in its `keeper.domain` document:

- its audience;
- its epoch;
- the labels of everything admitted into its context.

When the audience changes, Keeper handles it this way:

| Change | What Keeper does |
|---|---|
| **Widens** (someone joins) | The conversation continues only if every admitted label still covers the new audience. The channel's own content always does, because new members can read the full history. Otherwise Keeper closes the conversation and starts a fresh one, carrying forward only a handoff that a member approved. |
| **Narrows** (someone leaves) | Safe for confidentiality. Keeper still starts a new context from a handoff summary, so the departed member's instructions stop steering it. |
| **DMs** | Never change participants. |
| **The `public` domain** | Never rotates. |

**Phase 1** keeps this simple. Private-channel conversations admit only their
own channel's content and public information, so they never need to rotate
when the audience widens. Any other admission — memory from elsewhere —
requires the check above.

### 9.4 Authority: acting for many people

**Problem.** Information-flow rules stop leaks. They do not stop misuse. A
guest asks Keeper to "DM everyone the new policy". A message pasted from the
web tells Keeper to create an automation.

- **Requesters.** The requesters of a run are the authors of the requests
  placed in it (from `keeper.requests`). People whose messages are only context
  add information, not authority.
- **Action classes** decide what needs approval:

| Class | Examples | Default |
|---|---|---|
| 0 · Respond | Reply in the triggering conversation; react; read tools | Allowed |
| 1 · Contained write | Create or edit records, canvas sections or forum posts in the same channel; set a reminder for the requester | Allowed if every requester could do it themselves; never for guests |
| 2 · Consequential | Post in another channel; DM anyone but the requester; create or change automations; MCP tools that write; spend past a budget; any declassification | Needs approval (§9.5) |
| 3 · Never | Change memberships or roles; delete others' content; moderation; sign arbitrary events | Not offered as tools |

- **Autonomy.** Each channel sets what Keeper may do *unprompted*: `off`,
  `suggest`, `approve` (propose, then act after approval) or `act` (class 1
  only).
- **Where the checks live.** Checks run inside the broker and inside each tool's
  implementation, not only in a hook. pi-durable hooks belong to extensions,
  and a conversation whose extension selection omits a guard runs without it.
  Policy must not depend on configuration getting that right.
- **Untrusted input.** Message text is data. The requester's identity comes
  from the verified event, never from text. Any class 1 action influenced by
  another agent, a guest or external content — web pages, MCP results — is
  treated as class 2.

### 9.5 Approvals and declassification

1. **The model calls a class 2 tool.** The broker records a pending action: the
   exact payload and its digest, the requesters, the label, the destination and
   an expiry. The tool call returns "waiting for approval" at once; the run is
   not blocked.
2. **Keeper posts an approval card in the thread.** It is one plain sentence
   ("Post this summary to `#leadership`, which 40 people can read"), the exact
   content when it is a post, and ✅ / ❌.
3. **An authorized person reacts ✅.** A kind:7 reaction is a signed event. The
   broker checks four things:
   - the reaction is on that card;
   - the reactor may approve this action;
   - the action has not expired;
   - the action has not already been executed.
4. **The broker executes the stored payload exactly.** The model cannot alter
   it. The outcome goes back into the conversation as a follow-up request, so
   the model can continue.

**Who may approve.** Approving should mean the same as doing it yourself. The
approver must be someone who could perform the action manually:

| Action | Approver |
|---|---|
| Declassification (content from audience *S* to destination *d*) | Someone who can read *S* and post in *d* |
| Post or DM on someone's behalf | The requester, if they could send it themselves |
| Automation | The person who will own the workflow, who signs it (§12.4) |
| External write (MCP) | The requester or an admin-configured approver group, per server (§11.2) |
| Spending past a budget | The budget owner (§14.3) |

- **Declassification is always exact and single-use**, as the draft requires.
  For other class 2 actions a channel may allow short scoped grants, such as
  "approve similar posts in this thread for one hour" (Phase 3).
- **Workflow approvals** (kinds 46030/46031) are not wired end to end yet
  (WF-08). Keeper does not depend on them.

### 9.6 Limits of the claim

As in the draft, these guarantees cover brokered Buzz paths. Some paths can
still carry information out:

- network egress from sandboxes;
- MCP servers;
- external APIs.

Keeper narrows them:

- per-audience sandboxes;
- no raw network egress for private domains by default;
- MCP servers classified by where their data goes (§11.2);
- secrets substituted at the egress proxy rather than handed to code.

Integrity labels in the style of FIDES, and complete mediation, are Phase 4
work.

---

## 10. Org memory: the ledger

### 10.1 What Keeper remembers

| Record type | What it is | Example |
|---|---|---|
| `buzz.decision` | Something a group decided | "Beta moves to October 20" |
| `buzz.task` | An action item: assignee, due date, status | "Marco: update the pricing page by Oct 9" |
| `buzz.question` | A question still open | "Do we support SSO in the beta?" |
| `buzz.digest` | A summary of a channel or thread over a period | "Week 41 in `#launch`" |
| `keeper.preference` | What a person or channel wants from Keeper | "Briefings at 9:00, not on weekends" |

Each record carries:

- a title and body, and a status;
- an assignee and due date, where they apply;
- links to its source messages;
- a confidence score;
- who created it (Keeper or a person) and who confirmed it.

### 10.2 Where memory lives

**On the relay, as NIP-AR records** ([NIP-AR](nips/NIP-AR.md), kind:45010).
The relay already implements NIP-AR; no client uses it yet. It fits Keeper's
memory for six reasons:

1. **Each record has one home channel, and the home decides who can read it.**
   Keeper picks a home whose readers are covered by the record's label:
   - for a caretaker, the channel itself;
   - for a personal record, the person's DM with Keeper;
   - for the steward, the source open channel.

   The relay then enforces exactly the information-flow rule, on every read
   path.
2. **`root` anchors a record to the thread it came from.**
3. **Deterministic ids.** NIP-AR allows a deterministic `d`. Keeper derives it
   from the record type and its source event ids, so a crash or replay cannot
   create duplicates.
4. **Safe concurrent edits.** Edits are compare-and-swap on `prev`, so people
   and Keeper can edit the same record. On conflict Keeper re-reads and
   reconciles. It never overwrites a human edit blindly.
5. **Quiet.** Revisions never raise unread counts or notifications.
6. **Cross-channel queries.** Anyone can query current records across the
   channels they can read, by tag — for example "tasks assigned to me".

```json
{
  "kind": 45010,
  "tags": [
    ["ar", "1"],
    ["d", "6c1f0b0e-4f5e-5a7b-9d55-1f3c2b8e4a10"],
    ["h", "<#launch channel uuid>"],
    ["type", "buzz.decision"],
    ["title", "Beta moves to October 20"],
    ["op", "create"],
    ["root", "<thread root event id>"],
    ["source", "<event id of Priya's message>"],
    ["source", "<event id of Marco's message>"]
  ],
  "content": "{\"version\":1,\"status\":\"proposed\",\"summary\":\"The beta moves from Oct 13 to Oct 20 to fit the pricing update.\",\"decidedBy\":[\"<pubkey>\",\"<pubkey>\"],\"confidence\":0.86}"
}
```

**Why not NIP-AE memory (engrams)?** Engrams are encrypted to one agent–owner
pair. Shared memory must be readable by its audience and editable by the people
it is about.

**The type namespace.** `buzz.*` types are reserved for published Buzz client
contracts, and `buzz.task` is already NIP-AR's example.

- *Phase 2* agrees schemas for `buzz.decision`, `buzz.task`, `buzz.question`
  and `buzz.digest` with the desktop and mobile teams, so every client renders
  them for people, not just for Keeper.
- *Before that*, prototypes write `keeper.dev.*` types, and only in test
  communities. Artifact types are immutable, so production data should start
  on the final contract.

**A derived index per domain.** Keeper keeps a SQLite index per domain,
rebuildable from the relay and never authoritative. It holds full-text search
and, optionally, embeddings, because the relay's search is keyword-only.

### 10.3 How memory is made

A **caretaker** conversation, in the channel's own domain, looks after each
observed channel:

1. **Intake.** The router appends new event ids to the caretaker's intake. The
   intake is a document family keyed by channel, kept small (the Chord
   findings advise against large documents).
2. **When to digest:**
   - after a number of new messages;
   - after a quiet period that follows activity;
   - on a cadence, such as end of day;
   - when asked.
3. **Extraction**, as a durable task with checkpointed phases:
   - fetch the new messages from the relay;
   - extract candidate decisions, tasks and questions with a fast model and a
     structured schema;
   - reconcile with current records: update status, merge duplicates, close
     answered questions;
   - write the records;
   - refresh the channel brief.
4. **Thread wrap-up.** When a thread goes quiet, its outcome becomes one digest
   record.
5. **Proposals**, only in channels set to `proactive` (§14.2). Keeper posts a
   short card: "📌 Decision: the beta moves to Oct 20 — ✅ confirm · ❌
   dismiss". A ✅ marks the record `confirmed`. This is the vision's planned
   *Knowledge Crystallization*: "AI proposes summaries, humans approve"
   ([VISION.md](../VISION.md#culture-features)).
6. **Human edits win.** When a person edits or dismisses a record, that is
   ground truth. Keeper never silently reverts it.

**Personal briefings** run in the person's DM domain, on a cadence they chose.
Keeper queries current records whose home channel that person can read: tasks
assigned to them, questions addressed to them, and decisions in their channels
since the last briefing. It then sends a short DM. Briefings are opt-in.

**Forgetting**

- *A source is deleted* (kind:5 or 9005). Records derived only from it are
  deleted (`op=delete`); records with other sources are updated.
- *Someone says "forget this thread" or "forget what you know about me".*
  Keeper deletes the derived records, resets the conversations, purges its
  local indexes, and confirms what it removed.
- *Retention* follows the community's policy (§15.5).

### 10.4 How memory is recalled

- **`ledger_search`.** Every hit is label-checked
  (`A(D) ⊆ R(home channel)`). Results carry links to their sources.
- **The channel brief.** Under about 1,500 tokens: purpose, active topics,
  recent decisions, open tasks and questions, key people. It enters thread
  conversations as a prompt section, and changes rarely so prompt caches stay
  warm.
- **Citations.** Every claim in an answer links its source message with a
  `buzz://message?channel=<uuid>&id=<hex>` deep link.

---

## 11. Tools, MCP, skills and sandboxes

### 11.1 Buzz tools

Every Buzz tool is mediated by the broker.

| Tool | Class (§9.4) | Notes |
|---|---|---|
| `read_thread`, `read_channel`, `search_messages`, `get_profile`, `list_channels` | 0 | Results carry labels; anything the domain may not read is omitted, not redacted. |
| `ledger_search`, `ledger_get` | 0 | §10.4 |
| `react`, `progress` | 0 | In the triggering conversation only. |
| `research` | 0 | Starts a background research conversation in the same domain (§12.1). |
| `ledger_upsert` | 1 | A record in the home channel; deterministic `d`; compare-and-swap. |
| `canvas_update` | 1 | The same channel's canvas; compare-and-swap on `expected-revision`; 256 KB cap. |
| `forum_post` | 1 | The same forum channel (forum channels are a desktop preview feature). |
| `remind` | 1 | For the requester; a Keeper timer that mentions them when due (§12.3). |
| `task_create`, `task_update` | 1 | §12.2 |
| `delegate` | 1 | Mentions another agent in the same channel (§12.5). |
| `post` | 2 | Another channel or thread; label check; may become a declassification request. |
| `dm` | 2 | Anyone other than the requester. |
| `workflow_draft` | 2 | Signed by a human (§12.4). |

The final answer is not a tool call. The outbox publishes it as the reply in
the triggering conversation (§8.5). The model cannot forget to post it, unlike
today's agents.

### 11.2 MCP servers

**Adapter**

- For each configured server, Keeper builds a pi-durable extension whose tools
  wrap `pi-mcp`'s client. `pi-mcp` supports stdio and Streamable HTTP, and
  OAuth with PKCE, dynamic client registration and refresh.
- Tools are named `mcp__<server>__<tool>`, as pi's coding agent names them.
- Large tool sets can use the same exposure modes as pi's coding agent: direct,
  deferred or codemode. With codemode, nested tool calls bypass pi-durable
  hooks, so the broker's checks must also run inside the nested executors.
- **Replay** is `unsafe` by default: after a crash the model sees "interrupted"
  and decides what to do. Only tools annotated read-only and idempotent are
  `safe`.

**Where servers run**

- Stdio servers run inside the domain's sandbox, never in Keeper's process
  environment.
- Keeper calls remote servers itself, with credentials held in the broker's
  secret store. OAuth tokens go through `pi-mcp`'s injectable token store.

**Policy per server**, declared in the config repository (§14.1):

```yaml
mcp:
  servers:
    web-search:
      transport: { http: "https://mcp.search.example/v1" }
      auth: { oauth: true }
      exposure: direct
      dataEgress: vendor        # none | vendor | public
      allowIn: [public]          # domain kinds: public, private, dm
      classes: { default: 0 }
    tracker:
      transport: { http: "https://mcp.tracker.example" }
      auth: { oauth: true }
      exposure: deferred
      dataEgress: vendor
      allowIn: [public, private]
      classes: { default: 0, write: 2 }   # tools not annotated read-only need approval
      approvers: requester
```

**`dataEgress`** is the admin's statement of where data goes when the server is
called:

| Value | Meaning |
|---|---|
| `none` | Nothing leaves |
| `vendor` | A processor the organization has a contract with |
| `public` | Untrusted or public destinations |

By default the `public` domain may use any server, and private and DM domains
only `none` and `vendor` servers. A search query typed in a private channel is
private too.

### 11.3 Skills

- **Format.** The Agent Skills format: a `SKILL.md` with `name` and
  `description` front matter, as pi and Buzz persona packs use.
- **Sources.** The config repository's `skills/` directory, installed packs, and
  later per-channel skills.
- **Loading.** Names and descriptions go into the system prompt. The model reads
  the full skill when it needs it (`read_skill`). This is pi's progressive
  disclosure.
- **Scripts.** Skills are instructions. Any scripts they reference run in the
  sandbox.

### 11.4 Sandboxes: where the boundaries go

| Boundary | Isolation between audiences | Continuity | Cost | Verdict |
|---|---|---|---|---|
| One per organization | None: files from a private channel are visible to public work | Best | Lowest | Breaks information flow |
| **One per audience (domain)** | Exactly matches information flow | A channel's projects persist across its threads | One per *active* audience | **Default** |
| One per thread | Strong | Lost between threads; setup repeats | High | Clean room for risky jobs |
| One per task | Strongest | None | Highest | Clean room for risky jobs |

**Recommendation**

- **Isolate by domain.** Files, shell history, caches, installed packages and
  stdio MCP servers of one audience are never visible to another. This is the
  boundary the information-flow draft leaves open ("shared writable state
  remains an explicit limitation"). Keeper closes it for its own sandboxes.
- **Persist per domain.** Each domain gets a workspace volume, with a directory
  per thread (`/workspace/threads/<root>`) and a shared area
  (`/workspace/shared`).
- **Keep the body ephemeral.** A micro-VM or container starts on the first tool
  call, suspends when idle, and can be replaced at any time. The body is
  disposable; the workspace is not
  ([VISION_REMOTE_AGENTS.md](../VISION_REMOTE_AGENTS.md#honest-costs)).
- **Clean rooms.** A tool can ask for a fresh sandbox with no workspace and no
  egress, for untrusted code or downloads.
- **No sandbox for Buzz tools.** They are broker calls.

**Implementation**

- `HarnessOptions.env` returns an `ExecutionEnv` for the conversation's domain,
  looked up from its `keeper.domain` document (pi-durable example 29).
- `ExecutionEnv.id` is the domain's sandbox id, so `edit` and `write` serialize
  changes to a file across the domain's conversations.
- Providers sit behind one interface: a local directory (development only), a
  container, a Gondolin micro-VM, or a Kubernetes pod.

**Hard rules**

- **No inherited environment.** The sandbox never inherits Keeper's
  environment. pi's Gondolin extension example passes the host environment
  through. pi-chat passes only placeholder variables; Keeper does the same.
- **Secrets at egress.** The sandbox sees placeholders. An egress proxy
  substitutes the real value only for allowed hosts (the Gondolin HTTP-hook
  pattern pi-chat uses).
- **Egress per domain.** The `public` domain may have open egress. Private and
  DM domains default to an allowlist — package registries and configured APIs —
  or to none.
- **Bounded everything.** CPU, memory, disk and wall-clock limits apply per
  command, and captured output is capped
  ([AGENTS.md](../AGENTS.md#review-proven-rules), rule 4).

**Scaling**

- No sandbox exists until a tool needs one.
- Bodies suspend after a few idle minutes; workspaces persist.
- A per-community cap limits concurrent bodies, with a queue.
- Per-domain disk quotas apply, and workspaces are archived on epoch rotation.

---

## 12. Workspace management

What Buzz offers today, and how Keeper uses it:

| Primitive | State today | Keeper's use |
|---|---|---|
| NIP-AR records (45010) | The relay implements them; no client renders them | General tasks, decisions, questions (§10) |
| NIP-34 issues (1621, status 1630–1633) | Shipping; every issue belongs to a repo | Software tasks in project channels |
| Workflows (30620) | Desktop preview feature. `send_message`, `call_webhook` and `delay` run. `send_dm` and `set_channel_topic` return NotImplemented. Approval steps fail (WF-08). | Schedules and triggers that wake Keeper |
| Jobs (43001–43006) | Registered, but the relay rejects them | Not usable; Keeper delegates by mention |
| Reminders (30300) | Readable only by their author | Not usable for reminding others; Keeper uses its own timers |
| Home inbox | Mentions reach people reliably; the needs-action lane is unreachable for agents | Keeper surfaces items with mentions |
| Mobile push | Kinds 9, 40002, 45001, 45003 | Mentions in messages reach phones |
| Canvas (40100) | One per channel; compare-and-swap edits; 256 KB | Living documents and reports |
| Huddles | Client-side transcription posts utterances as kind:9 messages once an agent joins | Meeting notes (§12.6) |

### 12.1 Research jobs

**The `research` tool**

1. Creates a background conversation in the same domain. It is owned by an
   anchor task and reports through a reporter task — pi-durable's persistent
   subagent pattern (example 23).
2. The research conversation gets the `deep` model tier, research skills and
   the MCP servers its domain allows.
3. It posts a plan, then progress (§8.5), then a report. The report goes to the
   thread, or to a forum post where forums are enabled. It becomes a section of
   the channel canvas only when someone asks, because the canvas is one shared
   document per channel.
4. The reporter hands the result back to the thread's conversation as a
   follow-up request. Keeper can then answer questions about it in context.

**Control and limits**

- `stop` in the thread reaches the job: Keeper aborts the job's background
  work, scoped to that thread.
- Budgets apply per job (§14.3).
- Request ids keep a restart from sending a report twice.

### 12.2 Tasks

| Aspect | Design |
|---|---|
| **General tasks** | `buzz.task` records in the channel where the work was discussed: title, `assignee`, due date, status, `root` (the source thread), optional `project` link. |
| **Software tasks** | NIP-34 issues in project channels, by the same path `buzz issues create --channel` uses. |
| **Telling people** | Keeper mentions the assignee when a task is created, when it falls due, and when it is overdue. Mentions are the one inbox lane and push path that reliably reach people today. |
| **Lifecycle** | Proposed or confirmed → reminders → done → reported back to the source thread. Done means the assignee says so, reacts ✅, or edits the record. |
| **Permissions** | Creating and assigning within a channel is class 1. The assignee must be able to read the channel. |

### 12.3 Reminders and follow-ups

- **Mechanism.** Keeper's own timers (§8.8): a background ticker in the domain,
  plus the wake table in the control store.
- **When a reminder is due,** Keeper posts in the source thread mentioning the
  person. If they asked in a DM, it DMs them.
- **Classes.** "Remind me" is class 1. Reminding someone else in the same
  thread is class 1. Reminding them by DM is class 2.

### 12.4 Automations

1. **Drafting.** Keeper drafts the workflow YAML (kind:30620) and shows it in
   plain words, with the YAML attached.
2. **A human signs it.** A workflow runs with its owner's authority, re-checked
   before every run, and its owner is its signer. So the person whose authority
   the automation will use must sign it. This generalizes Buzz's existing
   *owner-reviewed draft* pattern, where nothing changes until the owner saves
   the draft (`crates/buzz-cli/src/agent_management.rs`). The desktop needs to
   accept workflow drafts from Keeper and open them prefilled (Phase 3).
3. **Waking Keeper.** A `send_message` step that mentions `@Keeper` gets `p`
   and `buzz:workflow-mention` tags from the relay. Keeper treats the message
   as a request from the workflow's owner (§6.3).

**Limits today:**

- Workflows post only in their own channel.
- `delay` tops out at 270 seconds.
- Missed cron fires are not replayed.
- Workflows are a desktop preview feature.

So Keeper's own timers cover what workflows cannot. As a rule:

| Use | When |
|---|---|
| **Workflows** | Automations a team should see and edit |
| **Keeper timers** | Keeper's internal cadences and personal reminders |

### 12.5 Delegating to other agents

- **By mention.** The relay does not accept job kinds today, so Keeper
  delegates by mentioning the agent in a thread in the right channel, with a
  clear brief. It then follows the reply as context.
- **Permission.** Personal agents answer only their owner by default
  (`respond_to = owner-only`). An owner who wants Keeper to delegate to their
  agent adds Keeper to that agent's allowlist.
- **Later.** Once job kinds are wired (Appendix C), delegation becomes
  structured: request, accepted, progress, result.

### 12.6 Meetings (a pack)

- When invited to a huddle, Keeper joins. Buzz's client-side transcription then
  posts each utterance as a message in the huddle's temporary channel, tagging
  the agents present.
- Afterwards Keeper writes notes and action items.
- The huddle's audience is its participants. Posting notes to the parent channel
  widens the audience, so it needs a participant's approval, unless everyone
  who can read the parent channel attended (§9.5).

---

## 13. Extensibility

Keeper grows by adding layers, not by forking it:

| Layer | Who adds it | What it is | Trust |
|---|---|---|---|
| **Configuration** | Admins | Channel profiles, observation, autonomy, budgets (§14) | Content |
| **Skills** | Admins; later channel members | `SKILL.md` instructions (§11.3) | Content |
| **MCP servers** | Admins | External tools with a data-egress policy (§11.2) | External service |
| **Packs** | Admins install them | Bundles of skills, MCP configuration, profiles and personas | Content, unless the pack ships code |
| **Extensions** | Developers write them; operators install them | TypeScript pi-durable extensions: tools, prompt sections, hooks, tasks | Code that runs in Keeper's process: reviewed and pinned |

### 13.1 Packs are persona packs

Buzz persona packs are already Open Plugin Spec packages
([`PERSONA_PACK_SPEC.md`](../crates/buzz-persona/PERSONA_PACK_SPEC.md)):

- `.plugin/plugin.json`;
- `agents/*.persona.md`;
- `skills/`;
- `.mcp.json`;
- hooks.

Keeper reads the parts that apply to it — skills, MCP configuration, pack
instructions, and defaults such as model, triggers and subscriptions — plus a
`keeper` block that OPS consumers safely ignore:

```json
{
  "$schema": "https://open-plugin-spec.org/schema/v1/plugin.json",
  "id": "com.acme.keeper-sales",
  "name": "Sales assistant",
  "version": "1.0.0",
  "personas": ["agents/keeper.persona.md"],
  "pack_instructions": "instructions.md",
  "mcp_config": ".mcp.json",
  "keeper": {
    "profiles": {
      "sales": {
        "extensions": ["keeper.core", "keeper.ledger", "keeper.research", "mcp:crm"],
        "model": "standard",
        "instructions": "profiles/sales.md",
        "autonomy": "suggest"
      }
    },
    "mcp_policy": {
      "crm": { "dataEgress": "vendor", "allowIn": ["public", "private"], "classes": { "write": 2 } }
    },
    "code": []
  }
}
```

- **Code.** `code` lists npm packages, pinned to exact versions with integrity
  hashes. Only an operator can enable a pack that ships code.
- **First real consumer.** Today `buzz-acp` depends on `buzz-persona` but does
  not use a pack's skills, MCP servers or triggers at runtime. Keeper would be
  the first consumer that honors them.

### 13.2 Built-in extensions

Keeper's own capabilities are ordinary pi-durable extensions
(`defineExtension`), so they reload and compose like any other:

| Extension | Gives the model |
|---|---|
| `keeper.core` | Charter and style sections; Buzz read tools; control handling |
| `keeper.ledger` | The channel brief section; ledger tools |
| `keeper.research` | The `research` tool and its background conversations |
| `keeper.tasks` | Task, reminder and delegation tools |
| `keeper.automations` | Workflow drafting |
| `keeper.sandbox` | `read`, `write`, `edit` and `bash` (pi-durable's `CodingTools`), bound to the domain's sandbox |
| `mcp:<server>` | One per configured MCP server |

**Profiles.** A channel selects a *profile*. A profile picks extensions, a
model tier, instructions and an autonomy level, applied with `configure()`
(§8.7).

**Policy is not an extension.** The broker's checks live inside the broker and
inside every tool implementation (§9.4). They do not depend on an extension
being selected.

**Reload.** Installing an extension under an existing name replaces it.

- Running work keeps the code it started with.
- The next phase, request or tool call uses the new code (pi-durable reload
  semantics).
- Keeper watches its config repository's ref updates (kind:30618) and reloads
  after a merge.

---

## 14. Configuration and governance

### 14.1 The config repository

Workspace admins own a git repository hosted on the community's relay,
`keeper-config`. Changes are proposed on branches — each branch gets its own
channel — and merged after review, like code.

```text
keeper-config/
├── keeper.yaml          # organization settings
├── charter.md           # Keeper's standing instructions, tone and boundaries
├── profiles/*.md        # instructions per profile
├── skills/<name>/SKILL.md
├── mcp.yaml             # MCP servers and their policy (§11.2)
└── packs.lock           # installed packs, pinned
```

```yaml
# keeper.yaml
version: 1
identity:
  displayName: Keeper
observe:
  mode: member               # member | open-read (§6.2)
  joinOpenChannels: false
  deny: ["#people-confidential"]
channels:
  default:  { profile: general, proactivity: quiet, autonomy: suggest }
  "#launch": { profile: general, proactivity: normal, digest: daily }
  "#sales":  { profile: sales, proactivity: proactive }
models:                      # pi-ai provider and model per tier
  fast:     { provider: <provider>, model: <fast model> }
  standard: { provider: <provider>, model: <standard model> }
  deep:     { provider: <provider>, model: <deep model> }
budgets:
  community:          { monthlyUsd: 500 }
  perRequesterDaily:  { usd: 10 }
  perResearchJob:     { usd: 5 }
  owner: "<pubkey of the budget owner>"
agents:
  allowTriggersFrom: []      # pubkeys of agents that may wake Keeper
```

### 14.2 Channel settings

Channel owners and admins can say `quiet`, `normal` or `proactive` to Keeper,
or later use channel settings in the desktop.

- The setting is stored as a `keeper.preference` record in that channel, so its
  members can see it.
- NIP-AR lets anyone who can post in the channel edit that record. Keeper
  applies only revisions made by channel owners and admins, and says so when
  it ignores one.

| Proactivity | What Keeper does unprompted |
|---|---|
| `quiet` (default) | Nothing. It answers when asked. Memory intake runs only if observation is on. |
| `normal` | Proposes decisions and tasks it is confident about, a few per day at most. |
| `proactive` | Adds daily digests and offers to act on intents: "I can research this — want me to?" |

### 14.3 Budgets and cost

- **Measurement.** pi-durable records usage per conversation (`pi.usage`), per
  model and per tool. Keeper adds it up per domain, channel, requester and job.
- **Enforcement** happens in the model wrapper, before each request. A request
  over budget either asks the budget owner (class 2) or falls back to a cheaper
  tier, as configured.
- **Visibility.** `status` shows spend. The budget owner gets a weekly cost
  summary by DM.

### 14.4 Transparency and audit

- Everything Keeper does in Buzz is a signed event, covered by the relay's
  hash-chain audit log.
- Anyone can ask:
  - "What do you know about this channel?" Keeper lists the records and their
    sources.
  - "What do you remember about me?" Keeper lists the same, about them.
  - "Where are you listening?" Keeper lists the channels it observes.
- Keeper's durable journals hold each conversation's transcript, tool calls and
  results, for diagnosis. They are scoped per audience, readable only by
  operators on the host, and subject to retention (§15.5).

---

## 15. Deployment and operations

### 15.1 A resident agent

Remote agents exit after inactivity. The Kubernetes provider refuses
`inactivity_seconds: 0`, uses an `emptyDir` workspace, and runs bare pods that
do not survive node loss. Keeper is resident, so it needs a different shape:

- **State.** A single-replica StatefulSet with a persistent volume for
  `/var/lib/keeper` — or the equivalent elsewhere, such as one VM with a
  service manager for a small community.
- **A single instance.** The live instance holds a lease: a Kubernetes Lease,
  or a lock row. A second instance refuses to open domains.
- **Still tethered only to the relay.** Keeper has no management API.
  - Status comes from `status` and from its presence (kind:20001, renewed every
    minute).
  - Stopping it is a control phrase from an admin.
  - Configuration lives in the config repository.

  Liveness and readiness endpoints exist for the substrate only.
- **Backups.** Online SQLite backups of the control store and domain stores.
  The relay holds the record, so losing a store loses in-flight work and
  Keeper's local history, not decisions or tasks.

### 15.2 Models

- **Providers.** pi-ai offers one interface to many providers. The config names
  a provider and model per tier (§14.1).
- **Tiers.** *Fast* for routing, extraction and classification. *Standard* for
  threads. *Deep* for research and planning.
- **Buzz Mesh** is an OpenAI-compatible endpoint backed by community hardware.
  It suits communities that want prompts to stay in house. Today it is local to
  the desktop, so a resident Keeper needs a reachable endpoint (Appendix C).

### 15.3 Observability

- **Spans** follow each request: intake → routing → submission → generation →
  tools → publish. They use pi-telemetry's contracts and never record prompts
  or secrets.
- **Metrics:**
  - ingest lag per channel;
  - queue depth;
  - run latency;
  - approval wait time;
  - spend;
  - live sandboxes;
  - reconciliation catches — events that live delivery missed, an early
    warning about relay health.
- **Operator console.** pi-durable's task graph and conversation views, served
  locally on the host and never exposed to the network.

### 15.4 Scaling path

| Stage | Shape | Scales by |
|---|---|---|
| Phases 1–3 | One process per community. All domains in it; idle domains suspended. | One machine. Enough for hundreds of active threads (to be measured in Phase 1). |
| Phase 4 | A coordinator (gateway, router, broker, scheduler) and domain workers. Domains are assigned by consistent hashing, each with its own lease. | Adding workers |
| Hosted operators | Many communities. A community's Keeper scales to zero when idle, and the relay's operator listener wakes it. | Process per community |

**The operator listener** is deployment-global. When a kind 9, 40002, 45001 or
45003 event `p`-tags a registered pubkey, the relay POSTs
`{pubkey, community_host, event_id, kind, created_at}` to a configured endpoint,
without content (`crates/buzz-relay/src/operator_listener.rs`). Keeper's host
uses it to start a suspended Keeper, which then catches up from its cursors.

### 15.5 Retention

- **Journals.** Domain stores rotate and are archived on epoch changes. Raw
  transcripts are kept for a per-community period, for example 90 days. Records
  on the relay follow the community's own retention policy.
- **Forget requests** purge local stores and indexes too (§10.3).

### 15.6 Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Process crash or redeploy | In-flight work pauses | Resume from the last commit; the outbox republishes once |
| Relay unreachable | No intake, no publishing | Backoff; replay with a 900 s overlap; the outbox drains |
| Live delivery dropped | Events missed | Reconciliation sweep (§7.2) |
| Model provider outage | Runs wait | pi-durable retries with backoff; fallback tier; a visible notice |
| Domain store corrupted | One audience affected | Restore from backup, or reopen empty — the record is on the relay |
| Sandbox hangs | Tool timeout | Replace the body; the workspace persists; the model sees an error |
| Keeper removed from a channel | Access lost | Unsubscribe; close its conversations; no further posts there |
| Budget exhausted | Runs blocked | Ask the budget owner; degrade the tier |
| A second instance starts | Two writers | The lease refuses the second instance |

---

## 16. Phased delivery

**Decided (2026-10-05):** the first product is a durable **research agent**
built on Keeper's foundations. Keeper's organizational features — org memory,
then workspace management — follow on the same foundations.

Each phase ships something people can use, and each has exit criteria a test
can check.

| Phase | Name | What people get | What gets built |
|---|---|---|---|
| 0 | Foundations | — | Skeleton, label module, relay client, one durable domain, outbox |
| 1 | **Research agent** | Ask it in any thread or DM; long research jobs that survive restarts, with progress and a report; steer and stop it | Gateway, router, broker v1, domains, read tools, research jobs, web search and fetch, MCP, budgets, resident deployment |
| 2 | Keeper: org memory | Channel trackers, briefings, decision capture | Caretakers, ledger on NIP-AR, desktop rendering |
| 3 | Keeper: workspace manager | Tasks, reminders, automations, delegation, analysis that runs code | Task lifecycle, timers, workflow drafts, approvals v2, sandboxes |
| 4 | Scale and govern | Admin experience, packs, hosted scale | Workers, pack review, integrity labels, evals in CI |

**Progress (2026-10-05).** The `keeper/` package implements Phase 0 and most
of milestones 1a and 1b, verified against a local relay; its
[README](../keeper/README.md) lists what works. Phase 0's exit criteria hold:
exactly one reply per mention, also when the process is killed and restarted,
and the label fixtures pass in Rust and TypeScript. The outbox is a durable
reply task per request that memoizes its signed events. Still open in Phase 1:
reconciliation sweeps, NIP-FI-aware reconnect, suspending idle domains, the
epoch rule on narrowing, compaction, progress messages, MCP, skills, forum
reports, budgets, and all of 1c.

Why research comes first:

- Research mostly reads, so its risk is low.
- It exercises durability fully: long jobs, restarts, background work.
- It does not wait on unfinished Buzz pieces: workflow approvals (WF-08),
  desktop rendering of records, job kinds.
- Non-technical users value it from day one.

### Phase 0 — Foundations

**Goal:** prove the end-to-end path on the real runtime.

**Scope, roughly in PR order:**

1. Add a `keeper/` pnpm workspace package: TypeScript, Biome, Vitest, a config
   loader and a control store.
2. Port the label module from `crates/ifc-core`, with JSON fixtures shared by
   the Rust and TypeScript tests.
3. A relay client: NIP-42 auth, REQ/EOSE/CLOSED, EVENT/OK, reconnect.
4. One domain harness on SQLite with the pi-ai faux provider, plus the
   `buzz.message` entry and the `keeper.binding` and `keeper.requests`
   documents.
5. Outbox: memoized signed replies, republished on restart.
6. A local loop: `just relay` and `keeper` against it.

**Exit criteria**

- On a local relay, "@Keeper hello" in a thread produces exactly one reply,
  through gateway → router → domain → outbox.
- Closing the process during that run, then restarting, still yields exactly
  one reply.
- The label fixtures pass in both Rust and TypeScript.

### Phase 1 — Research agent

**Goal:** anyone can hand Keeper a research question in a thread or DM and
trust that the answer arrives once, even if the job takes hours and the
process restarts in the middle.

**Milestone 1a — a durable thread agent**

| Area | Work |
|---|---|
| Gateway | Batched `#h` subscriptions; membership tracking (44100/44101); cursors with a 900 s overlap; reconciliation sweeps; NIP-FI-aware reconnect |
| Router | Requests, context, control phrases, edits, deletions (§7.3) |
| Domains | `public`, private channel and DM domains; suspend and resume; the conservative epoch rule (§9.3) |
| Conversations | Thread backfill; attribution; steer and context placement; compaction; idle handoff |
| Broker v1 | Key custody; read checks; replies only (class 0 tools) |
| Output | Outbox; 👀, typing and progress messages; `stop` and `status` |

**Milestone 1b — research jobs**

- The `research` tool and background research conversations (§12.1).
- `web_search` and `web_fetch` tools: fetch is built in (size-capped, refuses
  private addresses); search goes through a pluggable provider.
- The MCP adapter and per-server policy (§11.2).
- Skills from the config repository (§11.3).
- Reports in the thread, or as forum posts where forums are enabled; follow-up
  questions in the thread.
- Per-job budgets; `stop` reaches the job.

**Milestone 1c — hardening and pilot**

- Model-access semaphores; usage tracking; budgets.
- Resident deployment with a lease and a persistent volume (§15.1).
- The crash-injection and information-flow suites (§17).

**Exit criteria**

- **Crash injection.** Across 100 random kill points, no request is lost and
  no reply is duplicated, verified by querying the relay.
- **Long jobs.** A research job survives a redeploy in the middle of its run
  and delivers one report.
- **Information flow.** The two-world tests for every read tool pass (§17). A
  private-domain job cannot call a server whose `dataEgress` is not allowed
  there.
- **Configuration, not code.** Adding an MCP server or a search provider is a
  configuration change.
- **Outage.** A request posted while the relay was unreachable for 10 minutes is
  answered after recovery.
- **Pilot.** A pilot group, including non-technical people, uses it for a week.
  It acknowledges a request within 2 seconds at the median and shows typing
  within 3 seconds.

**Depends on:** nothing in the relay — Keeper is an ordinary member. An
elevated rate tier is desirable.

**Not in this phase:** listening without a request, memory, sandboxes.

### Phase 2 — Keeper: org memory

**Goal:** Keeper condenses channels into a visible, correctable tracker.

**Scope**

- Caretakers, intake, extraction tasks, reconciliation, thread wrap-ups
  (§10.3).
- NIP-AR record types `buzz.decision`, `buzz.task`, `buzz.question` and
  `buzz.digest`, agreed as client contracts with the desktop and mobile teams.
  A desktop tracker panel renders them.
- Proposals with ✅; human edits win.
- The channel brief; `ledger_search`; a semantic index per domain.
- Personal briefings, opt-in.
- Forgetting and deletion propagation.
- The `open-read` observation mode, with its disclosure indicator.

**Exit criteria**

- Extraction quality on a labeled corpus meets agreed thresholds — for
  example, decision precision of at least 0.9 at the "proposed" threshold.
- The information-flow suite covers memory: no record or brief ever reaches a
  domain whose audience it does not cover.
- **Quiet by default:** an unconfigured channel receives no unprompted messages
  (test).

### Phase 3 — Keeper: workspace manager

**Goal:** talk turns into tracked work and automations.

**Scope**

- The task lifecycle (§12.2): records and project issues, assignment by
  mention, due dates, follow-ups, completion, reporting back.
- Keeper timers and reminders (§12.3).
- Workflow drafting with human signing; workflows that wake Keeper (§12.4).
- Approvals v2: scoped grants, approver policies, an approval digest by DM.
- Delegation by mention; structured jobs once the relay accepts them (§12.5).
- Sandboxes (§11.4): per-domain workspace; container or micro-VM provider; no
  inherited environment; egress policy; secrets at egress.
- The meeting-notes pack (§12.6).

**Exit criteria**

- **End to end:** a planning thread leads to proposed tasks, a ✅, reminders,
  completion, and a summary in the thread — across a restart.
- **Approvals:**
  - the executed payload always equals the approved one;
  - approval from someone who could not have done the action themselves is
    rejected;
  - expired or reused approvals are rejected.
- **Sandboxes.** The sandbox holds none of Keeper's environment variables,
  cannot reach the broker, and cannot read another domain's workspace.

**Depends on:** the desktop accepting Keeper's drafts; optionally WF-07 and
WF-08 and the job kinds.

### Phase 4 — Scale, govern, extend

- A coordinator and workers; domain sharding; scale-to-zero through the
  operator listener; hosting many communities (§15.4).
- Desktop admin experience: observation, budgets, approvers, MCP connections,
  packs.
- Distribution of packs, and a review process for packs that ship code.
- FIDES-style integrity labels, and complete mediation for private domains.
- Evals in CI; cost reports; an elevated rate tier.

---

## 17. Testing and validation

These tests follow [TESTING.md](../TESTING.md): bind regression tests to
production seams, make them falsifiable, and give pure predicates table tests
over their whole input space.

| Layer | What | How |
|---|---|---|
| Policy predicates | Label reads and publishes; action class × role × channel type; approver eligibility; routing rules | Table tests over the full input space |
| Durability | Exactly-once under crashes | The real Keeper process against a local relay (`just relay`), with pi-ai's faux provider. Kill it at random points, including between committing an answer and publishing it, and between publishing and the relay's `OK`. Check the outcome by querying the relay. |
| Gaps and ordering | Replay overlap and reconciliation | Inject events with `created_at` up to 900 s in the past; drop live deliveries; check every event is processed exactly once |
| Information flow | Noninterference | The draft's *two worlds*. Run the same public request in two worlds that differ only in a private secret, against a scripted adversarial faux model that tries to read the secret and post it. The public-visible output must be identical in both worlds, and the attempt must be blocked and logged. |
| Multiplayer | Steering, context, stop | Scripted multi-person threads. Check placement at tool boundaries and that requesters are attributed correctly. |
| Memory quality | Extraction precision and recall | Evals over a labeled corpus (pi's evals package) |
| Load | Ingest lag, commit latency, memory per open domain | N channels × M messages per minute |
| Real use | People using it | The desktop app against a local relay. An agent exercises the flow first, then a human tests it ([AGENTS.md](../AGENTS.md#before-opening-a-pr)). |

**Every guard has a test that fails without it.** Removing any label check,
the outbox memo, or the epoch check must break at least one test. TESTING.md
puts it this way: a guard whose removal fails no test protects nothing.

---

## 18. Decisions needed and open questions

### Decisions, with a recommendation each

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Working name | **Keeper**; each organization picks the display name | Unused in Buzz. "Hive" is in the desktop's persona name pool; "steward" means an admin or owner row in relay code. |
| D2 | Where the code lives | **Decided:** a `keeper/` TypeScript package in this repository | It must move in lockstep with kinds, relay limits, information-flow rules and desktop rendering. |
| D3 | The first product | **Decided:** the durable research agent (Phase 1), then Keeper's organizational features | Low risk; exercises durability; not blocked on WF-08 or desktop contracts. |
| D4 | Default observation | **`member`** (visible); `open-read` as an opt-in with disclosure | Consent and transparency. |
| D5 | Hosting | **Resident single instance with a persistent volume**; scale-to-zero later | It has to be always on for timers and listening. |
| D6 | Memory substrate | **NIP-AR records** with agreed `buzz.*` client contracts | The relay enforces access; people can edit; no new kind is needed. |
| D7 | Identity | **An organization-owned relay member**, not a NIP-OA credential | It survives staff changes. |
| D8 | Models | **pi-ai with three tiers**; Buzz Mesh optional | Provider choice stays configuration. |
| D9 | Approval experience | **Reactions on cards** | Works in every Buzz client today. |

### Open questions

1. **Key custody.** How is the organization's key rotated, backed up and
   recovered, and who holds the backup?
2. **DMs and audit.** Should workspace admins be able to audit DMs with Keeper?
   The proposed default is no, as for any DM.
3. **History for new members.** No relay read path filters by join time, so
   new members of private channels see the full history. Is that intended? This
   design relies on it to keep epoch rotation rare (§9.3).
4. **Guests.** When channel-scoped guest tokens land, labels change
   automatically. Is that the product intent?
5. **Retention.** What are the defaults for Keeper's journals and indexes?
6. **Joining open channels.** Should open channels allow a silent bot join, or
   is the visible "joined" row a feature?
7. **Cost.** How is model spend allocated across teams?
8. **Personal agents.** Should they adopt Keeper's broker — the draft's local
   broker? If so, extract the broker as a library early.
9. **Job kinds.** Should the relay wire kinds 43001–43006, or retire them?
10. **Mesh.** How does a server-side agent reach Buzz Mesh?

---

## Appendices

### A. Glossary

| Term | Meaning |
|---|---|
| **Audience** | The people allowed to see what happens in a place: a channel's readers, a DM's participants. |
| **Domain** | Keeper's unit of isolation: one audience, one pi-durable harness, one sandbox. |
| **Epoch** | A version of an audience. Membership changes start a new epoch. |
| **Label** | The reader set attached to information. A combination of inputs gets the intersection of their reader sets. |
| **Broker** | Keeper's trusted core. It holds the key, checks every read, publish and action, and signs events. |
| **Requester** | The author of a request placed in a run. Requesters' authority bounds what the run may do. |
| **Action class** | 0 respond · 1 contained write · 2 consequential (needs approval) · 3 never. |
| **Declassification** | A human approving one exact piece of content for one wider destination, once. |
| **Caretaker** | The background conversation that keeps one channel's memory. |
| **Steward** | The `public` domain's conversation for org-wide public upkeep. |
| **Ledger** | Keeper's memory: NIP-AR records on the relay, plus a derived local index. |
| **Outbox** | The mechanism that publishes each reply exactly once. |
| **Proactivity** | How much Keeper says unprompted in a channel: `quiet`, `normal` or `proactive`. |
| **Autonomy** | What Keeper may do unprompted in a channel: `off`, `suggest`, `approve` or `act`. |

### B. Prior art this design reuses

| Source | What it contributes |
|---|---|
| `buzz-acp` | Subscription shapes; membership tracking (44100/44101); thread scoping; workflow-owner attribution; the 👀 and typing conventions |
| [pi-chat](https://github.com/earendil-works/pi-chat) | Per-channel sandbox and workspace; layered memory (account-wide and per channel); secrets substituted at egress; chat control commands; giving the agent everything said since its last answer |
| [Information-flow draft](practical-information-flow-for-buzz-agents.md) | The broker; audience-bound instances; labels; epochs; declassification |
| [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) | The runtime; the persistent-subagent pattern (example 23); environment per conversation (example 29) |
| [Persona packs](../crates/buzz-persona/PERSONA_PACK_SPEC.md) | The pack format |
| [NIP-AR](nips/NIP-AR.md) | The memory and task substrate |

### C. Asks of other components

**Buzz relay**

- Let operators assign the elevated or platform rate tier to specific pubkeys.
- Notify subscribers of new open channels, so discovery does not need polling.
- Wire job kinds 43001–43006, or retire them.
- Optionally, a silent bot join for open channels.
- Nice to have: WF-07 (`send_dm`, `set_channel_topic`) and WF-08 (approvals).
- A Buzz Mesh endpoint reachable by server-side agents.

**Desktop and mobile**

- Render `buzz.decision`, `buzz.task`, `buzz.question` and `buzz.digest`
  records, with a tracker panel.
- Render approval cards; show an "observed by Keeper" indicator.
- Accept workflow drafts from Keeper for a person to sign.
- Keeper settings for workspace admins.

**pi-durable (upstream)**

- Allow `data`, such as an author, on input submissions, carried into `pi.user`
  entries.
- An application-key index for conversations, or `scanDocuments` on `Tx` and
  `Harness`.
- Timers that do not count as live work, and a way to read a closed Session's
  next wake time.
- Concurrency limits in the scheduler.
- The requester's identity available to hooks in task context.
- An official MCP extension for pi-durable.
- A storage-lock helper for single-writer hosting.
- Telemetry spans.
