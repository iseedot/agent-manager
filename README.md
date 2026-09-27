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
- **Auto-release** keeps memory in check on its own: every 10 minutes it releases every session that
  has been idle for more than 10 minutes. It is on by default and can be switched off in the panel.

## Where the controls appear

The whole plugin is one screen: **Agent Manager** in the app sidebar. There is no per-tab button; the
panel's unit is the workspace.

```
14 workspaces · 1 active · 13 archived
21 sessions · 1 holding a process · 150 MB
[Release idle everywhere (1)]  [Refresh]
[Auto-release idle tabs: On]   [Check now]
Auto-release checks every 10 min and releases idle tabs over 10 min · last 2m ago · released 1

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

### Auto-release

- **Switch** in the panel, on by default, stored in `~/.paseo/agent-manager/auto-release.json` per
  host. `Check now` runs a pass immediately instead of waiting for the timer.
- A pass releases every session that holds a process, is not `running`, is not waiting for your
  attention (`requiresAttention`), and whose last activity is older than the idle threshold
  (`lastActivityAt` from the agent record, falling back to the daemon's `updatedAt`).
- The panel reports the last run: how many sessions it released, how many it skipped, and the next
  scheduled run. Intervals can be changed in that JSON file (`idleMinutes`, `intervalMinutes`).
- Releasing never deletes anything: the session stays `closed`, its history is intact, and the next
  message starts a new process.

### What a workspace action can and cannot touch

Every workspace action is addressed by workspace id, never by directory path, and the plugin verifies
afterwards that no other workspace in the project changed state. Two cases are worth knowing:

- **Archive** stops only the sessions and terminals that this workspace owns. It refuses to archive
  the last active workspace at a path unless you confirm, because Paseo resolves *directory*
  workspaces by path: with no active workspace at `/path`, the next time that project opens, Paseo
  reopens the oldest archived workspace at `/path`. That looks like a different workspace taking
  over. The confirmation names the workspace that would be reopened.
- **Activate** restores only the workspace you picked. If another workspace for the same path is
  already active — for example one Paseo reopened by itself — the job reports it instead of touching
  it, so you can decide what to do with each one.

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
