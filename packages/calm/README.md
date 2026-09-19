# pi-extension-calm

A [pi](https://pi.dev) extension that adds **Calm mode**: a conversation-only transcript presentation, toggled with `/calm`.

While Calm is on, pi's transcript shows only the genuine conversation — your prompts, the agent's real replies, and the working status — and hides the noise in between: collapsed thinking, short mid-turn "working note" narration, and the shells of the built-in tool rows (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`). While an agent run is under way, the stock `Working...` row is replaced by a small animated sailboat.

Nothing is deleted. Hidden content stays in the message, the model context, session storage, and `/export` artifacts — Calm changes presentation only.

## Behavior

- **Conversation-only transcript.** Collapsed thinking labels, short mid-turn assistant working notes, and the shells of the built-in tool rows Calm owns are hidden from the live view.
- **Substantive text is preserved.** A mid-turn assistant text block is hidden only when it has no newline and its trimmed length is under 240 characters. A newline or ≥240 trimmed characters keeps it visible. Streaming text and the final reply always stay visible.
- **Animated working boat.** While a run is active, the stock working row is replaced by a two-row sailboat: a `◿│◣` sail over a `╲▁▁▁╱` hull, in standard ANSI blue water and yellow boat. The boat moves one column every 880 ms while the wave advances every 220 ms. It reflows on resize, disappears when the run settles, aborts, or fails, and resumes from its last position on the next run within the same session.
- **Operational input rows.** User rows recognized by the bundled Firstmate operational-input parser (session-start, watcher, turn-end guard, away-supervisor, launch-brief, branch-outcome, from-firstmate) render at zero height. Every other user row stays visible.
- **Export stays complete.** `/export` and `/share` temporarily render stock rows so exported artifacts contain everything.
- **Persistent preference.** The last `/calm` choice is stored in `~/.pi/agent/calm` and restored on the next start.

## Commands

| Command | Description |
|---|---|
| `/calm` | Toggle Calm mode on or off |

## Install

```bash
# after cloning this repo
pi install /absolute/path/to/pi-agent-extensions/packages/calm
```

Or from npm, if published:

```bash
pi install npm:pi-extension-calm
```

## Environment variables

| Variable | Description |
|---|---|
| `FM_CONFIG_OVERRIDE` | Directory holding the `calm` preference file (default: `~/.pi/agent`) |
| `FM_HOME` / `FM_ROOT_OVERRIDE` | Firstmate home; when set, the preference file lives in `<home>/config/calm` |
| `FM_OPERATIONAL_INPUT_SCRIPT` | Path to the operational-input parser (default: bundled `./bin/fm-operational-input.sh`) |

## Compatibility

Calm probes the exact pi API seams it patches (collapsed-thinking layout, operational-user rows) and degrades one adapter at a time with a console diagnostic if a future pi removes a seam — `/calm` and the rest of the extension keep working.

Calm's built-in tool presentation shares pi's single, unmerged override slot per tool name with any other extension that overrides the same tool. While Calm is off it registers none of them. The first time Calm turns on in a session that started off, it claims every built-in name no other extension already owns and warns about the ones it skipped.

## Provenance

Vendored from [Firstmate](https://github.com/kunchenguid/firstmate) at commit `2bcb88c38921030033a37d67ae4f5d82cea90eb4` (`.pi/extensions/fm-calm.ts` and its `lib/` dependencies). Firstmate is MIT licensed; see [`LICENSE.firstmate`](./LICENSE.firstmate). Local changes: the Calm preference defaults to `~/.pi/agent/calm` instead of a Firstmate home, and the operational-input helper lives in `./bin`.