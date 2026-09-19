// Calm's working-animation catalogue.
//
// Calm replaces Pi's stock working row with one of a set of small animated scenes
// while an agent run is active. This module owns the scene catalogue, the shared
// frame/run vocabulary, and the random selection. ./fm-calm-working-ship.ts owns Pi's
// ANSI rendering and the temporary TUI widget, and ./fm-calm-working-ship-sprite.ts
// owns the original sailboat scene.
//
// Every scene conforms to CalmAnimationSprite: frame(width) paints rows of color-tagged
// runs, tick() advances one scheduler step, restoreLastRendered() freezes at the last
// painted frame, reset() returns to the initial state, and clampToWidth(width) reflows
// a frozen scene after a resize. Scenes never import a harness and never touch global
// state, so each instance is independent and testable.
//
// A scene paints single-column glyphs only, so a run's text length is its column count
// under every terminal width rule. Scenes that need variation derive it from a stable
// hash of the column and the tick, never from Math.random(), so a frozen scene resumes
// on exactly the frame it was frozen at.

import { createCalmWorkingShipSprite } from "./fm-calm-working-ship-sprite.ts";

/** The color classes a scene may paint. `plain` is the terminal's default foreground. */
export type CalmAnimationColor =
  | "plain"
  | "water"
  | "boat"
  | "accent"
  | "warm"
  | "green"
  | "magenta"
  | "dim"
  | "bright";

/** One same-colored run of cells inside a frame row. */
export type CalmAnimationRun = {
  readonly text: string;
  readonly color: CalmAnimationColor;
};

/** One painted frame: rows of runs, each row exactly the requested width. */
export type CalmAnimationFrame = readonly (readonly CalmAnimationRun[])[];

export type CalmAnimationSprite = {
  /** Stable scene name, used for diagnostics and tests. */
  readonly name: string;
  /** Paint one frame that exactly fits `width`, clamping the scene to it first. */
  frame(width: number): CalmAnimationFrame;
  /** Advance one scheduler tick. */
  tick(): void;
  /** Return to the state of the last painted frame, discarding later ticks. */
  restoreLastRendered(): void;
  /** Restore the normal initial state. */
  reset(): void;
  /** Clamp a frozen scene to `width` without advancing time. */
  clampToWidth(width: number): void;
};

export type CalmAnimationFactory = () => CalmAnimationSprite;

export type CalmAnimationDefinition = {
  readonly name: string;
  readonly create: CalmAnimationFactory;
};

type Placement = {
  at: number;
  text: string;
  color: CalmAnimationColor;
};

type AnimationSpec<S extends object> = {
  createState(): S;
  tick(state: S): void;
  paint(state: S, width: number): CalmAnimationFrame;
  clamp?(state: S, width: number): void;
};

/** Build one row of `width` cells from sparse placements, merging same-colored runs. */
function paintRow(
  width: number,
  placements: readonly Placement[],
  background: CalmAnimationColor = "plain",
): CalmAnimationRun[] {
  if (width <= 0) return [];
  const chars: string[] = new Array(width).fill(" ");
  const colors: CalmAnimationColor[] = new Array(width).fill(background);
  for (const placement of placements) {
    const glyphs = Array.from(placement.text);
    for (let index = 0; index < glyphs.length; index += 1) {
      const column = placement.at + index;
      if (column < 0 || column >= width) continue;
      chars[column] = glyphs[index];
      colors[column] = placement.color;
    }
  }
  const runs: CalmAnimationRun[] = [];
  for (let column = 0; column < width; column += 1) {
    const last = runs[runs.length - 1];
    if (last && last.color === colors[column]) {
      runs[runs.length - 1] = { text: last.text + chars[column], color: last.color };
    } else {
      runs.push({ text: chars[column], color: colors[column] });
    }
  }
  return runs;
}

/** Left column that centers `text` in `width` usable cells. */
function centered(width: number, text: string): number {
  return Math.max(0, Math.floor((width - Array.from(text).length) / 2));
}

/** Clamp a scene's left column so a `spriteWidth`-wide scene stays inside `width`. */
function clampColumn(column: number, width: number, spriteWidth: number): number {
  return Math.max(0, Math.min(column, Math.max(0, width - spriteWidth)));
}

