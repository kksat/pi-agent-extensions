/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";

// A snapshot must restore the current SGR attributes as well as the cells:
// subsequent PTY output is incremental and assumes those attributes still hold.
// The serializer handles both; the parser hooks cover state it doesn't serialize.
export class PassthroughScreen {
	private readonly serializer = new SerializeAddon();
	private readonly mouseEncodings = new Map([[1005, false], [1006, false], [1015, false], [1016, false]]);
	private cursorVisible = true;
	private scrollTop = 1;
	private scrollBottom = 0;
	private readonly pendingFlushes = new Set<() => void>();

	constructor(private readonly term: Terminal) {
		const disposables = [
			...(["h", "l"] as const).map((final) => term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				for (const mode of params) {
					if (mode === 25) this.cursorVisible = final === "h";
					if (typeof mode === "number" && this.mouseEncodings.has(mode)) {
						this.mouseEncodings.set(mode, final === "h");
					}
				}
				return false;
			})),
			term.parser.registerCsiHandler({ final: "r" }, (params) => {
				const top = Number(params[0]) || 1;
				const bottom = Number(params[1]) || term.rows;
				if (top < bottom && bottom <= term.rows) {
					this.scrollTop = top;
					this.scrollBottom = bottom;
				}
				return false;
			}),
			term.onResize(() => { this.scrollTop = 1; this.scrollBottom = 0; }),
		];
		term.loadAddon({
			// xterm's serializer also supports headless terminals, but its declaration
			// uses the browser Terminal type, which has additional DOM methods.
			activate: () => this.serializer.activate(term as unknown as Parameters<SerializeAddon["activate"]>[0]),
			dispose: () => {
				for (const disposable of disposables) disposable.dispose();
				this.serializer.dispose();
				// Disposing xterm cancels queued writes, including their callbacks.
				for (const resolve of this.pendingFlushes) resolve();
				this.pendingFlushes.clear();
			},
		});
	}

	flush(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.pendingFlushes.add(resolve);
			this.term.write("", () => {
				this.pendingFlushes.delete(resolve);
				resolve();
			});
		});
	}

	private serializeBlankBackgrounds(): string {
		// The serializer trims trailing erased rows if their style hasn't
		// changed. ECH restores those colored blanks without introducing text
		// or scrolling. Save/restore the current SGR for future live output.
		const buffer = this.term.buffer.active;
		let result = "";
		for (let y = 0; y < this.term.rows; y++) {
			const line = buffer.getLine(buffer.baseY + y);
			if (!line) continue;
			for (let x = 0; x < this.term.cols; x++) {
				const cell = line.getCell(x)!;
				if (cell.getChars() || cell.getWidth() === 0 || cell.isBgDefault()) continue;
				let end = x + 1;
				while (end < this.term.cols) {
					const next = line.getCell(end)!;
					if (next.getChars() || next.getWidth() === 0 || next.getBgColorMode() !== cell.getBgColorMode() || next.getBgColor() !== cell.getBgColor()) break;
					end++;
				}
				const color = cell.getBgColor();
				const bg = cell.isBgRGB()
					? `48;2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`
					: `48;5;${color}`;
				result += `\x1b[${y + 1};${x + 1}H\x1b[0;${bg}m\x1b[${end - x}X`;
				x = end - 1;
			}
		}
		return result ? `\x1b7\x1b[?6l${result}\x1b8` : "";
	}

	serialize(): string {
		// Never paint a saved normal buffer over Pi's transcript. Start a clean
		// alternate screen with known defaults before replaying the snapshot.
		const defaults = "\x1b[?1049h\x1b[0m\x1b[?1l\x1b[?66l\x1b[?2004l\x1b[4l\x1b[?6l\x1b[?7h\x1b[?45l\x1b[?1004l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[r\x1b[2J\x1b[H";
		// The serializer restores current SGR after the normal buffer, then
		// assumes default SGR at the start of the alternate buffer. Reset at
		// that boundary so current dim/underline/etc. don't taint its cells.
		const content = this.serializer.serialize({ scrollback: 0 })
			.replace("\x1b[?1049h\x1b[H", "\x1b[?1049h\x1b[H\x1b[0m");
		const mouse = [...this.mouseEncodings].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? "h" : "l"}`).join("");
		const shape = { block: 2, underline: 4, bar: 6 }[this.term.options.cursorStyle || "block"];
		const cursorStyle = `\x1b[${shape - (this.term.options.cursorBlink ? 1 : 0)} q`;
		const buffer = this.term.buffer.active;
		// Changing margins/origin moves the cursor, so restore its position last.
		const margins = `\x1b[?6l\x1b[${this.scrollTop};${this.scrollBottom || this.term.rows}r`;
		const origin = this.term.modes.originMode;
		const row = buffer.cursorY + 1 - (origin ? this.scrollTop - 1 : 0);
		return defaults + content + this.serializeBlankBackgrounds() + mouse + cursorStyle + margins +
			(origin ? "\x1b[?6h" : "") + `\x1b[${row};${buffer.cursorX + 1}H` +
			`\x1b[?25${this.cursorVisible ? "h" : "l"}`;
	}
}
