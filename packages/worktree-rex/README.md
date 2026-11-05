# worktree-rex

For Pi users working in Rex, `worktree-rex` creates isolated Git worktrees and
opens interactive Pi agents in Rex tabs without an initial prompt. It uses the
same commands, pickers, session browser, aliases, rebase helpers, and PR workflow
as the [tmux worktree package](../worktree/README.md). It doesn't manage tmux.

## Before you begin

You need the following:

- Git, Pi, and the `rex` CLI on your machine.
- A running local Rex server. `rex whoami --json` must report a `unix://` endpoint.
- A Rex version that supports `window new`, `session inspect`, and the terminal
  block's `process` method. Check your installation with `rex COMMAND --help`,
  replacing `COMMAND` with the command you want to inspect.
- `pi` available in the login-shell environment Rex uses for its terminals.
- The full `pi-agent-extensions` checkout. This package imports shared workflow
  code from its sibling `packages/worktree`; keep both directories in place.

## Install

`worktree-rex` replaces the tmux package. **Don't enable both:** they register the
same `/worktree` commands, aliases, and `worktree_*` tools.

1. If you have the tmux package installed from this checkout, remove its Pi
   registration. This doesn't delete its files, worktrees, or registry:

   ```bash
   pi remove ~/dev/pi-agent-extensions/packages/worktree
   ```

2. Install the Rex package from your checkout:

   ```bash
   pi install ~/dev/pi-agent-extensions/packages/worktree-rex
   ```

3. Start Pi in a Git repository inside Rex, or run `/reload` in an existing Pi
   session. Verify that `/worktree help` describes Rex rather than tmux.

Adjust the checkout path if you cloned the repository elsewhere. The package is
installed from source, not as a standalone npm package. Installing it doesn't
remove the original package automatically.

## Create and switch to a worktree

In Pi, create a worktree based on `main`:

```text
/worktree create feature/login main
```

The command creates a sibling checkout named `REPO-feature-login`, where `REPO`
is your repository's directory name. It opens a background Rex tab labeled
`wt:feature-login`, running `pi --name wt:feature/login`. The notification includes
the full session and window IDs. Your current tab retains focus.

To select that tab, run the following command in Pi:

```text
/worktree switch feature/login
```

Confirm that Rex selects the worktree's tab. If a recorded tab has closed, the
command starts a replacement and updates its recorded IDs. Switching to an
external checkout doesn't add it to the set that `/worktree clean` deletes.

If Pi runs outside a Rex terminal, creation opens a dedicated Rex session instead
of choosing one of your unrelated sessions. Rex doesn't display that session
automatically. Select it in the app, or run the following command:

```bash
rex do session.select session_id=SESSION_ID window_id=WINDOW_ID
```

Replace `SESSION_ID` and `WINDOW_ID` with the full IDs from the creation result.
If more than one app is connected, choose one from `rex client ls` and set
`REX_CLIENT` before starting Pi. Cross-session switching uses that client; the
plugin reports ambiguity rather than selecting an arbitrary app.

## Commands and tools

The package preserves these commands:

| Command | Action |
|---|---|
| `/worktree` | Open the searchable command menu |
| `/worktree BRANCH` | Create a worktree and an interactive Pi tab |
| `/worktree create BRANCH [BASE]` | Create from an explicit base |
| `/worktree list` | Browse worktrees with Rex activity badges and action keys |
| `/worktree sessions` | Browse and resume sessions, including removed checkouts |
| `/worktree switch [BRANCH]` | Find or start a Rex tab and select it |
| `/worktree rename [OLD] [NEW]` | Rename a branch and its Rex tab |
| `/worktree remove [BRANCH]` | Close its Rex tabs, remove the checkout, and delete its branch |
| `/worktree clean` | Remove every Rex-managed checkout and its branch |
| `/worktree rebase [BRANCH]` | Rebase local main/master onto a topic |
| `/worktree tip [BRANCH]` | Rebase a topic onto local main/master |
| `/worktree pr [BRANCH]` | Run the remote-base rebase, PR, and green-CI workflow |
| `/worktree help` | Show command help |

Replace the uppercase names with your branch names. Square brackets mark
optional arguments. The agent tools are `worktree_create`, `worktree_list`,
`worktree_remove`, `worktree_clean`, `worktree_rename`, and `worktree_pr_pause`.

The `/wt` alias, subcommand aliases, `worktree.json` configuration, and
`worktree.list.*` keybindings are shared with the original package. For picker
controls, session behavior, rebase semantics, and PR requirements, see the
[worktree workflow documentation](../worktree/README.md); use the Rex behavior
on this page in place of its tmux-specific instructions.

## Registry and cleanup safety

Rex metadata lives in `.pi/worktrees-rex.json` in the primary checkout, including
when you invoke a command from a linked worktree. The tmux package's
`.pi/worktrees.json` is neither imported nor modified. Removed paths remain in
the Rex registry's session history.

Tabs are identified by their full session/window IDs or by a local terminal
process's working directory inside the checkout. Names alone and sibling path
prefixes don't establish ownership. Cleanup closes matching tabs, not their
shared Rex session. A tab containing the current agent is protected; remove that
worktree from another tab. Closing a tab also closes its split panes.

**Warning:** As in the original package, remove and clean force removal of
checkouts and deletion of branches. Uncommitted work can be lost. Commands ask
for confirmation, but model tools don't provide a separate confirmation dialog.

If Rex startup fails after Git creates a checkout, the tool reports failure and
keeps the checkout registered. Inspect Rex before retrying a timed-out creation
to avoid duplicate tabs, then use `/worktree switch BRANCH` to recover. Discovery,
access, and tab-close failures stop removal rather than discarding metadata and
deleting the checkout. A stale inherited `REX_SESSION` or a remote Rex endpoint
also produces an error instead of redirecting work.

## Run checks

From the repository root, run the shared regression suite and the Rex tests:

```bash
node --test packages/worktree/*.test.ts packages/worktree-rex/*.test.ts
```

The live test is skipped by default. With a running local Rex server, opt in to
the integration smoke test:

```bash
REX_LIVE_TEST=1 node --test packages/worktree-rex/live.test.ts
```

The smoke test creates a disposable session, launches a real interactive Pi
agent without a prompt, verifies discovery, rename, switching, and removal, then
cleans up its session and temporary repository. It doesn't select your app's
session or close your existing tabs. Both commands print a Node test summary;
check that the failure count is zero.
