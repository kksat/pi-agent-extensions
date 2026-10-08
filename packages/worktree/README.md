# pi-extension-worktree

A [pi](https://pi.dev) extension for managing git worktrees with seamless tmux integration.

Spin out new features, bugfixes, and experiments into isolated git worktrees running `pi` coding agents in tmux — without prompts — and manage or clean them up easily.

## Features

- **Promptless agent launch**: spawns `pi --name "wt:<branch>"` in tmux so the child agent is immediately ready for your interaction.
- **Tmux native**: inside tmux, opens a new window in the active session; otherwise creates a detached session.
- **Tracking & registry**: tracks worktrees created by the extension in the main checkout's `.pi/worktrees.json` (shared by every linked worktree). Each created worktree is also kept in `known`, which is not removed when the checkout is deleted.
- **Sessions across worktrees**: `/worktree sessions` opens a picker like `/resume`, starting with every recorded worktree, including checkouts that no longer exist. Tab switches to the current folder. Search matches the session text, branch, and worktree name (`branch:` and `worktree:` limit a token; Ctrl+Shift+B cycles the field). Sort and the named-session filter use the same keys as `/resume`. Choosing a session forks it into the current folder or another living directory when that folder is not already the session's directory. `git worktree list` is used only when nothing has been written down yet. Outside a git repository, the same command opens the usual session list.
- **Easy cleanup**: safely kills tmux windows, removes git worktrees, and deletes topic branches with `/worktree clean`. Cleanup drops the active record and leaves the `known` path so its sessions stay reachable.
- **Flexible management**: list, switch, rename, or remove individual worktrees.
- **Rebase with Pi conflict resolution**: `/worktree rebase [branch]` rebases the current or selected topic worktree onto local `main`/`master`. If Git stops on conflicts, Pi automatically starts a turn to resolve them and continue the rebase.
- **PR delivery with verified CI**: `/worktree pr [branch]` selects a clean topic worktree, asks Pi to rebase onto remote `main`/`master`, resolve conflicts, write the body using `/skill:pr`, push the topic branch, create/reuse its PR, and repair CI failures. An independent extension gate verifies the open PR's latest pushed SHA and GitHub checks before marking the workflow green.
- **Searchable command menu**: `/worktree` with no arguments opens a focused search field above all worktree actions. Type a command name or description to fuzzy-filter and rank matches (for example, `rbs` finds rebase); use ↑/↓ to navigate, Enter to choose, and Escape to cancel. Clearing the search restores the full list. Sessions remains available inside and outside repositories. RPC clients retain the standard selection dialog.
- **LLM tools**: exposes `worktree_create`, `worktree_list`, `worktree_clean`, `worktree_remove`, and `worktree_rename` to the agent.

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/worktree
```

Or from npm, if published:

```bash
pi install npm:pi-extension-worktree
```

## Commands

| Command | Description |
|---|---|
| `/worktree <branch> [base]` | Create a worktree & run pi in tmux |
| `/worktree` | Searchable menu: type to fuzzy-search commands, ↑/↓ to navigate, Enter to select, Escape to cancel |
| `/worktree list` · `/worktrees` | List worktrees with managed & tmux status |
| `/worktree sessions` | Picker like `/resume`: current folder or all recorded worktrees, with search, sort, and branch/worktree filter. Resume in this folder or another. Outside a git repo, opens the usual session list |
| `/worktree clean` · `/worktree-clean` | Remove all managed worktrees & branches |
| `/worktree remove [branch]` · `/worktree-remove` | Remove one worktree |
| `/worktree rename <old> <new>` · `/worktree-rename` | Rename a branch |
| `/worktree switch [branch]` | Switch / attach to its tmux window |
| `/worktree rebase [branch]` | Rebase the current topic worktree onto local `main`/`master`; on `main`/`master`, select a worktree. Pi resolves conflicts |
| `/worktree pr [branch]` | Select a topic worktree (or name one), rebase onto remote `main`/`master`, create/reuse its PR with `/skill:pr`, and verify green CI |
| `/worktree help` | Show help |

## Rebasing

- In a topic worktree (including a subdirectory), `/worktree rebase` runs the rebase there.
- On `main` or `master`, `/worktree rebase` opens a topic-worktree picker. `/worktree rebase <branch>` explicitly targets an existing worktree from any checkout. Managed and unmanaged worktrees are supported; the main repository checkout is eligible if it is on a topic branch.
- This replays the **topic branch onto the base**, not `main`/`master` onto the topic. The invoking `main`/`master` is preferred; from a topic branch, `main` is preferred, with `master` as fallback. Only local base commits are used: update your base first if you want remote changes. The command does not fetch or push.
- The target must be clean, including untracked files, with no rebase/merge/cherry-pick/revert already in progress. Busy agents and detached HEAD without an explicit target are rejected. No automatic stashing or updates to other branch refs are performed.
- Conflicts trigger a prompt in the invoking Pi session, scoped to the selected worktree's absolute path. Pi inspects each conflicted commit, resolves and stages the affected files, continues with a noninteractive editor, and verifies completion. Ambiguous resolutions or non-conflict failures require user input; the rebase is left recoverable. Do not run another agent or edit the target worktree while rebasing. Cancelling the Pi turn leaves the rebase paused; resume resolution or run `git -C <worktree-path> rebase --abort` yourself.

## Pull requests

`/worktree pr` always opens a topic-worktree picker; `/worktree pr <branch>` skips it. It is also available in the fuzzy command menu. The invoking Pi session performs the workflow, scoped to the selected worktree's absolute path.

- **Prerequisites:** a clean, committed topic branch, no unfinished Git operation, authenticated GitHub CLI (`gh`), and the `pr` skill. Pi spells its command `/skill:pr` (the requested `/skills:pr` refers to that skill). Pi reads its complete `SKILL.md` before writing the Summary, Evidence, and Merge Danger sections; temporary body files live outside the repository.
- **Destination:** `origin` is used when present, otherwise the sole remote. That remote's exact GitHub repository is the PR and push destination, including on enterprise hosts. With multiple non-origin remotes, configure an unambiguous destination first. This is a **same-repository** workflow; it does not guess a fork/upstream destination or retarget an existing PR.
- **Remote base:** the GitHub repository's default `main`/`master` is preferred; otherwise remote `main`, then `master`. Pi fetches that branch and rebases onto its actual fetched commit, without switching or advancing local `main`/`master`. Every conflicted commit is resolved semantically and continued with a noninteractive editor.
- **Publishing:** only the selected topic branch is pushed. Pi captures its remote OID before rebasing and checks for divergent remote work. Rewriting a published topic uses an explicit, captured `--force-with-lease`; concurrent pushes must not be overwritten by refreshing the lease. Existing matching open PRs are reused and their bodies updated. No automatic merge is performed.
- **CI:** Pi waits for checks, inspects failing logs, repairs the underlying code, commits, pushes, and rechecks the new head. Before final settlement, the extension independently requires the matching open PR's head SHA to equal clean local HEAD, the fetched base to be an ancestor, all reported/required checks to pass or legitimately skip, at least one passing check, and a fresh successful GitHub check rollup. Empty, entirely skipped, pending, cancelled, unknown, failed, or stale-head checks are **not green**. CI must not be disabled or weakened to manufacture success.
- **Blockers and cancellation:** missing credentials/secrets, inaccessible external CI, ambiguous conflicts, lease failures, and unsafe repairs must be reported as blockers. Pi can call `worktree_pr_pause` with the reason. Automatic verification continuations are bounded to 12 attempts or 30 minutes at settlement checks, rather than looping forever. Escape, errors, reloads, or session changes stop the gate and leave Git/PR state intact; finish or abort any paused rebase before rerunning `/worktree pr`. A blocked/paused workflow is never reported as verified green.

The extension prepares the selection and performs read-only Git/GitHub probes; Pi performs fetching, rebasing, conflict resolution, body writing, pushing, PR creation, and CI remediation. Running the command authorizes those selected-branch operations, including a safe leased topic rewrite.

## Tests

```bash
node --experimental-strip-types packages/worktree/test.ts
node --experimental-strip-types packages/worktree/rebase.test.ts
node --experimental-strip-types packages/worktree/pr.test.ts
# Requires the package's Pi peer dependencies to be installed:
node --experimental-strip-types packages/worktree/command-menu.test.ts
```

## Agent tools

`worktree_create`, `worktree_list`, `worktree_clean`, `worktree_remove`, `worktree_rename`, `worktree_pr_pause` (pause an active PR workflow with a concrete blocker; never marks CI green)
