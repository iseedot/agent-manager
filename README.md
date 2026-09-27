# paseo-agent-manager

A Paseo plugin that lists every agent session on a Paseo daemon together with the operating-system
process it holds, and lets you release, archive, or delete sessions from one panel.

## What it does

- Lists all sessions on the host, archived ones included, with status, provider, workspace, last
  activity, pid, and memory.
- **Release** closes an agent's provider runtime without archiving it. The session stays in its
  workspace as `closed` and reopens on the next prompt.
- **Release all idle** releases every session that holds a process and is not currently running.
- **Archive** soft-deletes a session. It stays recoverable from History.
- **Delete** removes a session permanently.
- Multi-select: pick any number of rows and run release, archive, delete, or open on the selection.

The process and memory columns come from the host process table, so a session that the daemon
reports as `idle` but that still holds a provider process is shown with its pid and resident memory.

## Where it runs

Paseo plugins are hosted by the daemon and rendered by the app:

- The server half runs as a subprocess of the daemon, on the daemon host. It reads the local process
  table and calls the local daemon.
- The client half is compiled by the daemon and evaluated inside the Paseo app on desktop, web, and
  mobile.

Install it once per daemon. Every client connected to that daemon sees the panel. When several hosts
run the plugin, the app shows a single sidebar entry with a host picker in the screen header, and the
selected host supplies the data and the actions.

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
- A Linux daemon host for the pid and memory columns, which read `/proc`.
- The `paseo` CLI on the daemon host `PATH` for Delete.
- The daemon MCP route for Release, which is enabled by default. On a daemon with a password set the
  plugin cannot authenticate to that route and falls back to `SIGTERM`; reload the session afterwards
  with `paseo agent reload <id>`.

Optional environment overrides on the daemon host:

- `PASEO_AGENT_MANAGER_CLI` — path to the `paseo` binary.
- `PASEO_AGENT_MANAGER_MCP_URL` — full URL of the daemon MCP endpoint.

Plugins are trusted, unsandboxed code: the server half runs with the daemon user's privileges on the
daemon host, and the client half runs inside the Paseo app.

## License

MIT
