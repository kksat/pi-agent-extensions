# pi-extension-worktree

A [pi](https://pi.dev) extension for managing git worktrees with seamless tmux integration.

Spin out new features, bugfixes, and experiments into isolated git worktrees running `pi` coding agents in tmux — without prompts — and manage or clean them up easily.

## Features

- **Promptless agent launch**: spawns `pi --name "wt:<branch>"` in tmux so the child agent is immediately ready for your interaction.
- **Tmux native**: inside tmux, opens a new window in the active session; otherwise creates a detached session.
- **Tracking & registry**: tracks worktrees created by the extension in `.pi/worktrees.json`.
- **Easy cleanup**: safely kills tmux windows, removes git worktrees, and deletes topic branches with `/worktree clean`.
- **Flexible management**: list, switch, rename, or remove individual worktrees.
- **Interactive UI**: `/worktree` with no arguments opens an interactive menu.
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
| `/worktree` | Interactive menu |
| `/worktree list` · `/worktrees` | List worktrees with managed & tmux status |
| `/worktree clean` · `/worktree-clean` | Remove all managed worktrees & branches |
| `/worktree remove [branch]` · `/worktree-remove` | Remove one worktree |
| `/worktree rename <old> <new>` · `/worktree-rename` | Rename a branch |
| `/worktree switch [branch]` | Switch / attach to its tmux window |
| `/worktree help` | Show help |

## Agent tools

`worktree_create`, `worktree_list`, `worktree_clean`, `worktree_remove`, `worktree_rename`
