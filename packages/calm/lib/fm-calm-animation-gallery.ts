/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// A numbered, harness-neutral preview of the real catalogue. Keeping the gallery
// in the same frame/run format lets it reuse Calm's ANSI renderer and single
// disposable 220 ms widget timer without touching the working scene's state.
import {
  CALM_ANIMATIONS,
  type CalmAnimationColor,
  type CalmAnimationFrame,
  type CalmAnimationRun,
  type CalmAnimationSprite,
} from "./fm-calm-animations.ts";

export const CALM_ANIMATION_GALLERY_WIDGET_KEY = "firstmate-calm-animation-gallery";
const MIN_CELL_WIDTH = 16;
const MAX_COLUMNS = 5;
const GUTTER = " | ";

function galleryLayout(width: number, count: number, fullWidth: boolean): { columns: number; cellWidth: number } {
  const columns = Math.min(
    fullWidth ? 1 : MAX_COLUMNS,
    count,
    Math.max(1, Math.floor((width + GUTTER.length) / (MIN_CELL_WIDTH + GUTTER.length))),
  );
  return { columns, cellWidth: Math.max(0, Math.floor((width - (columns - 1) * GUTTER.length) / columns)) };
}

// Frame runs contain only single-column glyphs, never ANSI escapes (the same
// invariant as the catalogue's paintRow). Labels and hints are ASCII only.
function textRow(width: number, text: string, color: CalmAnimationColor): CalmAnimationRun[] {
  return [{ text: text.slice(0, width).padEnd(width), color }];
}

function padRow(row: readonly CalmAnimationRun[], width: number): CalmAnimationRun[] {
  const cells = row.reduce((count, run) => count + Array.from(run.text).length, 0);
  return [...row, { text: " ".repeat(Math.max(0, width - cells)), color: "plain" }];
}

/** Preview selected scenes without renumbering; single-scene previews use the full track. */
export function createCalmAnimationGallery(options: {
  numbers?: readonly number[];
  fullWidth?: boolean;
} = {}): CalmAnimationSprite {
  const numbers = [...(options.numbers ?? CALM_ANIMATIONS.map((_, index) => index + 1))];
  if (numbers.length === 0 || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > CALM_ANIMATIONS.length)) {
    throw new RangeError("Preview needs at least one valid catalogue number.");
  }
  const scenes = numbers.map((number) => CALM_ANIMATIONS[number - 1].create());
  const fullWidth = options.fullWidth === true;
  const title = `Calm: ${numbers.length === CALM_ANIMATIONS.length ? "all" : "selected"} ${numbers.length} animations (live)`;
  return {
    name: "gallery",
    frame(width: number): CalmAnimationFrame {
      if (width <= 0) {
        // Keep resize/clamp snapshots identical to directly rendering the scene,
        // even when there is no visible track (e.g. a temporarily hidden pane).
        for (const scene of scenes) scene.frame(0);
        return [];
      }
      const { columns, cellWidth } = galleryLayout(width, scenes.length, fullWidth);
      const rows: CalmAnimationRun[][] = scenes.length === 1 ? [] : [textRow(width, title, "bright")];

      for (let start = 0; start < scenes.length; start += columns) {
        const cells = scenes.slice(start, start + columns).map((scene, offset) => [
          textRow(cellWidth, `[${String(numbers[start + offset]).padStart(2, "0")}] ${scene.name}`, "accent"),
          ...scene.frame(cellWidth).map((row) => padRow(row, cellWidth)),
        ]);
        const height = Math.max(...cells.map((cell) => cell.length));
        for (let line = 0; line < height; line += 1) {
          const row: CalmAnimationRun[] = [];
          for (let column = 0; column < columns; column += 1) {
            if (column > 0) row.push({ text: GUTTER, color: "dim" });
            row.push(...(cells[column]?.[line] ?? textRow(cellWidth, "", "plain")));
          }
          rows.push(padRow(row, width));
        }
      }
      rows.push(textRow(width, "/calm-preview N: full width | /calm-preview off: hide", "dim"));
      return rows;
    },
    tick: () => { for (const scene of scenes) scene.tick(); },
    restoreLastRendered: () => { for (const scene of scenes) scene.restoreLastRendered(); },
    reset: () => { for (const scene of scenes) scene.reset(); },
    clampToWidth: (width) => {
      // Each scene is clamped to its cell's width by frame(), including on resize.
      // Do not clamp to the full gallery width here: it would change bounce state.
      const { cellWidth } = galleryLayout(width, scenes.length, fullWidth);
      for (const scene of scenes) scene.clampToWidth(cellWidth);
    },
  };
}
