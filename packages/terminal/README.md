# pi-extension-terminal

A [pi](https://pi.dev) extension that embeds real PTY-backed terminal panes and zero-overhead native editors inside pi.

- First press: creates the session and shows it (optionally running a configured command)
- Later presses: shows/hides or resumes/suspends the existing session (state is preserved)
- While focused, pressing the hotkey returns to pi without losing work; pressing another terminal's hotkey switches straight to that terminal
- The terminals and editors keep running/persisting across `/new`, `/resume`, `/fork`, and `/reload`
- Clean process tree teardown on quit: sends `SIGHUP` and escalates to `SIGKILL`, preventing orphan process leaks

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/terminal
```

Or from npm, if published:

```bash
pi install npm:pi-extension-terminal
```

## Features

- **Zero-Lag Native Passthrough Mode:** Run editors like Neovim directly on the host terminal with raw I/O. Completely eliminates chat transcript re-rendering lag in long conversations.
- **Universal Hotkey Detach/Resume:** Press `alt+e` inside Neovim to return to Pi; press `alt+e` in Pi to resume Neovim right where you left off, with screen styling, cursor state, and terminal input modes restored. Output produced while hidden stays in the saved screen, not Pi's transcript.
- **Pristine Scroll Recovery:** Terminal mouse tracking, alternate screens, and bracketed paste are cleanly restored on detach so Pi's native trackpad/mouse scrolling works without interference.
- **Decoupled Cross-Session Persistence:** Terminals and editors survive `/new`, `/resume`, `/fork`, and `/reload`.
- **Throttled Background Rendering:** Hidden overlay terminals update their VT buffers in memory without triggering Pi transcript re-renders.
- **Configurable Dimensions:** Set overlay `width` and `height` per terminal (defaults to full screen `100%`).
- **Configurable Grace Period:** Adjustable key-repeat cooldown (`gracePeriodMs`) to prevent accidental immediate re-suspends.
- **Session-Scoped & Global Inspection (`/terminal` and `/terminals`):** Interactive managers showing folder and session name, with quick hotkeys (`[x]` kill, `[r]` restart, `[Enter/f]` focus).
- **Footer Status Indicators:** See active terminals and suspended editors at a glance in Pi's footer.
- **Prompt Channel (`$PI_TERMINAL_SOCK`):** Programs running inside a terminal (e.g. nvim) can submit prompts to the enclosing Pi session over a Unix socket. Passthrough editors detach back to Pi automatically when a prompt arrives.

## Usage

Without configuration you get one plain terminal toggled with **Ctrl+/** in a pi
TUI session. Uses `$SHELL` (falls back to `/bin/zsh`).

### Configuring terminals

Create `~/.pi/agent/pi-terminal.json` to define any number of independent terminals:

```json
{
  "gracePeriodMs": 350,
  "terminals": [
    { "key": "alt+t", "width": "100%", "height": "100%" },
    { "key": "alt+e", "command": "nvim", "name": "editor", "mode": "passthrough", "gracePeriodMs": 350 },
    { "key": "alt+g", "command": "lazygit", "name": "git", "mode": "passthrough" }
  ]
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `key` | Hotkey that opens/toggles the terminal (required) | — |
| `command` | Optional command run inside the terminal when first created | — |
| `name` | Optional label used in notifications and footer status | `command` or `Terminal` |
| `mode` | `"passthrough"` (zero-overhead native terminal) or `"overlay"` (embedded floating pane) | `"passthrough"` for interactive editors (`nvim`, `vim`, `nano`, `helix`, etc.) and TUIs (`lazygit`, `htop`); `"overlay"` for shells |
| `width` | Overlay width percentage or column count | `"100%"` |
| `height` | Overlay height percentage or row count | `"100%"` |
| `gracePeriodMs` | Cooldown period in milliseconds to swallow initial key release/repeats | `350` (or root `gracePeriodMs`) |

### Modes: Passthrough vs. Overlay

- **`passthrough` mode (default for editors & TUIs):**
  Temporarily pauses Pi's TUI and streams raw terminal I/O directly between the process and host terminal.
  - Zero V8 string allocation overhead and zero transcript re-rendering lag, regardless of how long the conversation is.
  - Full GPU acceleration, native tree-sitter/LSP performance, native mouse support, and 0ms latency.
  - **Single-hotkey toggle:** Press your hotkey (e.g. `alt+e`) inside the editor to suspend it and return to Pi. Press it again in Pi to resume instantly with all buffers, tabs, and undo history intact. Standard `:wq` / `:q` exits normally.
- **`overlay` mode (default for shells):**
  Runs in a persistent background PTY rendered in a floating overlay pane.
  - Background output is throttled when hidden so active watchers never cause Pi typing lag.
  - The overlay width and height are configurable (defaults to `"100%"`).

### Commands: `/terminal` and `/terminals`

- **/terminal:** Manages terminals attached to the **current session** (matching the session ID or current working directory).
- **/terminals:** Manages **all terminals globally** across all sessions, worktrees, and folders.

Both commands provide an interactive manager with single-key controls:
- **`↑` / `↓`** (or **`j` / `k`**): Navigate between terminals
- **`Enter`** or **`f`**: Focus / switch to the selected terminal
- **`x`**: Kill / close the selected terminal immediately
- **`r`**: Restart the selected terminal
- **`Tab`**: Toggle between session-scoped view and global view
- **`Esc`** or **`q`**: Exit the manager

### Prompt channel: send prompts from inside a terminal to Pi

Every terminal's child process receives `PI_TERMINAL_SOCK` in its environment, pointing at a Unix socket owned by the enclosing Pi session. Each newline-terminated line written to that socket is a command for the enclosing session:

| Payload | Effect |
|---|---|
| plain text or `{ "text": "...", "mode": "submit" }` | Submit as a user message (detaches a passthrough editor first) |
| `{ "text": "...", "mode": "input" }` | Replace Pi's input box text, then detach (multi-line prompts must be JSON-framed) |
| `{ "text": "...", "mode": "append", "header": "..." }` | Append one numbered item to Pi's input box, no detach; `{count}` in the header is replaced with the item count |
| `{ "mode": "clear" }` | Empty Pi's input box, no detach |
| `{ "mode": "focus" }` | Detach a passthrough editor back to Pi |

Appends made while a passthrough editor has the screen are buffered and applied when it detaches (Pi restores the input text captured when the editor attached, so immediate writes would be reverted). Numbering counts the numbered lines already in the input, so it stays correct across sends from Pi.

Prompt-socket servers survive `/reload` and dispatch through the current module code, so extension updates apply to live terminals without restarting them. Servers created before this indirection existed are retired on load; a terminal started under such an old version needs one restart (`/terminal restart <name>`) to pick up a fresh socket.

From a shell inside a terminal:

```bash
printf 'Review src/app.ts:42\n' | nc -U "$PI_TERMINAL_SOCK"
```

From nvim (no `nc` needed, using nvim's built-in `sockconnect`), see a ready-made review keybind in [pi-review.lua](https://github.com/kksat/pi-agent-extensions). The core of it:

```lua
local chan = vim.fn.sockconnect("pipe", os.getenv("PI_TERMINAL_SOCK"), { rpc = false })
vim.fn.chansend(chan, "Review " .. vim.fn.expand("%:p") .. ":" .. vim.fn.line(".") .. " comment: ..." .. "\n")
vim.fn.chanclose(chan)
```

While nvim runs in passthrough mode, the review keybinds work like this: an immediate keybind submits a comment straight to the model; an "add" keybind appends each comment to Pi's input box as you go (you stay in nvim), and a "send" keybind detaches back to Pi, where the accumulated comments sit in the input box ready to edit and send with Enter. Alternatively, `add_mode = "queue"` in `vim.g.pi_review` accumulates comments inside nvim and flushes them in one batch. The per-item prompt format is configurable via `vim.g.pi_review` — separate templates for cursor items and visual selections, toggles for the symbol, line text, or column, and placeholders including `{file}` (absolute), `{relative_file_path}` (relative to Pi's working directory), `{line1}`/`{line2}`, `{col}`, `{symbol}`, `{line_text}`, `{comment}` — see the header of `pi-review.lua` for the full option list. Socket files live in `$TMPDIR` and are removed when Pi exits.

#### CLI Subcommands:

- `/terminal list` / `/terminals list`: Formatted list showing terminal name, folder, session name, PID, running process, and status.
- `/terminal kill <name|all>` / `/terminals kill <name|all>`: Gracefully terminate sessions and child process trees.
- `/terminal restart <name>`: Kill and restart a session.
- `/terminal focus <name>`: Focus or resume a terminal.

## Development checks

From `packages/terminal`, run `npm install` and `npm test`. The tests cover screen
serialization and drive a real Neovim PTY through repeated hide/reopen cycles,
background output, and resizing. They require `nvim` on `PATH` and use an isolated
configuration and temporary buffers, never your Neovim configuration or files.

## License

GPL-3.0-only
