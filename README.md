# paseo-agent-manager

One Paseo plugin with two jobs, so they share a single plugin process:

1. **Auto-cleanup** — archived workspaces, agents and projects are deleted on a daily timer, whether
   or not the app is open, and orphan pi session files are swept with them
   (see [Auto-cleanup](#auto-cleanup)).
2. **OpenCode Go usage** — a quota card in Paseo's Usage view for the subscription pi is logged into
   (see [Usage source](#usage-source)). This was the separate `pi-opencode-go-usage` plugin until the
   two were merged; the plugin id and the usage-source id are unchanged, so stored settings, the
   cleanup state and cached usage accounts all carry over.

The only client contribution is the **Auto-cleanup settings screen** (Settings → Plugins →
agent-manager): the switches, the schedule and one destructive button. The composer pill, the tab
list and the manager panel are gone, and so is workspace isolation: the plugin never creates, moves
or removes a checkout, never reads project git state and does not collect host metrics.

## Why there is no runtime release here

Releasing idle agent runtimes was this plugin's other job, from a 15-minute sweep down to an
event-driven release after each turn. Paseo now does that itself: from 0.14 on, the daemon releases a
resumable runtime after an idle hour when its own work guards and the provider's `canStopRuntime()`
check agree, configured per host with **Settings → host → Agents → Release idle agents** (or
`agents.idleRuntimeCleanup`). That path also sees what a plugin cannot — in-flight turns, provider
background tasks, ACP terminals, subagent families and pending finish notifications — so the plugin's
release half was removed rather than kept as a weaker duplicate. Anything that still runs 0.13 or
older keeps its runtimes until the app or the daemon restarts; nothing in this plugin will release
them.

Deleting records is the part Paseo does not do, so that is all this plugin does now.

## Auto-cleanup

The whole timer has a master switch in the plugin settings — **Auto-cleanup**, on by default. Turn it
off and the timer stops entirely: nothing is deleted automatically, and only the **Privacy cleanup**
button deletes.

**One timer, one job, no polling.** It is armed for the exact moment the cleanup is due — the
**cleanup interval** (`24` hours by default) after the last run — and re-arms itself afterwards. It
runs earlier when

1. any of the three delete switches changed since the last run, so turning a switch on does not wait
   out a day, or
2. no cleanup has ever run on this host.

A settings change re-arms the timer on the spot instead of being noticed at the next wake-up. The
delay is re-derived from the clock on every wake-up, so a reload, a clock jump or a long sleep cannot
postpone the cleanup indefinitely: the timestamp of the last run lives in
`~/.paseo/agent-manager/auto-cleanup.json` and the first wake-up after load compares against it.

Nothing else wakes up: no per-session timer, no per-agent timer, no extra timer for the passes a
cleanup runs. A run that is still going when a settings change arrives is not interrupted; the timer
re-arms once it finishes, so slow work can never run twice. A failed pass is not recorded as done: it
stays due and retries an hour later with its error in the state file. The plugin's own daemon
connection is opened lazily and kept for the lifetime of the plugin (closed on unload).

When it runs, the two archived-item switches decide what goes — see
[Deleting archived workspaces and agents](#deleting-archived-workspaces-and-agents).

## Background workspaces

Paseo 0.12 hides background workspaces — the ones `paseo run --no-wait` creates — from public agent
discovery unless the filter asks for them. The listing asks (`includeBackground: true`), so an
archived agent behind a workspace no sidebar shows is still cleaned up. The plugin uses the daemon's
own client, which on a 0.11 host strips the unknown filter key and behaves exactly as before, so the
plugin still requires only Paseo `>=0.11.0`.

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

`server/pi-sessions.ts` holds everything pi-specific: how a transcript is recognised, where pi stores
sessions, and how they are enumerated. The cleanup calls exactly two functions from it —
`deleteAgentTranscripts(agents)` and `sweepOrphanSessions()` — and never mentions a provider itself.
Adding one means teaching those two functions about it; nothing else in the plugin changes.

## Structure

Eight small modules, one job each: nothing here polls, retries per item, or keeps a second source of
truth.

| File | Job |
| --- | --- |
| `index.server.ts` | wire settings → timer → RPC, and nothing else |
| `server/cleanup.ts` | the due-timer, the state file, one snapshot, one plan, one pass |
| `server/settings.ts` | in-memory settings document plus the environment overrides |
| `server/registry.ts` | `workspaces.json` / `projects.json` reads and the removed-workspace ledger |
| `server/pi-sessions.ts` | pi transcripts: delete one, sweep the orphans |
| `server/daemon.ts` | `$PASEO_HOME`, the daemon client, the one agent listing |
| `server/cli.ts` | `paseo agent delete` / `paseo project delete` |
| `server/usage-source.ts` | the OpenCode Go quota source: read pi's login store, ask the API |
| `server/guard.ts`, `server/util.ts` | crash guards, atomic and serialized writes |

## Usage source

Paseo already ships an `opencode-go` usage source, but it reads the OpenCode CLI's login store
(`~/.local/share/opencode/auth.json`, entry `{ type: "api", key }`). pi keeps the same provider in its
own store (`<agent-dir>/auth.json`, entry `{ type: "api_key", key }`), which the built-in source never
looks at. This plugin registers a second source, `pi-opencode-go`, that reads pi's store, calls
`https://opencode.ai/zen/go/v1/usage` and shows the **Rolling**, **Weekly** and **Monthly** windows.

- Read-only: it reads one file and makes one HTTPS request, and writes nothing back.
- The API key is never logged, never part of a report and never stored. The daemon only sees a stable
  hash of the login-store path as the account key.
- The quota is account-wide rather than per session, so only a global discovery is offered, and the
  store is re-read on every fetch — a pi re-login takes effect without rediscovery.
- `PI_CODING_AGENT_DIR` moves the store; otherwise it is `$HOME/.pi/agent`.

## Settings

The plugin registers one host-scoped settings document (`auto-release`, its stored id, so existing
hosts keep their switches), so the app's plugin settings screen can change all of it; every value has
a default and nothing has to be configured to work.

| Setting | Default | Meaning |
| --- | --- | --- |
| Auto-cleanup | on | run the timer; off stops every automatic deletion (the button still works) |
| Cleanup every (hours) | `24` | how long after a cleanup the next one comes due |
| Delete pi session files | off | also delete the pi transcript when an agent is deleted; off deletes Paseo records only |
| Delete archived workspaces | off | delete every archived workspace, with the agents inside it |
| Delete archived agents | off | delete every archived agent, even in a workspace that is not archived |
| Privacy cleanup | — | button: run every pass now — archived workspaces, agents and projects, plus orphan pi sessions while pi session files are on — without waiting for the interval |

Values live in `~/.paseo/plugin-settings/agent-manager/auto-release.json` (`{ version, values }`, with the
zod schema as the contract; a v1 or v2 document is migrated on read). An operator can override any of
them from the daemon environment, and the environment wins — handy for a one-off purge or a quick
timing experiment without touching the app. A value that is not a positive number is ignored:

| Environment variable | Overrides |
| --- | --- |
| `PASEO_AGENT_MANAGER_ENABLED` | `1`/`0` — turn the whole timer off (or back on) without the app |
| `PASEO_AGENT_MANAGER_CLEANUP_INTERVAL_MS` | cleanup interval in ms, minimum `60000` |
| `PASEO_AGENT_MANAGER_DELETE_PROVIDER_SESSIONS` | `1`/`0` — delete pi transcripts too |
| `PASEO_AGENT_MANAGER_DELETE_ARCHIVED_WORKSPACES` | `1`/`0` — delete archived workspaces |
| `PASEO_AGENT_MANAGER_DELETE_ARCHIVED_AGENTS` | `1`/`0` — delete archived agents |
| `PASEO_AGENT_MANAGER_PURGE_ARCHIVED` | `1`/`0` — legacy alias: sets both archived switches |

### Languages

The settings screen ships English and Simplified Chinese resources in `client/locales/`. On Paseo
0.13+ the labels follow the app language; on 0.11/0.12 hosts, where the translation API does not
exist, the client bundle falls back to English instead of failing to load. The manifest also carries
a `zh-CN` name and description for the plugin registry; Paseo itself does not read that field.

### Earlier profiles

The release-era designs are kept as tags, not branches, because both are ancestors of this code: a
host that wants one of them back checks it out and reloads — no rebuild.

| Tag | What it does |
| --- | --- |
| `baseline-idle-10min` | the old release: a 10-minute idle window, a 15-minute sweep and a due timer |
| `idle-1min-profile` | experiment: a 1-minute idle window with a 1-minute sweep |

```bash
git checkout baseline-idle-10min && paseo reload
```

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager
paseo plugin update agent-manager --yes     # later
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. Install once per daemon;
the settings screen appears on every client connected to that host.

Needs Paseo 0.11.0+ (settings screens and `execCommand`). Runtime translations use the 0.13 API
when the host has it and fall back to English on older hosts, so the minimum stays 0.11.0. Nothing
extra is installed: the plugin uses the daemon's own client, the session protocol on
`ws://<daemon.listen>/ws` and the `paseo` CLI for hard deletes.

## Logs

The plugin's server output goes to the daemon's plugin log — `paseo plugin logs agent-manager`, or the
plugin's log view in the app. It is ordinary stdout/stderr: whatever the server half prints, one entry
per line, tagged `stdout` or `stderr` and timestamped (the client half prints to the app's own console
instead). The timer writes a line only when it actually did something:

| When | Line |
| --- | --- |
| a cleanup removed an archived workspace | `删除 归档workspace <name> 和里面 4 个agent，成功删除对应session 4 个` |
| a cleanup removed archived agents outside archived workspaces | `删除了 3 个归档agent（所在workspace未归档）` |
| the privacy button removed archived projects | `删除了 2 个归档project` |
| the privacy button removed unmanaged sessions | `删除 73 个 paseo无记录session` |

Failures keep their own `agent-manager …` lines. Everything else, silence.

## Client code

The settings screen is the only client-side contribution; its labels follow the app language on
Paseo 0.13+ and stay English on older hosts. A client only picks up plugin code when it fetches the
catalog — at connect, or when the daemon announces `plugin_catalog_changed` after an install, a
reload or an update. A phone that was asleep or offline during the change keeps running the bundle it
already has until it reconnects.

## Development

```bash
npm ci
npm run typecheck
```

The plugin runs from source: point the daemon at this directory and reload it (`paseo plugin install
<path>`, then `paseo reload`). `index.client.tsx` and `index.server.ts` are the two halves Paseo
compiles; `shared/contracts.ts` is the RPC surface between them (one call: the privacy-cleanup
button).

MIT
