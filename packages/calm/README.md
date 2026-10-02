# pi-extension-calm

A [pi](https://pi.dev) extension that adds **Calm mode**: a conversation-only transcript presentation, toggled with `/calm`.

While Calm is on, pi's transcript shows only the genuine conversation — your prompts, the agent's real replies, and the working status — and hides the noise in between: collapsed thinking, short mid-turn "working note" narration, and the built-in tool rows (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`) plus `codemode` calls and output. While an agent run is under way, the stock `Working...` row is replaced by one of 14 horizontal animations, each only one or two rows tall.

Nothing is deleted. Hidden content stays in the message, the model context, session storage, and `/export` artifacts — Calm changes presentation only.

## Behavior

- **Conversation-only transcript.** Collapsed thinking labels, short mid-turn assistant working notes, the built-in tool rows Calm owns, and entire `codemode` rows (calls, output, and images) are hidden from the live view. Toggling `/calm` applies to existing codemode rows too; turning it off restores them. Tool execution, nested calls, and stored results are unchanged.
- **Substantive text is preserved.** A mid-turn assistant text block is hidden only when it has no newline and its trimmed length is under 240 characters. A newline or ≥240 trimmed characters keeps it visible. Streaming text and the final reply always stay visible.
- **Animated working scene.** Each run randomly chooses from the preferred sailboat, fish, duck, ball, spinner, progress bar, wave, butterfly, and cat, plus five new progress-style bars. Motion travels along the terminal's full width or forms a full-width texture; every working scene uses at most two rows. Scenes reflow on resize and disappear when the run settles, aborts, or fails. The next run starts a freshly chosen scene.
- **Operational input rows.** User rows recognized by the bundled Firstmate operational-input parser (session-start, watcher, turn-end guard, away-supervisor, launch-brief, branch-outcome, from-firstmate) render at zero height. Every other user row stays visible.
- **Export stays complete.** `/export` and `/share` temporarily render stock rows so exported artifacts contain everything.
- **Persistent preference.** The last `/calm` choice is stored in `~/.pi/agent/calm` and restored on the next start.

## Working scenes

Each agent run picks uniformly from **1, 2, 3, 9, 11, 12, 14, 17, 18, and 21–25**. The disliked original scenes remain in the preview catalogue for reference but never appear in the working rotation. All scenes share a 220 ms tick and paint only single-column glyphs in a fixed ANSI palette, so they never depend on the active theme. The original 1–20 catalogue order below stays unchanged.

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
| `spinner` | A brighter `[ ⠋ ]` marker spinning and sweeping across a full-width track (one row) |
| `progress` | An indeterminate progress bar |
| `pulse` | A pulsing dot |
| `wave` | A travelling sine wave |
| `rocket` | A rocket flying with a flickering flame |
| `balloon` | A balloon floating across |
| `butterfly` | A butterfly flapping its wings |
| `cat` | A walking cat with a swishing tail |
| `coffee` | A steaming cup |
| `windmill` | A rotating windmill |

### New progress animations

These five additions span the terminal width and use **exactly one row**. They loop
as activity indicators, with no percentage, ETA, or claim about task completion.
Numbers 1–20 are unchanged.

| Number | Scene | Motion |
|---|---|---|
| 21 | `scanner` | A broad cyan band with a bright center sweeps from edge to edge and back |
| 22 | `conveyor` | Green shaded stripes flow continuously across the whole bar |
| 23 | `comet` | A bright arrowhead travels with a long fading trail, wrapping at the edge |
| 24 | `segments` | Successive blocks light up across the entire track, with a short trailing highlight |
| 25 | `zipper` | Two bright fronts advance inward from both ends, then retreat |

The scanner, comet, segments, and zipper use width-scaled motion so a wide terminal
does not turn a traverse into a minute-long wait. Each bar keeps a visible full-width
track and reflows on resize without adding height.

## Commands

| Command | Description |
|---|---|
| `/calm` | Toggle Calm mode on or off |
| `/calm-preview` | Show the 14 working animations, preserving the original numbers |
| `/calm-preview progress` | Compare bar 12 and the five new progress variants, all at full width |
| `/calm-preview 21` | Show just the scanner across the full terminal width (any number 1–25 works) |
| `/calm-preview all` | Show all 25 catalogue entries, including the excluded originals |
| `/calm-preview off` | Hide the preview and stop its timer |

The preview uses the actual working scenes, colors, and 220 ms tick. It keeps running
while you type or chat, without changing your Calm preference. The compact gallery
fits up to five columns. Use `/calm-preview <number>` to judge horizontal movement at
its real full width instead of inside a gallery cell. A focused preferred scene uses
only three or four preview rows including its label and help line. Numbering follows
the original catalogue above, from **1: sailboat** to **20: windmill**, followed by
**21–25: the new progress bars**. Re-running the
command restarts the preview; leaving or reloading the session closes it.

After editing the extension, use `/reload`, then `/calm-preview` to see the changes.

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

Calm probes the exact pi API seams it patches (collapsed-thinking layout, operational-user rows, codemode tool-row rendering) and degrades one adapter at a time with a console diagnostic if a future pi removes a seam — `/calm` and the rest of the extension keep working.

Calm's built-in tool presentation shares pi's single, unmerged override slot per tool name with any other extension that overrides the same tool. While Calm is off it registers none of them. The first time Calm turns on in a session that started off, it claims every built-in name no other extension already owns and warns about the ones it skipped.

## Tests

The animation catalogue has a self-running check:

```bash
node --experimental-strip-types packages/calm/test.ts
```

With the host peer dependencies available, the codemode presentation regression checks
exercise Pi’s real `ToolExecutionComponent`, including toggles, streaming/completed
output, export rendering, and reload-safe installation:

```bash
node --experimental-strip-types packages/calm/test-tool-layout.ts
```

## Provenance

Vendored from [Firstmate](https://github.com/kunchenguid/firstmate) at commit `2bcb88c38921030033a37d67ae4f5d82cea90eb4` (`.pi/extensions/fm-calm.ts` and its `lib/` dependencies). Firstmate is MIT licensed; see [`LICENSE.firstmate`](./LICENSE.firstmate). Local changes: the Calm preference is fixed at `~/.pi/agent/calm`, the operational-input helper is fixed at the bundled `./bin/fm-operational-input.sh`, and `lib/fm-calm-animations.ts` adds a numbered working-animation catalogue and curated rotation (the original sailboat is kept as one scene).