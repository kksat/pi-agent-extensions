# pi-extension-calm

A [pi](https://pi.dev) extension that adds **Calm mode**: a conversation-only transcript presentation, toggled with `/calm`.

While Calm is on, pi's transcript shows only the genuine conversation — your prompts, the agent's real replies, and the working status — and hides the noise in between: collapsed thinking, short mid-turn "working note" narration, and the shells of the built-in tool rows (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`). While an agent run is under way, the stock `Working...` row is replaced by one of 20 small animated scenes.

Nothing is deleted. Hidden content stays in the message, the model context, session storage, and `/export` artifacts — Calm changes presentation only.

## Behavior

- **Conversation-only transcript.** Collapsed thinking labels, short mid-turn assistant working notes, and the shells of the built-in tool rows Calm owns are hidden from the live view.
- **Substantive text is preserved.** A mid-turn assistant text block is hidden only when it has no newline and its trimmed length is under 240 characters. A newline or ≥240 trimmed characters keeps it visible. Streaming text and the final reply always stay visible.
- **Animated working scene.** While a run is active, the stock working row is replaced by one of 20 small animated scenes, chosen at random for every run. The original sailboat is one of them; the rest include a fish, duck, clouds, stars, moon, rain, snow, bouncing ball, pendulum, spinner, progress bar, pulse, wave, rocket, balloon, butterfly, cat, coffee, and windmill. Scenes reflow on resize, disappear when the run settles, aborts, or fails, and resume from their last frame on the next run within the same session.
- **Operational input rows.** User rows recognized by the bundled Firstmate operational-input parser (session-start, watcher, turn-end guard, away-supervisor, launch-brief, branch-outcome, from-firstmate) render at zero height. Every other user row stays visible.
- **Export stays complete.** `/export` and `/share` temporarily render stock rows so exported artifacts contain everything.
- **Persistent preference.** The last `/calm` choice is stored in `~/.pi/agent/calm` and restored on the next start.

## Working scenes

Each agent run picks one scene at random. All scenes share a 220 ms tick and paint only single-column glyphs in a fixed ANSI palette, so they never depend on the active theme.

| Scene | Description |
|---|---|
| `sailboat` | The original Firstmate sailboat on a rolling swell |
| `fish` | A fish swimming across with a wiggling tail |
| `duck` | A duck paddling along a water line |
| `clouds` | Two clouds drifting at different speeds |
| `stars` | A twinkling starfield |
| `moon` | A moon cycling through its phases |
| `rain` | Falling raindrops |
| `snow` | Drifting snowflakes |
| `ball` | A ball bouncing along the ground |
| `pendulum` | A pendulum swinging from a pivot |
| `spinner` | A braille spinner |
| `progress` | An indeterminate progress bar |
| `pulse` | A pulsing dot |
| `wave` | A travelling sine wave |
| `rocket` | A rocket flying with a flickering flame |
| `balloon` | A balloon floating across |
| `butterfly` | A butterfly flapping its wings |
| `cat` | A walking cat with a swishing tail |
| `coffee` | A steaming cup |
| `windmill` | A rotating windmill |

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

## Compatibility

Calm probes the exact pi API seams it patches (collapsed-thinking layout, operational-user rows) and degrades one adapter at a time with a console diagnostic if a future pi removes a seam — `/calm` and the rest of the extension keep working.

Calm's built-in tool presentation shares pi's single, unmerged override slot per tool name with any other extension that overrides the same tool. While Calm is off it registers none of them. The first time Calm turns on in a session that started off, it claims every built-in name no other extension already owns and warns about the ones it skipped.

## Tests

The animation catalogue has a self-running check:

```bash
node --experimental-strip-types packages/calm/test.ts
```

## Provenance

Vendored from [Firstmate](https://github.com/kunchenguid/firstmate) at commit `2bcb88c38921030033a37d67ae4f5d82cea90eb4` (`.pi/extensions/fm-calm.ts` and its `lib/` dependencies). Firstmate is MIT licensed; see [`LICENSE.firstmate`](./LICENSE.firstmate). Local changes: the Calm preference is fixed at `~/.pi/agent/calm`, the operational-input helper is fixed at the bundled `./bin/fm-operational-input.sh`, and `lib/fm-calm-animations.ts` adds the 20-scene working-animation catalogue (the original sailboat is kept as one scene).