/** Stable bounded variation for a column or tick, so scenes never use Math.random(). */
function hash(value: number): number {
  let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Shallow clone of a flat primitive state object, used for freeze/resume snapshots. */
function cloneState<S extends object>(state: S): S {
  return { ...state };
}

/**
 * Build a scene from a state machine. The returned factory owns one independent
 * instance per call; `frame()` clamps and snapshots, `tick()` advances, and
 * `restoreLastRendered()` rewinds to the last painted frame.
 */
function defineAnimation<S extends object>(
  name: string,
  spec: AnimationSpec<S>,
): CalmAnimationDefinition {
  return {
    name,
    create: () => {
      let state = spec.createState();
      let rendered = cloneState(state);
      return {
        name,
        frame(width: number): CalmAnimationFrame {
          spec.clamp?.(state, width);
          const frame = spec.paint(state, width);
          rendered = cloneState(state);
          return frame;
        },
        tick(): void {
          spec.tick(state);
        },
        restoreLastRendered(): void {
          state = cloneState(rendered);
        },
        reset(): void {
          state = spec.createState();
          rendered = cloneState(state);
        },
        clampToWidth(width: number): void {
          spec.clamp?.(state, width);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

// The original Firstmate sailboat, kept byte-for-byte through its own module.
const sailboat: CalmAnimationDefinition = {
  name: "sailboat",
  create: () => {
    const sprite = createCalmWorkingShipSprite();
    return {
      name: "sailboat",
      frame: (width) => sprite.frame(width),
      tick: () => sprite.tick(),
      restoreLastRendered: () => sprite.restoreLastRendered(),
      reset: () => sprite.reset(),
      clampToWidth: (width) => sprite.clampToWidth(width),
    };
  },
};

const fish = defineAnimation("fish", {
  createState: () => ({ x: 0, dir: 1, phase: 0 }),
  tick: (state) => {
    state.phase += 1;
    if (state.phase % 2 === 0) state.x += state.dir;
  },
  clamp: (state, width) => {
    const span = Math.max(0, width - 3);
    if (state.x > span) {
      state.x = span;
      state.dir = -1;
    }
    if (state.x < 0) {
      state.x = 0;
      state.dir = 1;
    }
  },
  paint: (state, width) => {
    const body =
      state.dir > 0
        ? state.phase % 2 === 0
          ? "><>"
          : ">~>"
        : state.phase % 2 === 0
          ? "<><"
          : "<~<";
    return [paintRow(width, [{ at: state.x, text: body, color: "accent" }])];
  },
});

const duck = defineAnimation("duck", {
  createState: () => ({ x: 0, dir: 1, phase: 0 }),
  tick: (state) => {
    state.phase += 1;
    if (state.phase % 3 === 0) state.x += state.dir;
  },
  clamp: (state, width) => {
    const span = Math.max(0, width - 3);
    if (state.x > span) {
      state.x = span;
      state.dir = -1;
    }
    if (state.x < 0) {
      state.x = 0;
      state.dir = 1;
    }
  },
  paint: (state, width) => {
    const body = state.dir > 0 ? ",~>" : "<~,";
    return [
      paintRow(width, [{ at: state.x, text: body, color: "boat" }]),
      paintRow(width, [{ at: 0, text: "~".repeat(Math.max(0, width)), color: "water" }]),
    ];
  },
});

const clouds = defineAnimation("clouds", {
  createState: () => ({ offset: 0 }),
  tick: (state) => {
    state.offset += 1;
  },
  paint: (state, width) => {
    const x1 = (state.offset % Math.max(1, width + 8)) - 8;
    const x2 = ((state.offset * 2 + 20) % Math.max(1, width + 10)) - 10;
    return [
      paintRow(width, [
        { at: x1, text: ".-.", color: "bright" },
        { at: x2, text: ".-.", color: "dim" },
      ]),
      paintRow(width, [
        { at: x1, text: "(   )", color: "bright" },
        { at: x2, text: "(   )", color: "dim" },
      ]),
    ];
  },
});

const stars = defineAnimation("stars", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const top: Placement[] = [];
    const bottom: Placement[] = [];
    for (let column = 0; column < width; column += 1) {
      const h = hash(column * 31 + 7);
      if (h % 11 === 0) {
        const twinkle = (h + state.phase) % 4;
        top.push({
          at: column,
          text: twinkle === 0 ? "+" : twinkle === 1 ? "*" : "·",
          color: twinkle === 0 ? "bright" : "dim",
        });
      }
      const h2 = hash(column * 17 + 101);
      if (h2 % 13 === 0) {
        bottom.push({
          at: column,
          text: (h2 + state.phase) % 3 === 0 ? "*" : "·",
          color: "dim",
        });
      }
    }
    return [paintRow(width, top), paintRow(width, bottom)];
  },
});

const MOON_PHASES = ["◐", "◓", "◑", "◒"] as const;

const moon = defineAnimation("moon", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const glyph = MOON_PHASES[Math.floor(state.phase / 4) % MOON_PHASES.length];
    const at = centered(width, glyph);
    const field: Placement[] = [];
    for (let column = 0; column < width; column += 1) {
      if (column === at) continue;
      if (hash(column * 53 + 3) % 9 === 0) {
        field.push({ at: column, text: "·", color: "dim" });
      }
    }
    return [paintRow(width, [...field, { at, text: glyph, color: "bright" }])];
  },
});

const rain = defineAnimation("rain", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const top: Placement[] = [];
    const bottom: Placement[] = [];
    for (let column = 0; column < width; column += 1) {
      const h = hash(column * 41 + 11);
      if (h % 5 !== 0) continue;
      const falling = (h + state.phase) % 2;
      (falling === 0 ? top : bottom).push({
        at: column,
        text: falling === 0 ? "'" : "|",
        color: "water",
      });
    }
    return [paintRow(width, top), paintRow(width, bottom)];
  },
});

