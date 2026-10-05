# Keeper

Keeper is Buzz's durable organizational agent. This package is its first
product: a **research agent** that anyone in a workspace can mention in a
thread or message directly. It answers questions about the conversation it is
in, searches what the team already discussed, and runs longer research jobs in
the background, posting the report in the thread when it is done — even if the
process restarts in the middle.

The design, the phases and the reasoning behind them are in
[`docs/keeper-org-agent.md`](../docs/keeper-org-agent.md). Keeper is built on
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).

## Status

Phase 0 and most of Phase 1a/1b of the spec (§16) work against a real relay:

- Mentions in threads, one-to-one DMs (no mention needed), and group DMs with a
  mention. Keeper reacts 👀, shows typing, and answers once, in the thread.
- Thread context: the thread so far when Keeper is first asked, later messages
  as context, and edits and deletions applied to what the model sees.
- Research jobs that run in the background and post one report in the thread.
- Tools: `read_thread`, `search_messages`, `research`, and in open channels
  only, `web_fetch` (refuses private addresses) and `web_search` (with a Brave
  Search key). Conversations of private channels and DMs never reach the web.
- `@Keeper status` and `@Keeper stop`.
- One durable store per audience (open channels, each private channel, each
  DM); reads and posts pass the information-flow checks of the
  [information-flow draft](../docs/practical-information-flow-for-buzz-agents.md).
  When a channel changes visibility, its threads move to the new audience.
- Exactly-once replies across crashes; failed events are retried from a durable
  record, and Keeper says so in the thread if it gives up.

Not yet built: MCP servers, skills, budgets, resident deployment, the
crash-injection suite, and epoch rotation when a private channel's membership
narrows. See the spec for the full list.

Known gap: a deleted or edited message is removed from what the model sees,
but copies of it in earlier tool results (`read_thread`, `search_messages`)
stay in that conversation's context.

## Try it in demo mode

Demo mode replaces the model with a scripted one (`KEEPER_MODEL=faux`), so no
API key is needed and everything else — the relay, durability, tools, research
jobs — runs for real. The demo brain echoes what you said, summarizes when you
say "summarize", and starts research when you say "research".

1. Start a local relay (`just relay`, see the repository README) and note its
   host. **Use the same host everywhere** — the relay serves one community per
   host, so `localhost:3000` and `127.0.0.1:3000` are different workspaces.
2. Create Keeper's identity and add it to a channel as a bot:

   ```bash
   cargo run -p buzz-admin -- generate-key        # note the private and public key
   buzz channels add-member --channel <channel-uuid> --pubkey <keeper-pubkey> --role bot
   ```

3. Run Keeper:

   ```bash
   cd keeper
   pnpm install
   KEEPER_RELAY_URL=ws://localhost:3000 \
   KEEPER_PRIVATE_KEY=<keeper-private-key> \
   KEEPER_MODEL=faux \
   pnpm start
   ```

4. In that channel, in the desktop app or with the CLI:
   - `@Keeper hello` → one reply in the thread, starting "Hi <your name>!".
   - Reply in a thread with two earlier messages: `@Keeper summarize this` →
     "I read this thread: 3 messages from …".
   - `@Keeper research pricing` → "On it…", then a 📋 research report in the
     same thread.
   - `@Keeper status` in that thread → idle/working, queued items and research
     jobs.
   - Stop Keeper (Ctrl-C, or `kill -9` to simulate a crash), mention it while
     it is down, and start it again: it answers the missed mention once and
     repeats nothing it already said.

To use a real model, set `KEEPER_MODEL=<provider>/<model-id>` and the
provider's credentials in the usual pi-ai variables (for example
`ANTHROPIC_API_KEY`).

## Configuration

Keeper reads its settings from the environment; `pnpm start --help` prints
them.

