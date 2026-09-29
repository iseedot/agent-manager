# paseo-agent-manager

Manages a Paseo host's workspaces as a unit: how much memory each one holds, plus release / archive /
activate / delete for the whole workspace. Idle runtimes are released automatically.

## Features

- One list of every workspace, active first and archived below, with what each one holds: sessions, how
  many of them keep a process alive, that memory, terminals, path and project — plus a host line with
  load / CPU / memory / swap.
- `Release idle (N)` / `Release (N)`: stop the runtime of idle sessions for the whole host or one
  workspace. They stay `closed` with their history; the next message starts a new process.
- `Reopen (N)`: reopen a workspace's archived tabs. They load once so the app can show their content and
  the idle timer closes them again. `Tabs (N)` / `Terminals (N)`: close its open tabs or terminals
  (terminals ask first when a command is running).
- `Archive`: hide a workspace with everything it owns; a workspace without a single session record is
  removed on the spot instead. `Activate`: restore the tabs it had when it was archived. `Delete`: remove
  it and its sessions for good. `Rename…`: set the name Paseo shows, archived or not.
- `New agent` above the composer. Desktop and web: it fires Paseo's own new-agent action — the one
  behind the tab bar `+` menu and `Ctrl+Shift+A` / `Cmd+Shift+A` — so the usual draft tab opens. Native
  hosts have no keyboard layer, so it opens the same draft through Paseo's own `paseo:` deep link
  (`?open=draft:…`): the tab appears instantly and the session is created when the first message is sent.
  If the host cannot open that link, it creates the session through the daemon and jumps to it.
- Auto-release, tunable in the panel: a session is closed once it has been idle for the chosen timer
  (default 10 minutes; a freshly loaded session always gets its full window) unless it is waiting on a
  permission. Driven by the daemon's agent stream with a safety sweep; settings also live in
  `~/.paseo/agent-manager/auto-release.json`.
- ⌘K `Release other sessions`: release everything in the focused workspace except the current session.

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
  the last active workspace at a path asks first when it still has session records, because Paseo
  resolves directory workspaces by path.
- `Activate` restores the tab set from archive time; sessions you closed earlier stay closed.
- Workspaces whose project was removed are still listed, as `project removed`.
- `Delete` also drops the workspace record, remembered in `~/.paseo/agent-manager/deleted-workspaces.json`.

MIT