const snow = defineAnimation("snow", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const top: Placement[] = [];
    const bottom: Placement[] = [];
    for (let column = 0; column < width; column += 1) {
      const h = hash(column * 29 + 5);
      if (h % 6 !== 0) continue;
      const falling = (h + state.phase) % 2;
      (falling === 0 ? top : bottom).push({
        at: column,
        text: (h + state.phase) % 3 === 0 ? "*" : "·",
        color: "bright",
      });
    }
    return [paintRow(width, top), paintRow(width, bottom)];
  },
});

const ball = defineAnimation("ball", {
  createState: () => ({ x: 0, dir: 1, y: 0, vy: 0 }),
  tick: (state) => {
    state.x += state.dir;
    state.vy += 1;
    state.y += state.vy;
    if (state.y >= 1) {
      state.y = 1;
      state.vy = -2;
    }
    if (state.y < 0) {
      state.y = 0;
      state.vy = 0;
    }
  },
  clamp: (state, width) => {
    const span = Math.max(0, width - 1);
    if (state.x > span) {
      state.x = span;
      state.dir = -1;
    }
    if (state.x < 0) {
      state.x = 0;
      state.dir = 1;
    }
  },
  paint: (state, width) => {
    const ground = "_".repeat(Math.max(0, width));
    const top = paintRow(
      width,
      state.y === 0 ? [{ at: state.x, text: "●", color: "warm" }] : [],
    );
    const bottom = paintRow(width, [
      { at: 0, text: ground, color: "dim" },
      ...(state.y === 1 ? [{ at: state.x, text: "●", color: "warm" }] : []),
    ]);
    return [top, bottom];
  },
});

const pendulum = defineAnimation("pendulum", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const pivot = Math.floor(width / 2);
    const reach = Math.max(1, Math.min(10, Math.floor(width / 3)));
    const bob = pivot + Math.round(Math.sin(state.phase / 5) * reach);
    return [
      paintRow(width, [{ at: pivot, text: "·", color: "dim" }]),
      paintRow(width, [{ at: bob, text: "●", color: "accent" }]),
    ];
  },
});

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const spinner = defineAnimation("spinner", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const glyph = SPINNER_FRAMES[state.phase % SPINNER_FRAMES.length];
    return [paintRow(width, [{ at: centered(width, glyph), text: glyph, color: "accent" }])];
  },
});

const progress = defineAnimation("progress", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    if (width <= 0) return [];
    if (width < 4) {
      return [paintRow(width, [{ at: 0, text: "=".repeat(width), color: "green" }])];
    }
    const inner = width - 2;
    const head = state.phase % inner;
    const cells = Array.from({ length: inner }, (_, index) => (index < head ? "=" : " "));
    cells[head] = ">";
    return [paintRow(width, [{ at: 0, text: `[${cells.join("")}]`, color: "green" }])];
  },
});

const PULSE_FRAMES = ["·", "•", "●", "•"] as const;

const pulse = defineAnimation("pulse", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const glyph = PULSE_FRAMES[state.phase % PULSE_FRAMES.length];
    return [paintRow(width, [{ at: centered(width, glyph), text: glyph, color: "warm" }])];
  },
});

const WAVE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const wave = defineAnimation("wave", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    if (width <= 0) return [];
    const cells = Array.from({ length: width }, (_, column) => {
      const level = Math.round(
        ((Math.sin((column + state.phase) / 3) + 1) / 2) * (WAVE_BARS.length - 1),
      );
      return WAVE_BARS[level];
    });
    return [paintRow(width, [{ at: 0, text: cells.join(""), color: "water" }])];
  },
});

