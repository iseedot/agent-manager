# paseo-agent-manager

A Paseo plugin that manages every Paseo workspace on a host as a workspace: it shows how many
sessions each one holds, how much memory they keep alive, and lets you release, archive, activate, or
delete the whole workspace from one panel. Idle runtimes are released automatically on a timer.

## What it does

- Lists every workspace on the host with its session count, how many sessions hold a process, the
  memory they hold, its path, project, kind, and whether it is active or archived. The panel has no
  session rows: sessions are managed through their workspace.
- **Release workspace (N)** closes the provider runtime of every session in that workspace that holds
  a process. Sessions stay in the workspace as `closed` and start a fresh process on their next
  message.
- **Release idle everywhere (N)** does the same for every idle session on the host in one tap.
- **Close tabs (N)** closes every open tab of a workspace through the app's own close-tab path: the
  sessions are archived, their processes stop, and the workspace record stays active.
- **Reopen tabs (N)** reopens the workspace's archived sessions and releases them again, so the tabs
  come back without holding memory.
- **Archive** stops everything a workspace owns and hides it from the app; **Activate** restores an
  archived workspace, reopens every tab, and releases each reopened session; **Delete** removes an
  archived workspace and its sessions for good.
- **Terminals** are managed next to sessions: each workspace row shows how many terminals it has,
  what they hold in memory, and how many are running a command, and `Close terminals (N)` closes
  them (with a confirmation when a command is running). Archiving a workspace kills its terminals
  through the daemon, so there is nothing left behind.
- **Auto-release** keeps memory in check on its own: a session is released shortly after it has been
  idle for more than 10 minutes. It is on by default and can be switched off in the panel.

## Where the controls appear

The whole plugin is one screen: **Agent Manager** in the app sidebar. There is no per-tab button; the
panel's unit is the workspace.

```
14 workspaces · 1 active · 13 archived
dev · 21 sessions · 3 holding a process · 320 MB
load 0.42 · cpu 12% · mem 668M/961M · swap 238M/3.0G
21 sessions · 1 holding a process · 150 MB
┌ Idle memory ───────────────────── [Auto-release on] [Check now] ┐
│ Releases a session 10 min after its last activity, and every idle session when the plugin loads. │
│ Last check 2m ago, released 1.                                    │
│ Empty workspaces                                   [Auto-delete on]│
└───────────────────────────────────────────────────────────────────┘
[Release idle everywhere (1)]  [Refresh]

paseo plugin work                              [active] [2 holding · 120 MB]
/home/you/project · 6 sessions · 1 running · my-project
[Reopen tabs (2)]  [Release workspace (2)]  [Close tabs (4)]  [Archive]

old scratch work                               [archived]
/home/you/project · 1 sessions · 0 running · my-project · archived 15d ago
[Activate]  [Delete]
```

Archived workspaces are listed in the same list, after the active ones: the app hides them
everywhere else, so this panel is where they can be found again.

While a workspace job runs the panel shows its progress (`Reopening tabs 2/7 · <title>`) and the
outcome when it finishes. A job reopens one tab at a time, so the daemon never holds more than one
reopened process at once. Action buttons lock for a moment after each action, so a re-sorted list
cannot send a second tap to a different row.

### Reading and refreshing

The panel reads when it opens and then keeps what it has for 30 seconds; regaining window focus does
not refetch, and nothing polls in the background. `Refresh` (or any action) is what pulls new data,
except while a workspace job is running, which polls its own progress. The two `/proc` scans the
panel needs (sessions and terminal shells) share one cached sample for 800 ms, so opening the panel
scans the process table once instead of twice. Release and verification paths bypass that cache, so
they always see the current process table.

On a phone the panel keeps the same structure but the action buttons become a two-column grid with
short labels (`Release (2)`, `Reopen (2)`, `Tabs (4)`, `Terminals (2)`, `Archive`), the workspace
facts move into one wrapped line instead of pills, and the header lines may use two lines.

### Host line

Under the workspace summary the panel shows the host itself, top style: load average, CPU busy
across all cores, used/total memory, and used/total swap (only when the host has swap). CPU is a
120 ms sample reused for ten seconds, so opening the panel costs one sample, and the memory number
uses the same definition as `free` and `top` on a current procps (`total - MemAvailable`).
Values turn yellow when memory passes 90 %, swap 50 %, or CPU 80 %. On a host without `/proc` the
line is omitted.

### Auto-release

- **Always on, with no switch in the panel** (it is the point of the plugin). The plugin watches the daemon's agent stream, so a session
  is released shortly after it has been idle for `idleMinutes` (default 10). There is no polling loop
  behind that timing.
- **Per-session timers**: one is armed when a session becomes idle (the plugin sees the status change
  on the agent stream) and cancelled as soon as the session starts a turn, needs your attention, or
  gets archived. Before releasing, the plugin re-reads the session and only touches sessions that are
  still idle. The panel does not report it or offer a switch; intervals live in
  `~/.paseo/agent-manager/auto-release.json` for anyone who wants to change them.
- **On load** (`onLoad`, default `allIdle`): when the plugin loads — a plugin reload, a daemon
  restart, or the first start after boot — every idle session is released once, because a session
  that went idle before the plugin started produces no status change to react to. `threshold` releases
  only those already past the idle age, `off` skips the pass.
- **Safety sweep** every `intervalMinutes` (default 30): re-arms missing timers and releases anything
  the event path missed (daemon restart, dropped events, plugin reloaded mid-idle).
