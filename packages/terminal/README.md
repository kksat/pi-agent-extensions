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
- **Universal Hotkey Detach/Resume:** Press `alt+e` inside Neovim to suspend it and return to Pi; press `alt+e` in Pi to resume Neovim right where you left off.
- **Decoupled Cross-Session Persistence:** Terminals and editors survive `/new`, `/resume`, `/fork`, and `/reload`.
- **Throttled Background Rendering:** Hidden overlay terminals update their VT buffers in memory without triggering Pi transcript re-renders.
- **Full VT Emulation for Overlays:** `@xterm/headless` + `node-pty` with truecolor, 256 colors, Kitty keyboard translation, and dynamic resizing.
- **Configurable Dimensions:** Set overlay `width` and `height` per terminal (defaults to full screen `100%`).
- **Inspection & Management (`/terminal`):** Interactive menu and slash commands to list, focus, restart, or kill running sessions.
- **Footer Status Indicators:** See active terminals and suspended editors at a glance in Pi's footer.

## Usage

Without configuration you get one plain terminal toggled with **Ctrl+/** in a pi
TUI session. Uses `$SHELL` (falls back to `/bin/zsh`).

### Configuring terminals

Create `~/.pi/agent/pi-terminal.json` to define any number of independent terminals:

```json
{
  "terminals": [
    { "key": "alt+t", "width": "100%", "height": "100%" },
    { "key": "alt+e", "command": "nvim", "name": "editor", "mode": "passthrough" },
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

### Modes: Passthrough vs. Overlay

- **`passthrough` mode (default for editors & TUIs):**
  Temporarily pauses Pi's TUI and streams raw terminal I/O directly between the process and host terminal.
  - Zero V8 string allocation overhead and zero transcript re-rendering lag, regardless of how long the conversation is.
  - Full GPU acceleration, native tree-sitter/LSP performance, native mouse support, and 0ms latency.
  - **Single-hotkey toggle:** Press your hotkey (e.g. `alt+e`) inside the editor to suspend it and return to Pi. Press it again in Pi to resume instantly with all buffers, tabs, and undo history intact. Standard `:wq` / `:q` exits normally.
- **`overlay` mode (default for shells):**
  Runs in a persistent background PTY rendered in a floating overlay pane.
  - Background output is throttled when hidden so active watchers never cause Pi typing lag.
  - The overlay width and height are configurable (e.g. `"100%"` or `"80%"`).

### Management Command: `/terminal`

- `/terminal`: Opens an interactive selector to view, focus, restart, or kill active sessions.
- `/terminal list`: Shows active sessions, PIDs, running foreground processes, and hotkeys.
- `/terminal kill <name|all>`: Gracefully terminates a session and its child process tree.
- `/terminal restart <name>`: Kills and restarts a fresh session.
- `/terminal focus <name>`: Focuses or resumes the specified terminal.

## License

GPL-3.0-only