const rocket = defineAnimation("rocket", {
  createState: () => ({ x: 0, phase: 0 }),
  tick: (state) => {
    state.x += 1;
    state.phase += 1;
  },
  clamp: (state, width) => {
    if (state.x > Math.max(0, width - 1)) state.x = 0;
  },
  paint: (state, width) => {
    const flame = state.phase % 2 === 0 ? "~" : "^";
    return [
      paintRow(width, [{ at: state.x, text: "▲", color: "warm" }]),
      paintRow(width, [{ at: state.x, text: flame, color: "boat" }]),
    ];
  },
});

const balloon = defineAnimation("balloon", {
  createState: () => ({ x: 0, phase: 0 }),
  tick: (state) => {
    state.x += 1;
    state.phase += 1;
  },
  clamp: (state, width) => {
    if (state.x > Math.max(0, width - 1)) state.x = 0;
  },
  paint: (state, width) => {
    const string = state.phase % 2 === 0 ? "|" : "'";
    return [
      paintRow(width, [{ at: state.x, text: "o", color: "magenta" }]),
      paintRow(width, [{ at: state.x, text: string, color: "dim" }]),
    ];
  },
});

const butterfly = defineAnimation("butterfly", {
  createState: () => ({ x: 0, phase: 0 }),
  tick: (state) => {
    state.x += 1;
    state.phase += 1;
  },
  clamp: (state, width) => {
    if (state.x > Math.max(0, width - 3)) state.x = 0;
  },
  paint: (state, width) => {
    const wings = state.phase % 2 === 0 ? "><" : "()";
    return [
      paintRow(width, [{ at: state.x, text: `${wings[0]}·${wings[1]}`, color: "magenta" }]),
    ];
  },
});

const cat = defineAnimation("cat", {
  createState: () => ({ x: 0, phase: 0 }),
  tick: (state) => {
    state.x += 1;
    state.phase += 1;
  },
  clamp: (state, width) => {
    if (state.x > Math.max(0, width - 7)) state.x = 0;
  },
  paint: (state, width) => {
    const tail = state.phase % 2 === 0 ? "~" : "-";
    return [paintRow(width, [{ at: state.x, text: `=^..^=${tail}`, color: "boat" }])];
  },
});

const coffee = defineAnimation("coffee", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const cup = "|_|";
    const at = centered(width, cup);
    const steam = state.phase % 3 === 0 ? "~" : state.phase % 3 === 1 ? "'" : "~";
    return [
      paintRow(width, [{ at: at + 1, text: steam, color: "dim" }]),
      paintRow(width, [{ at, text: cup, color: "boat" }]),
    ];
  },
});

const windmill = defineAnimation("windmill", {
  createState: () => ({ phase: 0 }),
  tick: (state) => {
    state.phase += 1;
  },
  paint: (state, width) => {
    const at = centered(width, "●");
    const phase = state.phase % 4;
    const top = phase === 0 ? "|" : phase === 1 ? "/" : phase === 2 ? "-" : "\\";
    const bottom = phase === 0 ? "|" : phase === 1 ? "\\" : phase === 2 ? "-" : "/";
    return [
      paintRow(width, [{ at, text: top, color: "accent" }]),
      paintRow(width, [{ at, text: "●", color: "boat" }]),
      paintRow(width, [{ at, text: bottom, color: "accent" }]),
    ];
  },
});

/** Every scene Calm can show, in a stable order. */
export const CALM_ANIMATIONS: readonly CalmAnimationDefinition[] = [
  sailboat,
  fish,
  duck,
  clouds,
  stars,
  moon,
  rain,
  snow,
  ball,
  pendulum,
  spinner,
  progress,
  pulse,
  wave,
  rocket,
  balloon,
  butterfly,
  cat,
  coffee,
  windmill,
];

/** The scene names, in the same order as CALM_ANIMATIONS. */
export const CALM_ANIMATION_NAMES: readonly string[] = CALM_ANIMATIONS.map(
  (animation) => animation.name,
);

/** Build the scene at `index`, wrapping out-of-range indexes. */
export function createCalmAnimationSprite(index: number): CalmAnimationSprite {
  const count = CALM_ANIMATIONS.length;
  const normalized = ((Math.trunc(index) % count) + count) % count;
  return CALM_ANIMATIONS[normalized].create();
}

/** Build one scene chosen uniformly at random. */
export function createRandomCalmAnimationSprite(): CalmAnimationSprite {
  return createCalmAnimationSprite(Math.floor(Math.random() * CALM_ANIMATIONS.length));
}