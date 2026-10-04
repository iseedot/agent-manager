# paseo-agent-manager

A Paseo plugin with four jobs:

1. **Composer pill** — one pill above the composer that shows the open tabs of the current workspace
   and lets you switch, close or open one.
2. **Per-project worktrees** — a worktree workspace is checked out at `<project>/.worktrees/<slug>`
   instead of Paseo's global worktrees root, so every project keeps its checkouts to itself.
3. **Project git bootstrap** — before Paseo provisions a workspace, an empty project directory gets
   `git init` plus one empty commit, so worktree workspaces work right away. Existing repositories and
   non-empty directories are never touched.
4. **Auto-release** — idle agent runtimes are released automatically, whether or not the app is open.

The manager panel is gone; the plugin no longer ships a sidebar entry, a surface or any workspace /
session management actions.

## The composer pill

One pill sits above the composer and follows the session it belongs to. Its label carries the open tab
count (`3 tabs`), the one number the menu is about, plus `⚠` when Paseo recorded a project notice.
Opening the pill shows:

- the host line (`load`, `cpu`, `mem`, `swap`) and this workspace's terminal count,
- **NOTICES**, when there are any: one short line each (`<name> · what happened`, e.g.
  `hardcore-dingo · worktree ready`, `dirty-monkey · uncommitted changes — remove?`), newest and most
  actionable first, two at most, each with a `×` that dismisses it and buttons when a decision is
  needed (`Remove worktree` / `Keep it`). The long explanation goes to the plugin log
  (`paseo plugin logs agent-manager`), never to the popover. Informational notes stay in the popover;
  only warnings, errors and notes with buttons mark the pill with `⚠`,
- every open tab of this workspace, newest first, each with its state — `running`, `unread` (the turn
  finished and has not been looked at), `needs input` (waiting on a permission), `failed`, `idle` (a
  runtime is held but nothing is working) or `no runtime` — and a `×` that archives that tab without
  switching to it first, the current tab included. The current tab is highlighted and inert; picking
  another focuses it through the same navigation the app uses, so it switches workspace and tab,
- `New Agent`,
- the current tab's timestamps (`Created … · Updated … · Last message …`) and the `ui <code>` build
  stamp.

**New agent** fires Paseo's own new-agent action on desktop and web — the one behind the tab bar `+`
menu and `Ctrl+Shift+A` / `Cmd+Shift+A` — so the usual draft tab opens. Native hosts have no keyboard
layer, so it opens the same draft through Paseo's own `paseo:` deep link (`?open=draft:…`); the tab
appears instantly and the session is created when the first message is sent. If the host cannot open
that link either, it creates the session through the daemon and jumps to it.

Switching tabs goes through a tiny redirect surface, because a composer pill has no navigation of its
own. That surface subscribes to focus requests instead of reading one at mount, so a request that
arrives while it is already mounted — a second pick before the first navigation lands — still switches.

The pill follows the daemon's agent stream: one agent observation is opened when the plugin loads, so a
session that appears, is restored or is removed gains or loses its pill without a refetch. Its counts
and states come from that stream; the popover adds one small host-metrics call when it opens. Notices
are polled once a minute. Paseo rejects a `label` that is empty or whitespace
(`Plugin button needs label`), so the label always carries numbers and never looks like a stray icon.

## Per-project worktrees

Paseo builds its managed worktrees under `$PASEO_HOME/worktrees/<project-hash>/<slug>` and no
configuration can move that per project. This plugin takes the request over in the `workspace.create`
before hook instead:

1. it creates the worktree with plain git at **`<project>/.worktrees/<slug>`** (branch off
   `baseBranch`/HEAD, or check out `refName` when the request checks out an existing branch),
2. it makes sure the project ignores that directory — `git check-ignore` decides, and when the path is
   not ignored yet it appends `/<relative path>/.worktrees/` to the repository's `.gitignore`,
