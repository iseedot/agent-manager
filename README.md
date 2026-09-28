# paseo-agent-manager

Manages a Paseo host's workspaces as a unit: how much memory each one holds, plus release / archive /
activate / delete for the whole workspace. Idle runtimes are released automatically.

## Features

- One list of every workspace, active first and archived below: sessions, sessions holding a process,
  memory, terminals, path, project, and a host line with load / CPU / memory / swap.
- `Release idle (N)` / `Release (N)`: stop the runtime of idle sessions for the whole host or one
  workspace. They stay `closed` with their history; the next message starts a new process.
- `Reopen (N)`: reopen a workspace's archived tabs, released again. `Tabs (N)` / `Terminals (N)`:
  close its open tabs or terminals (terminals ask first when a command is running).
- `Archive`: hide a workspace with everything it owns. `Activate`: restore the tabs it had when it was
  archived. `Delete`: remove it and its sessions for good.
- ⌘K `Release other sessions`: release everything in the focused workspace except the current session.
- Always on: idle sessions are released ~10 minutes after their last activity (driven by the daemon's
  agent stream, not by polling; one pass on load, a safety sweep every 30 minutes), and workspaces
  without a single session record are removed. Intervals live in
  `~/.paseo/agent-manager/auto-release.json`.

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager   # update later: paseo plugin update agent-manager --yes
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. The panel is **Agent
Manager** in the app sidebar; install once per daemon. It reads when opened and keeps that for 30
seconds, so `Refresh` or an action is what pulls new data.

Needs Paseo 0.9.2+, a Linux daemon host (`/proc` feeds the pid and memory numbers), the `paseo` CLI
for Delete and the daemon MCP route for Release. Nothing is installed: it uses the daemon's own
`@getpaseo/client` and the session protocol on `ws://<daemon.listen>/ws`.

## Notes

- Actions are addressed by workspace id, never by path, and never touch other workspaces. Archiving
  the last active workspace at a path asks first, because Paseo resolves directory workspaces by path.
- `Activate` restores the tab set from archive time; sessions you closed earlier stay closed.
- `Delete` also drops the workspace record, remembered in `~/.paseo/agent-manager/deleted-workspaces.json`.

MIT