| Variable | Meaning |
|---|---|
| `KEEPER_RELAY_URL` | Relay WebSocket URL (required) |
| `KEEPER_PRIVATE_KEY` / `KEEPER_PRIVATE_KEY_FILE` | Keeper's key, hex or nsec (required) |
| `KEEPER_MODEL` | `provider/model-id`, or `faux` for demo mode (required) |
| `KEEPER_RESEARCH_MODEL` | Model for research jobs (default: `KEEPER_MODEL`) |
| `KEEPER_DATA_DIR` | Durable state (default: `./keeper-data`) |
| `KEEPER_NAME`, `KEEPER_ABOUT` | Profile name and description |
| `KEEPER_AUTH_TAG` | NIP-OA auth tag as JSON, when admitted through an owner |
| `KEEPER_ALLOWED_AGENTS` | Pubkeys of agents allowed to wake Keeper; other agents are ignored |
| `BRAVE_SEARCH_API_KEY` | Enables `web_search` |
| `KEEPER_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` |

Run one Keeper process per data directory: pi-durable stores have no
cross-process lock.

## How it works

```
relay ──► RelayClient ──► Keeper (service) ──► router ──► Domain (pi-durable Harness per audience)
                                │                              │
                                └── ControlStore               ├── thread conversations
                                    (cursors, threads,         ├── reply tasks ──► Broker ──► relay
                                     messages, retries,        └── research conversations + reporters
                                     controls)
```

| Path | Role |
|---|---|
| `src/relay/client.ts` | One NIP-01/NIP-42 connection: auth, subscriptions re-sent after reconnects and passing refusals, paged queries, publishes that wait for `OK` |
| `src/service/keeper.ts` | The service: channel discovery and membership, ordered catch-up, per-thread queues, requests, context, edits, control commands, retries, idle domains |
| `src/service/router.ts` | Pure decision for each relay event: request, context, control, edit, deletion, or ignore |
| `src/service/control.ts` | Process-wide SQLite: replay cursors (900 s overlap), thread and message indexes, retry records, control commands carried out |
| `src/service/reply-task.ts`, `publish.ts` | Durable reply task: waits for the answer, then publishes memoized signed events exactly once |
| `src/broker/` | The only holder of the key; reader sets from relay-signed metadata; read and publish checks |
| `src/runtime/` | Domains (one pi-durable Harness per audience), durable documents, message rendering |
| `src/agent/` | Prompt sections, tools, research jobs, search provider, the demo brain |
| `src/ifc/labels.ts` | Reader-set lattice, ported from `crates/ifc-core` and tested against the same fixtures |
| `src/net/safe-fetch.ts` | Web fetch that refuses private addresses, checked at DNS lookup and on every redirect |

Guarantees and where they come from:

- **Exactly one reply per request.** Each request gets a background reply task.
  The task memoizes the signed event before publishing it, so a rerun after a
  crash publishes the same event id and the relay deduplicates it.
- **Nothing missed across restarts.** Each channel's cursor stays below any
  event still being handled, and replays start 900 seconds before it — the
  relay accepts timestamps up to 900 seconds from its clock. Missed events are
  paged in past the relay's page limit and handled oldest first. Every effect
  is idempotent by event id: requests, context and edits through pi-durable
  request ids, control commands through the control store.
- **Failures are retried, then reported.** An event whose handling fails is
  recorded with a backoff and retried, also after a restart. After the last
  attempt, Keeper tells the thread it could not take the request. A reply or
  report the relay refuses for good is recorded as failed, never lost.
- **Audience isolation.** Open channels share one store; each private channel
  and each DM has its own. A conversation can only read content its audience
  may see and only post where its audience may read. Channel facts come only
  from relay-signed metadata, applied newest first as they change.

## Development

```bash
pnpm install
pnpm test     # unit tests and end-to-end tests against an in-process fake relay
pnpm check    # Biome and TypeScript
```

The end-to-end tests (`test/keeper.e2e.test.ts`) run the production service
against `test/fake-relay.ts` with the demo brain, including restarts, lost
`OK`s and failing relay queries.