3. it hands Paseo a directory request for the new path, filed under the project that owns the
   repository (the request's `projectId`, else the project registered for the repo root, else it
   registers one).

Paseo still recognises the checkout as a worktree (branch, main repo root), but it is not
Paseo-owned, so archiving the workspace never deletes it blindly. Instead:

| The worktree is… | On workspace archive |
| --- | --- |
| clean (no uncommitted changes) | removed automatically, exactly like Paseo's own worktrees, and a one-line note says so |
| holding uncommitted changes | kept, and the pill asks: `Remove worktree` (refused while dirty) → `Force remove` (deletes them) or `Keep it` |

The branch keeps the commits either way; only uncommitted work can be lost, which is why that is the
only case that asks. `Keep it` leaves the checkout in place so restoring the workspace reopens it
as-is.

Two Paseo behaviours come with the takeover:

- **`paseo.json` scripts** — `worktree.setup` runs in the background right after the checkout is
  created (the create hook has a 30 s budget, so it never blocks), and `worktree.teardown` runs before
  the worktree is deleted. Commands get Paseo's own environment
  (`PASEO_ROOT_PATH`, `PASEO_WORKTREE_PATH`, `PASEO_BRANCH_NAME`, `PASEO_SOURCE_CHECKOUT_PATH`);
  a failure becomes a one-line note, never a blocked workspace.
- **Archiving merged work** — Paseo does this only for its own worktrees, so the plugin repeats the
  check every 15 minutes for project-local ones: change request merged, nothing uncommitted, nothing
  unpushed → the workspace is archived (its tabs close) and the clean worktree is removed.

The plugin steps aside — Paseo's own behavior applies — when the request is not a `worktree`
isolation, when it checks out a change request (`checkoutSource`/`githubPrNumber`), when git is
unavailable, when the directory has no repository or no commit yet (the notice says so), or when the
target path or the branch already exists. In those cases a warning notice explains the fallback.

## Project git bootstrap

Registered as the plugin's `workspace.create` before hook, so it runs before Paseo provisions anything
and always passes the request through unchanged.

| The project directory is… | What happens |
| --- | --- |
| not a directory | nothing |
| already a repository (cloned, added, or created by hand) | nothing |
| inside another repository (a subdirectory of a checkout) | nothing — no nested repository |
| a repository without any commit | a notice: worktrees need a commit (`git commit --allow-empty -m init`) |
| non-empty without a repository | nothing — an existing folder is never turned into a repository |
| empty without a repository | `git init` (branch `main`) plus one empty commit as `Paseo <paseo@localhost>` |
| any of the above, on a host without git | a notice, once the directory is empty or already a repository |

Notices are recorded on the daemon, shown in the pill popover and printed to the plugin log. Nothing is
ever retried, and the plugin never edits or removes project content. Adding a project without creating a
workspace triggers nothing at all: the hook only runs when a workspace is actually created.

## Auto-release

A session is released once it has been idle for 10 minutes unless it is waiting on a permission. A
15-minute safety sweep scans the host and releases everything past its window; when the earliest window
closes sooner, a single timer wakes the sweep at that moment. It keeps working while the app is closed.

Archived workspaces with no session records are removed by the sweep. There are no auto-release knobs:
the plugin keeps only the last sweep result in `~/.paseo/agent-manager/auto-release.json`.

Releasing goes through the daemon's own close action (MCP `kill_agent`), so the record stays valid and
the next message resumes it.

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager
paseo plugin update agent-manager --yes     # later
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. Install once per daemon;
every client connected to that host (including the official iOS app) gets the pill.

Needs Paseo 0.10.0+ and a Linux daemon host (`/proc` feeds the host stats). Nothing extra is
installed: the plugin uses the daemon's own client, the session protocol on `ws://<daemon.listen>/ws`
and `node:child_process` for git.

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
compiles; `shared/contracts.ts` is the RPC surface between them; `server/project-git.ts` holds the git
bootstrap.

MIT
