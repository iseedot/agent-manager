# paseo-agent-manager

A Paseo plugin with four jobs:

1. **Composer pill** — one pill above the composer that shows the open tabs of the current workspace
   and lets you switch, close or open one.
2. **Per-project worktrees** — a worktree workspace is checked out at `<project>/.worktrees/<slug>`
   instead of Paseo's global worktrees root, so every project keeps its checkouts to itself.
3. **Project git bootstrap** — before Paseo provisions a workspace, an empty project directory gets
   `git init` plus one empty commit, so worktree workspaces work right away. Existing repositories and
   non-empty directories are never touched.
4. **Auto-release** — agent runtimes are released once their turn is over, whether or not the app is
   open: one 15-minute tick releases everything that is not working or waiting on you, cleans up once a
   day, and applies Paseo's merged-worktree archiving to the plugin's own worktrees (see
   [Auto-release](#auto-release)).

The manager panel is gone; the plugin no longer ships a sidebar entry, a surface or any workspace /
session management actions.

## The composer pill

One pill sits above the composer and follows the session it belongs to. Its label carries the open tab
count (`3 tabs`), the one number the menu is about, plus `⚠` when Paseo recorded a project notice.
Opening the pill shows:

- one host line from the same facts payload — `load 1.08 · cpu 0% · mem 81%/17% · disk 11% free ·
  0 terminals` (memory, swap and root-filesystem percentages) — then `Sweep 03:01 · 03:16` for the
  auto-release state (`sweeping now` while a tick runs, `error: …` when one failed), then `Tab Created 12h ago · Last 7m ago · Updated 4m ago`. Any device can read the
  plugin's state this way, without a CLI and without a reload,
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

**One timer.** A tick every fifteen minutes does all of it, and it keeps working while the app is
closed:

1. **Release.** The daemon's session list is read once and every runtime that is neither working nor
   waiting on the user is released. There is no idle window any more — the tick is the resolution, so a
   runtime lives at most one tick past its last turn. Three protections remain: a runtime that is
   `running`, one that is still `initializing` (a slow provider boot must not be killed half-way) and
   one waiting on a permission (`attentionReason: permission` or a pending permission request) are never
   released, and a runtime the daemon touched inside the **grace window** (five minutes) is left for the
   next tick, so a turn that ends just before a tick is not released while its answer is still being
   read.
2. **Cleanup, once a day.** Archived workspaces with no session records left are deleted. There is a
   second, switchable mode around it — see [Purging archived workspaces](#purging-archived-workspaces).
   It is the only destructive step and nothing depends on it being prompt, so it rides on the tick but
   at most every twenty-four hours. The timestamp lives in the state file, so a reload cannot postpone
   it forever, and the session list the release pass already read is reused instead of listing twice.
   When that listing failed the phase is skipped entirely — "no session records" would otherwise be
   true for every workspace.
3. **Merged worktrees.** Paseo archives a worktree when its change request merges, but only for the
   worktrees it created itself. Project-local ones (`<project>/.worktrees/<slug>`) are the plugin's, so
   the same rule runs here: merged pull request, nothing uncommitted, nothing unpushed → the workspace
   is archived and the clean worktree removed.

Nothing else wakes up: no per-session timer, no due timer, and no second timer for the phases a tick
triggers. A phase that is still running when the next tick arrives is skipped by its own flag, so slow
work can never run twice and can never hold the release pass back. The plugin's own daemon connection is
opened lazily and kept for the lifetime of the plugin (closed on unload), and only the last tick is
remembered in `~/.paseo/agent-manager/auto-release.json`.

Releasing goes through the daemon's own close action (MCP `kill_agent`), so the record stays valid and
the next message resumes the session.

## Purging archived workspaces

By default "archived" is reversible: the records stay and the daily cleanup only removes workspaces
that have no sessions left. **Purge archived workspaces** (off by default) makes archiving final — every
archived workspace is deleted at the next cleanup, sessions included, whether or not agents remain.

```
every archived workspace
  └─ pi agent?  → delete its transcript (persistence.nativeHandle)
  └─ `paseo agent delete` for each session record
  └─ drop the workspace record
```

**Delete pi session files** (off by default, only read while purging) removes the provider's own
transcript as well. Only **pi** is supported: it is the one provider that writes the absolute path of
its transcript into the agent record (`persistence.nativeHandle`), so the file can be deleted exactly.
Every other provider either keeps its transcript where this plugin cannot know (opencode, the ACP
agents: copilot, cursor, kimi, kiro, trae, hermes) or names it with an id instead of a path (claude,
codex) — guessed paths would risk deleting a file that was never ours, so those are left alone.

Switching either of those on makes the cleanup due on the next tick instead of waiting out the
interval, so a purge does not sit for a day after it was asked for.

This is irreversible: after the purge the workspace and its sessions cannot be restored. Nothing in the
plugin ever deletes project content or a worktree checkout, only records and the pi transcript.

## Settings

The plugin registers one host-scoped settings document (`auto-release`), so the app's plugin settings
screen can change all of it; every value has a default and nothing has to be configured to work.

| Setting | Default | Meaning |
| --- | --- | --- |
| Tick every (minutes) | `15` | the single timer's cadence |
| Grace (minutes) | `5` | a runtime touched this recently waits for the next tick (`0` releases on the tick) |
| Cleanup every (hours) | `24` | how often the destructive phase may run |
| Purge archived workspaces | off | delete every archived workspace, sessions included |
| Delete pi session files | off | also delete the pi transcript while purging |

Values live in `~/.paseo/plugin-settings/agent-manager/auto-release.json` (`{ version, values }`, with the
zod schema as the contract). An operator can override any of them from the daemon environment, and the
environment wins — handy for a one-off purge or a quick timing experiment without touching the app. A
value that is not a positive number is ignored:

| Environment variable | Overrides |
| --- | --- |
| `PASEO_AGENT_MANAGER_SWEEP_INTERVAL_MS` | tick cadence in ms, minimum `5000` |
| `PASEO_AGENT_MANAGER_GRACE_MINUTES` | grace in minutes |
| `PASEO_AGENT_MANAGER_CLEANUP_INTERVAL_MS` | cleanup interval in ms, minimum `60000` |
| `PASEO_AGENT_MANAGER_PURGE_ARCHIVED` | `1`/`0` — purge mode |
| `PASEO_AGENT_MANAGER_DELETE_PROVIDER_SESSIONS` | `1`/`0` — delete the pi transcript too |

### Other profiles

The plugin runs from source, so switching profiles is a checkout plus a reload — no rebuild:

```bash
git checkout conservative-idle-10min && paseo reload   # upstream: 10-minute idle window, 15-minute sweep
git checkout aggressive-idle-1min && paseo reload      # experiment: 1-minute window, 1-minute sweep
git checkout single-timer-sweep && paseo reload        # this one: a single 15-minute tick
```

Tags `baseline-idle-10min` and `idle-1min-profile` mark the same two versions.

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
