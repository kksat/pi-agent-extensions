# pi-extension-terminal

A [pi](https://pi.dev) extension that embeds real PTY-backed terminal panes inside pi.

- First press: creates the terminal session and shows it (optionally running a
  configured command inside it)
- Later presses: shows/hides the existing session (state is preserved)
- While a terminal has focus, its hotkey hides it and returns to pi; a
  different terminal's hotkey switches straight to that terminal

The terminals keep running while hidden, so long-running commands keep going.
They only die when you quit pi.

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

- Full VT emulation (`@xterm/headless` + `node-pty`) — full-screen apps like `vim` and `htop` work
- Multiple independent terminals with configurable hotkeys and start commands
- 256-color and truecolor output preserved
- Kitty keyboard protocol input is translated back to legacy sequences for the shell
- Live resize with the pane
- Session survives `/new`, `/resume`, `/fork`; killed on quit

## Usage

Without configuration you get one plain terminal toggled with **Ctrl+/** in a pi
TUI session. Uses `$SHELL` (falls back to `/bin/zsh`).

### Configuring terminals

Create `~/.pi/agent/pi-terminal.json` to define any number of independent
terminals. Each entry gets its own persistent PTY:

```json
{
  "terminals": [
    { "key": "ctrl+/" },
    { "key": "alt+e", "command": "nvim", "name": "editor" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `key` | Hotkey that opens/shows the terminal (required) |
| `command` | Optional command run inside the terminal when it is first created |
| `name` | Optional label used in notifications (defaults to `command` or `Terminal`) |

Restart pi (or run `/reload`) after editing the config. If the config file is
missing or malformed, only the default **Ctrl+/** terminal is provided.

## Limitations

- Mouse events are not forwarded to programs running inside the pane
- Terminal hotkeys are consumed globally: while a pane is focused its hotkey
  hides it instead of reaching the program inside — pick keys you do not need
  inside your terminal applications
- Shifted-symbol edge cases under the Kitty protocol are best-effort

## License

GPL-3.0-only
