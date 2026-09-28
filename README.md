# paseo-agent-manager

Manages a Paseo host's workspaces from one panel: memory per workspace, plus release / archive /
activate / delete for the whole workspace. Idle runtimes are released automatically.

```
2 workspaces · 2 active · 0 archived · dev · 6 sessions · 2 holding · 240 MB
load 0.42 · cpu 12% · mem 668M/961M · swap 238M/3.0G

[Release idle (3)]  [Refresh]

ACTIVE · 1
paseo plugin work · /home/you/project
2 holding · 240 MB · 6 sessions · 1 running · 2 terminals 150 MB (1 busy) · my-project
[Release (2)] [Reopen (2)] [Tabs (4)] [Terminals (2)] [Archive]

ARCHIVED · 13
old scratch work · /home/you/project · 1 sessions · archived 15d ago
[Activate] [Delete]
```

Reads on open, then keeps its data for 30 seconds; `Refresh` or an action pulls new data. On a phone
the buttons become a two-column grid.

| Button | Effect |
| --- | --- |
| `Release idle (N)` / `Release (N)` | Stop the runtime of idle sessions (whole host / one workspace). They stay `closed` with their history; the next message starts a new process. |
| `Reopen (N)` | Reopen a workspace's archived tabs and release them again. |
| `Tabs (N)` / `Terminals (N)` | Close its open tabs / terminals (terminals ask first when a command runs). |
| `Archive` / `Activate` / `Delete` | Hide the workspace with everything it owns / restore it, released, to the tabs it had when archived / remove it and its sessions for good. |
| ⌘K `Release other sessions` | Release every session in the focused workspace except the current one. |

Always on, no switches: idle sessions are released ~10 minutes after their last activity (driven by
the daemon's agent stream, so nothing polls; one pass on load and a safety sweep every 30 minutes),
and workspaces without a single session record are removed. Intervals live in
`~/.paseo/agent-manager/auto-release.json`.

Every action is addressed by workspace id and never touches other workspaces. Archiving the last
active workspace at a path asks first, because Paseo resolves directory workspaces by path. `Delete`
also drops the workspace record (remembered in `deleted-workspaces.json`, since the daemon has no
request for that).

```bash
paseo plugin install https://github.com/iseedot/agent-manager   # then: paseo reload
```

Paseo 0.9.2+, a Linux daemon host (`/proc` feeds the pid and memory numbers), the `paseo` CLI for
Delete and the daemon MCP route for Release. Nothing else is installed: the plugin uses the daemon's
own `@getpaseo/client` and the session protocol on `ws://<daemon.listen>/ws`.

MIT
