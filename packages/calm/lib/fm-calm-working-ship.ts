// Firstmate's Calm-only animated working presentation for Pi.
//
// Calm replaces Pi's stock working row with one of a set of small animated scenes while
// one logical agent run is active. The scene catalogue, the frame/run vocabulary, and
// the random selection are owned by ./fm-calm-animations.ts; this module owns only Pi's
// rendering of those frames as standard ANSI escapes and the temporary TUI widget.
// `.pi/extensions/fm-calm.ts` owns when the presentation is installed and removed, and
// stays the sole caller of setWorkingVisible(). docs/calm.md owns the captain-facing
// contract.
//
// Continuity: one animation instance is owned per working period. Disposing the widget
// freezes the scene at its last painted frame without advancing it for hidden wall
// time, and the next widget bound to the same animation resumes from that exact logical
// state. A fresh working period re-rolls the scene, so every agent run gets a different
// animation. State is never a module-level or process-global singleton.
//
// Verified against Pi 0.81.1 declarations and the Pi 0.82.0 CLI, which expose
// ExtensionUIContext.setWidget() with a component factory, per-widget dispose(), and
// TUI.requestRender(). Pi renders a widget through Component.render(width), so this
// module recomputes its track from that width on every frame instead of caching a
// terminal size that a resize would invalidate. A resize while the boat is hidden is
// applied on the first resumed frame through the same clamp path.
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  createRandomCalmAnimationSprite,
  type CalmAnimationColor,
  type CalmAnimationRun,
  type CalmAnimationSprite,
} from "./fm-calm-animations.ts";
import {
  CALM_WORKING_SHIP_TICK_MS,
  CALM_WORKING_SHIP_TICKS_PER_MOVE,
} from "./fm-calm-working-ship-sprite.ts";

export { CALM_WORKING_SHIP_TICK_MS, CALM_WORKING_SHIP_TICKS_PER_MOVE };

// Standard ANSI foreground codes only: no theme lookup, bright variant, or 256/RGB.
// Each scene picks from this fixed palette so its glyphs never split into mismatched
// colors and never depend on the active theme.
const ANSI_FOREGROUND: Record<Exclude<CalmAnimationColor, "plain">, string> = {
  water: "\u001b[34m",
  boat: "\u001b[33m",
  accent: "\u001b[36m",
  warm: "\u001b[31m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  dim: "\u001b[90m",
  bright: "\u001b[97m",
};
// Restores the default foreground so color never bleeds into padding or later frames.
const RESET = "\u001b[39m";

export const CALM_WORKING_SHIP_WIDGET_KEY = "firstmate-calm-working-ship";

export type CalmWorkingShipAnimation = CalmAnimationSprite & {
  /** Render one frame that exactly fits `width`, clamping the track to it first. */
  render(width: number): string[];
};

/** One run painted as its standard ANSI escape, closed with a default-foreground reset. */
function paintRun(run: CalmAnimationRun): string {
  if (run.color === "plain") return run.text;
  return `${ANSI_FOREGROUND[run.color]}${run.text}${RESET}`;
}

/** Wrap one scene as a Pi-renderable animation. */
export function createCalmWorkingShipAnimationFor(
  sprite: CalmAnimationSprite,
): CalmWorkingShipAnimation {
  return {
    ...sprite,
    render(width: number): string[] {
      return sprite.frame(width).map((row) => row.map(paintRun).join(""));
    },
  };
}

/** Build an animation around a scene chosen uniformly at random. */
export function createCalmWorkingShipAnimation(): CalmWorkingShipAnimation {
  return createCalmWorkingShipAnimationFor(createRandomCalmAnimationSprite());
}

/**
 * Build the temporary Calm working widget bound to one caller-owned animation.
 * Pi disposes the previous component before installing a replacement under the same
 * key and when it clears extension widgets, so the single scheduler driving both
 * cadences cannot outlive the widget or duplicate. Disposing freezes the shared
 * animation in place; the next widget bound to the same animation resumes without
 * applying hidden wall time.
 */
export function createCalmWorkingShipWidget(
  tui: TUI,
  animation: CalmWorkingShipAnimation = createCalmWorkingShipAnimation(),
): Component & { dispose(): void } {
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed) return;
    animation.tick();
    tui.requestRender();
  }, CALM_WORKING_SHIP_TICK_MS);
  // The animation must never keep Pi's process alive on its own.
  timer.unref?.();

  return {
    render: (width) => (disposed ? [] : animation.render(width)),
    // Every frame is rebuilt from fixed standard ANSI codes, so there is no cache.
    invalidate: () => {},
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      animation.restoreLastRendered();
    },
  };
}
