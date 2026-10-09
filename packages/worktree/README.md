# pi-extension-worktree

A [pi](https://pi.dev) extension for managing git worktrees with seamless tmux integration.

Spin out new features, bugfixes, and experiments into isolated git worktrees running `pi` coding agents in tmux — without prompts — and manage or clean them up easily.

## Features

- **Promptless agent launch**: spawns `pi --name "wt:<branch>"` in tmux so the child agent is immediately ready for your interaction.
- **Tmux native**: inside tmux, opens a new window in the active session; otherwise creates a detached session.
- **Tracking & registry**: tracks worktrees created by the extension in the main checkout's `.pi/worktrees.json` (shared by every linked worktree). Each created worktree is also kept in `known`, which is not removed when the checkout is deleted.
- **Sessions across worktrees**: `/worktree sessions` opens a picker like `/resume`, starting with every recorded worktree, including checkouts that no longer exist. Tab switches to the current folder. Search matches the session text, branch, and worktree name (`branch:` and `worktree:` limit a token; Ctrl+Shift+B cycles the field). Sort and the named-session filter use the same keys as `/resume`. Choosing a session forks it into the current folder or another living directory when that folder is not already the session's directory. `git worktree list` is used only when nothing has been written down yet. Outside a git repository, the same command opens the usual session list.
- **Easy cleanup**: `/worktree remove` and `/worktree clean` close the worktree’s tmux windows by ID, including renamed windows and windows discovered by checkout path outside tmux. Shared parent sessions and unrelated windows are preserved; dedicated worktree sessions disappear when their last window closes. Cleanup drops the active record and leaves the `known` path so its sessions stay reachable.
- **Interactive worktree list**: `/worktree list` (also `/worktrees` or the menu's List action) opens a Vim-style browser with branch/path search, managed/tmux status, and shortcuts for every worktree command. Row actions operate on the highlighted worktree, not the invoking directory. All bindings are configurable in Pi's `keybindings.json`; RPC/non-terminal modes keep the textual list.
- **Searchable worktree pickers**: every terminal worktree-selection dialog supports typing to fuzzy-search branch names and checkout paths, including switch, rename, remove, rebase, tip, PR, their menu/alias entry points, and the session-resume destination. The blank search still allows direct ↑/↓ selection; Enter selects the highlighted worktree, Escape cancels, and clearing the search restores the full list. RPC clients retain standard selection dialogs.
- **Two local rebase directions with Pi conflict resolution**: `/worktree rebase [branch]` replays local `main`/`master` onto the current/selected topic's committed tip; `/worktree tip [branch]` replays the topic onto local `main`/`master`. Pi resolves conflicts in the checkout of the branch actually being rewritten.
- **PR delivery with verified CI**: `/worktree pr [branch]` selects a clean topic worktree, asks Pi to rebase onto remote `main`/`master`, resolve conflicts, write the body using `/skill:pr`, push the topic branch, create/reuse its PR, and repair CI failures. An independent extension gate verifies the open PR's latest pushed SHA and GitHub checks before marking the workflow green.
- **Configurable command aliases**: `/wt` behaves exactly like `/worktree`, and `/wt l` opens the interactive list. Command aliases (including the existing `/worktrees` and `/worktree-*` shortcuts) and subcommand shorthands can be added, remapped, or disabled in the agent directory's `worktree.json`.
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
| `/worktree list` · `/wt l` · `/worktrees` | Interactive worktree browser with configurable Vim-style action keys; textual list outside terminal mode |
| `/worktree sessions` | Picker like `/resume`: current folder or all recorded worktrees, with search, sort, and branch/worktree filter. Resume in this folder or another. Outside a git repo, opens the usual session list |
| `/worktree clean` · `/worktree-clean` | Remove all managed worktrees & branches |
| `/worktree remove [branch]` · `/worktree-remove` | Remove one worktree |
| `/worktree rename <old> <new>` · `/worktree-rename` | Rename a branch |
| `/worktree switch [branch]` | Switch / attach to its tmux window |
| `/worktree rebase [branch]` | Rebase local `main`/`master` onto the current/selected topic worktree; Pi resolves conflicts in the main/master checkout |
| `/worktree tip [branch]` | Rebase the current/selected topic worktree onto local `main`/`master`; Pi resolves conflicts in the topic checkout |
| `/worktree pr [branch]` | Select a topic worktree (or name one), rebase onto remote `main`/`master`, create/reuse its PR with `/skill:pr`, and verify green CI |
| `/worktree help` | Show help |

## Command aliases

By default, **every** `/worktree` invocation also works with `/wt`, including `/wt` (menu), `/wt <branch> [base]`, `/wt rebase [branch]`, `/wt tip [branch]`, `/wt pr [branch]`, and `/wt sessions`. The shorthand `l` means `list` under either command: `/wt l` and `/worktree l` open the same interactive browser as `/worktree list`. Completion and confirmation/safety behavior are shared with the canonical command.

Configure aliases in `~/.pi/agent/worktree.json` (or `worktree.json` under `PI_CODING_AGENT_DIR`):

```json
{
  "commandAliases": {
    "wt": "worktree",
    "w": "worktree",
    "topics": "list",
    "worktree-clean": null
  },
  "subcommandAliases": {
    "l": "list",
    "ll": "list",
    "r": "rebase",
    "t": "tip"
  }
}
```

- **`commandAliases`** maps a slash-command name **without `/`** to `worktree` (forward all arguments) or a canonical subcommand (prepend that subcommand). For example, `/w r topic` means `/worktree rebase topic`, and `/topics` means `/worktree list`.
- **`subcommandAliases`** maps a first-argument shorthand to a canonical subcommand. The mapping applies to `/worktree` and all its full-command aliases. Arguments after the shorthand are preserved.
- Omitted entries keep their defaults. A string adds/remaps an alias; `null` disables it. For example, `"wt": null` disables `/wt`, and `"l": null` removes the list shorthand. The canonical `/worktree` command and canonical subcommands cannot be disabled or overridden.
- Targets are `create`, `list`, `sessions`, `clean`, `remove`, `rename`, `switch`, `rebase`, `tip`, `pr`, and `help`, plus `worktree` for slash-command aliases. Alias chains and targets containing arguments are rejected.
- Use lowercase alias names without spaces. Existing slash aliases default to `worktrees → list`, `worktree-clean → clean`, `worktree-remove → remove`, and `worktree-rename → rename`. Existing subcommand synonyms (`ls`, `add`, `new`, `session`, `cleanup`, `prune`, `rm`, `del`, `delete`, `mv`, `attach`, `go`, `--help`, `-h`) remain enabled and are configurable in the same way.
- Unknown first arguments still name branches for creation. To create a branch whose name is an enabled shorthand, use explicit creation, e.g. `/wt create l main`. Disabling a subcommand shorthand makes that name available for branch creation again.

Run `/reload` after editing the file. Enabled aliases appear in command/argument completion. A missing file uses defaults; an invalid file reports its path and prevents the extension from registering commands, rather than silently applying different aliases. This configuration is independent of the interactive list's `keybindings.json` bindings.

## Interactive list and keybindings

Run `/reload` after updating the extension, then `/worktree list` or `/worktrees`.

The browser starts in **normal mode**. Use `j`/`k` (or arrows) to highlight a worktree. Press `/` to enter **search mode**, then type a fuzzy branch/path query. Enter or Escape returns to normal mode while retaining the filter; neither executes an action. In search mode, action letters such as `x`, `r`, `t`, `j`, and `k` are text. Re-enter search and use Ctrl+U to clear the query. Bracketed paste is treated as search text, never action shortcuts.

| Action | Default keys | Keybinding identifier |
|---|---|---|
| Previous / next worktree | `k` / `j`, ↑ / ↓ | `worktree.list.up` / `worktree.list.down` |
| Page up / down | Ctrl+U / Ctrl+D, PageUp / PageDown | `worktree.list.pageUp` / `worktree.list.pageDown` |
| First / last worktree | `g` / Shift+G, Home / End | `worktree.list.first` / `worktree.list.last` |
| Search branches and paths | `/` | `worktree.list.search` |
| Switch / attach to selected worktree | Enter, `w` | `worktree.list.switch` |
| Remove selected worktree and branch | `x` | `worktree.list.remove` |
| Rename selected branch | `n` | `worktree.list.rename` |
| Rebase local main/master onto selected topic | `r` | `worktree.list.rebase` |
| Tip selected topic onto local main/master | `t` | `worktree.list.tip` |
| PR delivery and verified green CI for selected topic | `p` | `worktree.list.pr` |
| Create a new worktree | `c` | `worktree.list.create` |
| Refresh the list | `l` | `worktree.list.list` |
| Browse sessions across recorded worktrees | `s` | `worktree.list.sessions` |
| Clean **all** managed worktrees | Shift+C | `worktree.list.clean` |
| Show command help | `?` | `worktree.list.help` |
| Close the browser | `q`, Escape, Ctrl+C | `worktree.list.cancel` |

Create, refresh, sessions, clean, and help are global actions. Remove and clean retain their confirmation dialogs; rename asks for a new name. After create/rename/remove/clean/help, the browser reloads its statuses, preserving the selected checkout path and search where possible. Switch, sessions, rebase, tip, and PR close the browser to hand control to their existing workflows. A selected checkout that disappeared or changed branches is rejected before dispatch. Detached, bare, prunable, primary-checkout, locked, and default-branch restrictions are enforced as appropriate; unavailable row actions never silently select another branch.

Configure bindings in `~/.pi/agent/keybindings.json` (or the `keybindings.json` in your custom Pi agent directory), alongside existing Pi bindings:

```json
{
  "worktree.list.remove": ["d", "ctrl+x"],
  "worktree.list.rename": "shift+r",
  "worktree.list.clean": [],
  "worktree.list.down": ["j", "ctrl+n"],
  "worktree.list.up": ["k", "ctrl+p"]
}
```

A string or array replaces that action's defaults; `[]` disables it. Explicit assignments take precedence over other list actions' defaults. Assigning the same key explicitly to multiple list actions displays a conflict warning and will not execute that key. The footer shows effective bindings. These bindings are local to the worktree browser, not global editor shortcuts. Search-mode text editing and selection use Pi's usual `tui.input.*`, `tui.editor.*`, and `tui.select.*` bindings. Run `/reload` to apply configuration changes.

## Rebasing

The commands deliberately run in **opposite directions**:

| Command | Branch rewritten | Onto commit | Conflict-resolution checkout |
|---|---|---|---|
| `/worktree rebase [topic]` | Local `main`/`master` | Committed tip of the current/selected topic | Checkout holding `main`/`master` |
| `/worktree tip [topic]` | Current/selected topic | Local `main`/`master` | Selected topic checkout |

- **Selection:** in a topic worktree (including a subdirectory), both commands use that topic by default. On `main`/`master`, both open a topic-worktree picker. An explicit topic branch skips the picker. Managed and unmanaged worktrees are supported, including a topic in the primary checkout.
- **Default branch:** the invoking `main`/`master` is preferred; from a topic, `main` is preferred with `master` as fallback. Only local committed tips are used; neither command fetches or pushes.
- **`rebase` changes main/master history:** it executes in the checkout where the chosen default branch is checked out, not in the source topic checkout. That destination must be clean. The topic's committed tip is used and its branch and uncommitted files remain untouched; an unfinished Git operation in the topic is rejected.
- **Unoccupied main/master:** if the chosen default branch has no checkout, `rebase` creates a temporary worktree outside the repository. It never switches the selected topic checkout to main/master. Successful, clean temporary checkouts are safely removed without deleting the default branch. Conflicted or uncertain checkouts remain intact, and Pi is instructed to remove them only after successful conflict resolution and verification—never with `--force`.
- **`tip` preserves main/master:** it is the previous `/worktree rebase` behavior under its new name. The topic destination must be clean; uncommitted files in a main/master source checkout remain untouched.
- **Safety:** the branch being rewritten must have no uncommitted/untracked changes or unfinished Git operation. Busy agents and detached HEAD without an explicit topic are rejected. No automatic stashing, changes to unrelated branch refs, force-removal, or branch deletion are performed.
- **Conflicts:** Pi's prompt names the branch being rewritten, original/onto commits, and the absolute checkout where the rebase is actually paused. Pi inspects and resolves every conflicted commit, stages only resolved files, continues with a noninteractive editor, and verifies the resulting history. Ambiguous resolutions or non-conflict failures require user input and remain recoverable. Do not edit those checkouts with another agent while rebasing. Cancelling the Pi turn leaves the rebase paused; resume it or run `git -C <actual-rebase-checkout> rebase --abort` yourself. `/worktree pr` remains a topic-onto-remote-main/master workflow.

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
# Requires tmux and the package’s Pi peer dependencies; uses an isolated tmux server:
node --experimental-strip-types packages/worktree/remove.test.ts
node --experimental-strip-types packages/worktree/rebase.test.ts
node --experimental-strip-types packages/worktree/pr.test.ts
# Requires the package's Pi peer dependencies to be installed:
node --experimental-strip-types packages/worktree/aliases.test.ts
node --experimental-strip-types packages/worktree/command-menu.test.ts
node --experimental-strip-types packages/worktree/worktree-picker.test.ts
node --experimental-strip-types packages/worktree/worktree-list.test.ts
```

## Agent tools

`worktree_create`, `worktree_list`, `worktree_clean`, `worktree_remove`, `worktree_rename`, `worktree_pr_pause` (pause an active PR workflow with a concrete blocker; never marks CI green)
