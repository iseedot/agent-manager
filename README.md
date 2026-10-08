# paseo-agent-manager

A Paseo plugin with two jobs:

1. **Composer pill** — one pill above the composer, titled `Tabs`, that shows
   the open tabs of that workspace and lets you switch, close or open one.
2. **Auto-release** — agent runtimes are released once their turn is over, whether or not the app is
   open: one 15-minute tick releases everything that is not working or waiting on you and, once a
   day, deletes the archived workspaces and agents the settings name (see [Auto-release](#auto-release)).

The manager panel is gone, and so is every workspace-isolation behaviour: the plugin never creates,
moves or removes a checkout, never reads project git state and no longer collects host metrics. It only
watches the daemon's session stream and runs the timer.

## The composer pill

One pill sits above the composer and follows the session it belongs to. Its **title is the fixed
`Tabs`** and its label carries the open tab count (`3 tabs`, or `Tabs` when the workspace has none),
because Paseo rejects a label that is empty or whitespace. Opening the pill shows:

- every open tab of this workspace, newest first, each with its state — `running`, `unread` (the turn
  finished and has not been looked at), `needs input` (waiting on a permission), `failed`, `idle` (a
  runtime is held but nothing is working) or `no runtime` — and a `×` that archives that tab without
  switching to it first, the current tab included. The current tab is highlighted and inert; picking
  another focuses it through the same navigation the app uses, so it switches workspace and tab,
- `New Agent`,
- the `ui <code>` build stamp.

**New agent** fires Paseo's own new-agent action on desktop and web — the one behind the tab bar `+`
menu and `Ctrl+Shift+A` / `Cmd+Shift+A` — so the usual draft tab opens. Native hosts have no keyboard
layer, so it opens the same draft through Paseo's own `paseo:` deep link (`?open=draft:…`); the tab
appears instantly and the session is created when the first message is sent. If the host cannot open
that link either, it creates the session through the daemon and jumps to it.

Switching tabs goes through a tiny redirect surface, because a composer pill has no navigation of its
own. That surface subscribes to focus requests instead of reading one at mount, so a request that
arrives while it is already mounted — a second pick before the first navigation lands — still switches.

One daemon observation backs the pill: the agent stream, opened when the plugin loads and kept for its
lifetime, so a session that appears, is restored or is removed gains or loses its pill without a
refetch and the tab counts and states stay current. Nothing is polled.

## Auto-release

The whole timer has a master switch in the plugin settings — **Auto-release**, on by default. Turn it
off and the timer stops entirely: no runtime is released, neither on the tick nor when a turn ends,
and no automatic cleanup runs. The settings screen's **Privacy cleanup** button still works.

**One timer.** A tick every fifteen minutes does both jobs, and it keeps working while the app is
closed:

1. **Release.** The daemon's session list is read once and every runtime that is neither working nor
   waiting on the user is released. There is no idle window any more — the tick is the resolution, so a
   runtime lives at most one tick past its last turn. Three protections remain: a runtime that is
   `running`, one that is still `initializing` (a slow provider boot must not be killed half-way) and
   one waiting on a permission (`attentionReason: permission` or a pending permission request) are never
   released, and a runtime the daemon touched inside the **grace window** (five minutes) is left for the
   next tick, so a turn that ends just before a tick is not released while its answer is still being
   read.
2. **Cleanup, once a day.** The two delete switches decide what goes — see
   [Deleting archived workspaces and agents](#deleting-archived-workspaces-and-agents).
   **Delete archived workspaces** removes every archived workspace with the agents inside it;
   **Delete archived agents** removes every archived agent whose workspace is not archived. Nothing
   depends on it being prompt, so it rides on the tick but at most every twenty-four hours. The
   timestamp lives in the state file, so a reload cannot postpone it forever, and the session list the
   release pass already read is reused instead of listing twice. When that listing failed the phase is
   skipped entirely.

Nothing else wakes up: no per-session timer, no due timer, and no second timer for the phases a tick
triggers. A phase that is still running when the next tick arrives is skipped by its own flag, so slow
work can never run twice and can never hold the release pass back. The plugin's own daemon connection is
opened lazily and kept for the lifetime of the plugin (closed on unload), and only the last tick is
remembered in `~/.paseo/agent-manager/auto-release.json`.

Releasing goes through the daemon's own close action (MCP `kill_agent`), so the record stays valid and
the next message resumes the session.

## Deleting archived workspaces and agents

By default "archived" is reversible: the records stay and the automatic cleanup does nothing. Two
independent switches make it final, once a day or from the **Privacy cleanup** button:

- **Delete archived workspaces** — every archived workspace is deleted, with every agent inside it.
- **Delete archived agents** — every archived agent is deleted, even one whose workspace is not
  archived (or has none). An agent inside an archived workspace belongs to the first switch.

```
Delete archived workspaces
  └─ `paseo agent delete` for each agent inside
  └─ drop the workspace record

Delete archived agents
  └─ every archived agent whose workspace is not archived (or has none)
  └─ `paseo agent delete`

Delete pi session files (both passes)
  └─ pi agent?  → delete its transcript (persistence.nativeHandle)
```

**Delete pi session files** is the one switch that touches a provider's own files: with it on, every
agent the two passes remove also has its pi transcript deleted. With it off they remove Paseo records
only. Only **pi** is supported: it is the one provider that writes the absolute path of its transcript
into the agent record (`persistence.nativeHandle`), so the file can be deleted exactly. Every other
provider either keeps its transcript where this plugin cannot know (opencode, the ACP agents: copilot,
cursor, kimi, kiro, trae, hermes) or names it with an id instead of a path (claude, codex) — guessed
paths would risk deleting a file that was never ours, so those are left alone.

## Privacy cleanup

**Privacy cleanup** is the one button, drawn in the theme's danger colour and with no second
confirmation. It runs every pass at once, without waiting for the cleanup interval, and ignores the two
delete switches: everything archived goes.

```
every archived workspace   + its agents
every archived agent       + even one whose workspace is not archived
every archived project     + its workspaces and agents
orphan pi sessions           only while pi session files are on
```

The result is that only the pi sessions, workspaces and projects a live agent still references remain.
The project pass goes through the daemon's own `paseo project delete`, so the registries stay
consistent.

The orphan sweep inside it enumerates pi's own session store and deletes every transcript that **no
Paseo agent record references** — sessions created by running the provider directly, outside Paseo. It
only runs while **Delete pi session files** is on, because it is the pass that touches the provider's
files.

For **pi** the store is `<agent-dir>/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl` (agent dir
`~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it; `PI_CODING_AGENT_SESSION_DIR`, the
`sessionDir` setting and `--session-dir` can move the session root, so the sweep trusts any root it
can infer from the absolute paths Paseo recorded). A file is kept when either its absolute path or its
session id appears in an agent record. Only `*.jsonl` transcripts are touched.

This is irreversible and can delete a session you were still using outside Paseo.

### Provider sessions are not coupled

The two session-deleting paths never hard-code a provider in the cleanup code:

- `server/provider-sessions.ts` is the dispatcher. It reads each agent's `persistence`, then routes
  through a `switch (provider)` — one `case` per provider — for both "delete the session behind this
  agent" (the workspace and agent passes) and "delete every session this provider has that Paseo does
  not" (the orphan sweep).
- `server/provider-sessions-pi.ts` holds **everything pi-specific**: how a transcript is recognised,
  where pi stores sessions, and how they are enumerated.

Adding a provider means one new sibling module and one `case` in each `switch`; nothing else in the
plugin changes.

Switching a delete switch on makes the cleanup due on the next tick instead of waiting out the
interval, so a deletion does not sit for a day after it was asked for.

This is irreversible: after the cleanup the workspace, its agents and (while pi session files are on)
the pi transcripts cannot be restored. Nothing in the plugin ever deletes project content, only
records and the pi transcript.

## Settings

The plugin registers one host-scoped settings document (`auto-release`), so the app's plugin settings
screen can change all of it; every value has a default and nothing has to be configured to work.

| Setting | Default | Meaning |
| --- | --- | --- |
| Auto-release | on | run the timer; off stops release and the automatic cleanup (the button still works) |
| Tick every (minutes) | `15` | the single timer's cadence |
| Grace (minutes) | `5` | a runtime touched this recently waits for the next tick (`0` releases on the tick) |
| Cleanup every (hours) | `24` | how often the destructive phase may run |
| Delete pi session files | off | also delete the pi transcript when an agent is deleted; off deletes Paseo records only |
| Delete archived workspaces | off | delete every archived workspace, with the agents inside it |
| Delete archived agents | off | delete every archived agent, even in a workspace that is not archived |
| Privacy cleanup | — | button: run every pass now — archived workspaces, agents and projects, plus orphan pi sessions while pi session files are on — without waiting for the cleanup interval |

Values live in `~/.paseo/plugin-settings/agent-manager/auto-release.json` (`{ version, values }`, with the
zod schema as the contract). An operator can override any of them from the daemon environment, and the
environment wins — handy for a one-off purge or a quick timing experiment without touching the app. A
value that is not a positive number is ignored:

| Environment variable | Overrides |
| --- | --- |
| `PASEO_AGENT_MANAGER_ENABLED` | `1`/`0` — turn the whole timer off (or back on) without the app |
| `PASEO_AGENT_MANAGER_SWEEP_INTERVAL_MS` | tick cadence in ms, minimum `5000` |
| `PASEO_AGENT_MANAGER_GRACE_MINUTES` | grace in minutes |
| `PASEO_AGENT_MANAGER_CLEANUP_INTERVAL_MS` | cleanup interval in ms, minimum `60000` |
| `PASEO_AGENT_MANAGER_DELETE_PROVIDER_SESSIONS` | `1`/`0` — delete pi transcripts too |
| `PASEO_AGENT_MANAGER_DELETE_ARCHIVED_WORKSPACES` | `1`/`0` — delete archived workspaces |
| `PASEO_AGENT_MANAGER_DELETE_ARCHIVED_AGENTS` | `1`/`0` — delete archived agents |
| `PASEO_AGENT_MANAGER_PURGE_ARCHIVED` | `1`/`0` — legacy alias: sets both archived switches |

### Earlier profiles

Two earlier designs are kept as tags, not branches, because both are ancestors of this code: a host
that wants one of them back checks it out and reloads — no rebuild.

| Tag | What it does |
| --- | --- |
| `baseline-idle-10min` | upstream: a 10-minute idle window, a 15-minute sweep and a due timer |
| `idle-1min-profile` | experiment: a 1-minute window with a 1-minute sweep |

```bash
git checkout baseline-idle-10min && paseo reload
```

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager
paseo plugin update agent-manager --yes     # later
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. Install once per daemon;
every client connected to that host (including the official iOS app) gets the pill.

Needs Paseo 0.11.0+ (screens and `execCommand`). Nothing extra is installed: the plugin uses the daemon's own client, the session
protocol on `ws://<daemon.listen>/ws` and the `paseo` CLI for hard deletes.

## Logs

The plugin's server output goes to the daemon's plugin log — `paseo plugin logs agent-manager`, or the
plugin's log view in the app. It is ordinary stdout/stderr: whatever the server half prints, one entry
per line, tagged `stdout` or `stderr` and timestamped (the client half prints to the app's own console
instead). The tick writes a line when it actually did something:

| When | Line |
| --- | --- |
| a sweep released runtimes | `释放了 3 个进程，当前系统 mem 52% swap 13%` |
| a cleanup removed an archived workspace | `释放 归档workspace <name> 和里面 4 个agent，成功删除对应session 4 个` |
| a cleanup removed archived agents outside archived workspaces | `删除了 3 个归档agent（所在workspace未归档）` |
| the privacy button removed archived projects | `删除了 2 个归档project` |
| the privacy button removed unmanaged sessions | `删除 73 个 paseo无记录session` |

Failures keep their own `agent-manager …` lines. Everything else, silence.

## Checking which build a client runs

A client only picks up plugin code when it fetches the catalog — at connect, or when the daemon
announces `plugin_catalog_changed` after an install, a reload or an update. A phone that was asleep or
offline during the change keeps running the bundle it already has until it reconnects.

The bottom of the pill popover shows a `ui <code>` stamp derived from the client code that is actually
executing, so a stale client is easy to spot: compare it with the code the current source produces.

## Development

```bash
npm ci
npm run typecheck
```

The plugin runs from source: point the daemon at this directory and reload it (`paseo plugin install
<path>`, then `paseo reload`). `index.client.tsx` and `index.server.ts` are the two halves Paseo
compiles; `shared/contracts.ts` is the RPC surface between them (one call: the host id for native
draft deep links).

MIT