- **Empty workspaces** (always on): a workspace with no session records at
  all is removed — archived ones on every sweep, and archiving an empty workspace removes it right
  away instead of keeping an empty record. The one exception is the last active workspace at a path:
  it is archived rather than deleted, because Paseo resolves directory workspaces by path and would
  reopen some record there anyway. The next sweep removes it once another workspace at that path is
  active.
- Releasing never deletes anything: the session stays `closed`, its history is intact, and the next
  message starts a new process. Sessions waiting for your attention (`requiresAttention`) are skipped
  and counted.
- State and intervals live in `~/.paseo/agent-manager/auto-release.json` per host. While auto-release
  is on, the plugin keeps its local connection open (it carries the agent stream); it closes again
  when the switch is turned off.

### Terminals

- Terminals belong to a workspace (`workspaceId`), so the panel shows them per workspace and closes
  them per workspace. Memory is attributed by walking the terminal worker's shells in `/proc`: the
  shell plus everything it started, which is why a terminal running a build or a dev server can show
  hundreds of megabytes while an idle shell shows about 5 MB.
- A terminal counts as **busy** when its shell has child processes, which is what Paseo 0.9.2 gives
  us: it does not report terminal activity for plain shells (that needs shell integration, which the
  default profiles do not install), so the plugin reads the process tree instead.
- `Close terminals (N)` asks for confirmation only when at least one terminal is busy, because that
  stops whatever it is running. Killing a terminal loses its scrollback; it is not a "release".
- Auto-release does not close terminals on a timer: an idle shell is ~5 MB, and the terminals worth
  reclaiming are the ones running something, which is exactly what should not be killed unattended.
  Archiving a workspace (and therefore deleting one) closes its terminals through the daemon.

### What a workspace action can and cannot touch

Every workspace action is addressed by workspace id, never by directory path, and the plugin verifies
afterwards that no other workspace in the project changed state. Two cases are worth knowing:

- **Archive** stops only the sessions and terminals that this workspace owns. It refuses to archive
  the last active workspace at a path unless you confirm, because Paseo resolves *directory*
  workspaces by path: with no active workspace at `/path`, the next time that project opens, Paseo
  reopens the oldest archived workspace at `/path`. That looks like a different workspace taking
  over. The confirmation names the workspace that would be reopened.
- **Activate** restores only the workspace you picked. If another workspace for the same path is
  already active — for example one Paseo reopened by itself — the job leaves it alone; the row shows
  `+N active here` so the situation is visible without a paragraph about it.

**Delete** only applies to archived workspaces and needs a confirmation, because it hard-deletes
every session record. The daemon has no request that removes a workspace record, so the plugin also
records the id in `~/.paseo/agent-manager/deleted-workspaces.json` and hides that record whatever the
daemon does with its registry afterwards. Remove the id from that file to make the workspace visible
again; a daemon restart clears the in-memory copy of a deleted record.

**Command Center action** named `Release other sessions`, available once a session is focused: it
releases every session in the focused workspace that holds a process, except the focused one.

The process and memory numbers come from the host process table, and only count processes the daemon
spawned for that session, so a shell command that inherited a session's environment is never mistaken
for a runtime.

## Where it runs

Paseo plugins are hosted by the daemon and rendered by the app:

- The server half runs as a subprocess of the daemon, on the daemon host. It reads the local process
  table, watches the local registry, and calls the local daemon. The auto-release timer runs there,
  so it keeps working with no app connected.
- The client half is compiled by the daemon and evaluated inside the Paseo app on desktop, web, and
  mobile.

Install it once per daemon. Every client connected to that daemon sees the panel.

### Multiple hosts

The panel is host-scoped and multi-host aware:

- The plugin screen is bound to one host (the app routes it as `/h/<serverId>/plugin/...`), and every
  RPC, setting, and auto-release timer belongs to that host's plugin instance.
- When the plugin is installed on more than one host, the app shows a host switcher in the plugin
  screen header. Switching reloads the panel against the other host; job progress and auto-release
  state are tracked per host.
- The `Other hosts` section lists the other configured hosts that are online with their session,
  running, and archived counts, read through the app's existing connections. Acting on another host
  requires switching to it (the action buttons always target the host the screen is showing).

## Install

```bash
# from a local directory
paseo plugin install /absolute/path/to/paseo-agent-manager

# from git
paseo plugin install <git-url>
```

Set `"pluginsEnabled": true` in the daemon `config.json`, then:

```bash
paseo reload
paseo plugin ls
```

Open **Agent Manager** in the app sidebar.

## Requirements

- Paseo 0.9.2 or newer.
- A Linux daemon host for the pid and memory numbers, which read `/proc`.
- The `paseo` CLI on the daemon host `PATH` for Delete.
- The daemon MCP route for Release, which is enabled by default. On a daemon with a password set the
  plugin cannot authenticate to that route and falls back to `SIGTERM`; reload the session afterwards
  with `paseo agent reload <id>`.
- Workspace restore, tab reopening, and auto-release use the daemon session protocol over
  `ws://<daemon.listen>/ws`, with `PASEO_PASSWORD` or `daemon.password` when the daemon requires one.
  The plugin loads the daemon's own `@getpaseo/client` build, so no extra dependency is installed.

Optional environment overrides on the daemon host:

- `PASEO_AGENT_MANAGER_CLI` — path to the `paseo` binary.
- `PASEO_AGENT_MANAGER_MCP_URL` — full URL of the daemon MCP endpoint.
- `PASEO_AGENT_MANAGER_CLIENT_IDLE_MS` — how long the workspace job connection stays open after the
  last job. Defaults to `180000` (3 minutes) and reconnects on the next job; `0` keeps it open.

Plugins are trusted, unsandboxed code: the server half runs with the daemon user's privileges on the
daemon host, and the client half runs inside the Paseo app.

## License

MIT
