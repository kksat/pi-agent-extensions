# pi-extension-worktree

A [pi](https://pi.dev) extension for managing git worktrees with seamless tmux integration.

Spin out new features, bugfixes, and experiments into isolated git worktrees running `pi` coding agents in tmux — without prompts — and manage or clean them up easily.

## Features

- **Promptless agent launch**: spawns `pi --name "wt:<branch>"` in tmux so the child agent is immediately ready for your interaction.
- **Tmux native**: inside tmux, opens a new window in the active session; otherwise creates a detached session.
- **Tracking & registry**: tracks worktrees created by the extension in the main checkout's `.pi/worktrees.json` (shared by every linked worktree). Each created worktree is also kept in `known`, which is not removed when the checkout is deleted.
- **Sessions across worktrees**: `/worktree sessions` lists pi sessions for every recorded worktree, including checkouts that no longer exist, and can fork one into the current folder or another living directory. `git worktree list` is used only when nothing has been written down yet. Outside a git repository, the same command opens the usual session list for the current folder.
- **Easy cleanup**: safely kills tmux windows, removes git worktrees, and deletes topic branches with `/worktree clean`. Cleanup drops the active record and leaves the `known` path so its sessions stay reachable.
- **Flexible management**: list, switch, rename, or remove individual worktrees.
- **Interactive UI**: `/worktree` with no arguments opens an interactive menu. Sessions is one choice, next to list, remove, and the other worktree actions. Outside a git repository, that choice opens the usual session list.
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
| `/worktree` | Interactive menu. Sessions is one choice |
| `/worktree list` · `/worktrees` | List worktrees with managed & tmux status |
| `/worktree sessions` | Resume a session from a recorded worktree, including removed checkouts, in this folder or another. Outside a git repo, opens the usual session list |
| `/worktree clean` · `/worktree-clean` | Remove all managed worktrees & branches |
| `/worktree remove [branch]` · `/worktree-remove` | Remove one worktree |
| `/worktree rename <old> <new>` · `/worktree-rename` | Rename a branch |
| `/worktree switch [branch]` | Switch / attach to its tmux window |
| `/worktree help` | Show help |

## Agent tools

`worktree_create`, `worktree_list`, `worktree_clean`, `worktree_remove`, `worktree_rename`
