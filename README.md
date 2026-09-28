# paseo-agent-manager

A Paseo plugin that manages a host's workspaces from one panel: what each workspace holds in
memory, and release / archive / activate / delete for the whole workspace. Idle runtimes are
released automatically.

## The panel

```
2 workspaces · 2 active · 0 archived
dev · 6 sessions · 2 holding · 240 MB
load 0.42 · cpu 12% · mem 668M/961M · swap 238M/3.0G

[Release idle (3)]  [Refresh]

ACTIVE · 1
paseo plugin work
/home/you/project
2 holding · 240 MB · 6 sessions · 1 running · 2 terminals 150 MB (1 busy) · my-project
[Release (2)] [Reopen (2)] [Tabs (4)] [Terminals (2)] [Archive]

ARCHIVED · 13
old scratch work
/home/you/project
1 sessions · my-project · archived 15d ago
[Activate] [Delete]
```

It reads on open and then keeps what it has for 30 seconds; only `Refresh` or an action pulls new
data. Archived workspaces are listed right below the active ones, because the app hides them
everywhere else. On a phone the buttons become a two-column grid.

## What the buttons do

| Button | Effect |
| --- | --- |
| `Release idle (N)` | Releases every idle session on the host (the ones holding memory but not running). |
| `Release (N)` | Same, for one workspace. |
| `Reopen (N)` | Reopens that workspace's archived sessions, then releases them again, so the tabs come back without holding memory. |
| `Tabs (N)` | Closes every open tab of a workspace (the app's own close-tab path). Processes stop, the workspace stays active. |
| `Terminals (N)` | Closes the workspace's terminals. Asks first only when one is running a command. |
| `Archive` | Stops everything the workspace owns and hides it from the app. |
| `Activate` | Restores an archived workspace to the tab set it had when it was archived, released. Sessions you had closed earlier stay closed (`Reopen` brings those back too). |
| `Delete` | Removes an archived workspace and its sessions for good. |
| ⌘K `Release other sessions` | Releases every session in the focused workspace except the one you are in. |

**Releasing never deletes anything**: a session becomes `closed`, its history stays, and the next
message starts a fresh process.

## Automatic

- **Idle release**: a session is released ~10 minutes after its last activity, driven by the daemon's
  agent stream (no polling), plus one pass when the plugin loads and a safety sweep every 30 minutes.
  Sessions that are running or waiting for you are never touched.
- **Empty workspaces**: a workspace with no session records at all is removed — archived ones on each
  sweep, and archiving an empty workspace removes the record right away.
- Both are always on. Intervals and switches (`enabled`, `idleMinutes`, `intervalMinutes`, `onLoad`,
  `removeEmptyWorkspaces`) live in `~/.paseo/agent-manager/auto-release.json` per host.

## Things worth knowing

- Every workspace action is addressed by workspace id, never by path, and the plugin checks afterwards
  that no other workspace changed state.
- Archiving the **last active workspace at a path** asks for confirmation: Paseo resolves directory
  workspaces by path, so the next project open would reopen some other archived record there.
- `Delete` also drops the workspace record. The daemon has no request for that, so the plugin removes
  it from the registry and remembers the id in `~/.paseo/agent-manager/deleted-workspaces.json`;
  a daemon restart clears the leftover in-memory copy.
- Process numbers come from `/proc` and only count processes the daemon spawned for that session, so a
  shell command that inherited a session's environment is never mistaken for a runtime.

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. Open **Agent Manager** in
the app sidebar. Install once per daemon; when the plugin runs on several hosts, the app shows a host
switcher in the plugin screen header.

Requirements: Paseo 0.9.2+, a Linux daemon host (the pid and memory numbers read `/proc`), the
`paseo` CLI on the host `PATH` for Delete, and the daemon MCP route for Release. No dependencies are
installed: the plugin uses the daemon's own `@getpaseo/client` build and the session protocol on
`ws://<daemon.listen>/ws`.

Optional environment: `PASEO_AGENT_MANAGER_CLI` (path to `paseo`), `PASEO_AGENT_MANAGER_MCP_URL`,
`PASEO_AGENT_MANAGER_CLIENT_IDLE_MS` (how long the job connection stays open, default 180000).

## License

MIT
