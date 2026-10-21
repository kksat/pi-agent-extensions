/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import assert from "node:assert/strict";
import { Terminal } from "@xterm/headless";
import { PassthroughScreen } from "./passthrough-screen.ts";

function cells(term: Terminal) {
	const buf = term.buffer.active;
	return Array.from({ length: term.rows }, (_, y) => {
		const line = buf.getLine(buf.baseY + y)!;
		return Array.from({ length: term.cols }, (_, x) => {
			const c = line.getCell(x)!;
			// The foreground/style of an erased blank cell is not visible, unless
			// it has a decoration or inverse video. Compare the visible result.
			const decorated = c.getChars().trim() || c.isUnderline() || c.isInverse() || c.isStrikethrough();
			return [c.getChars() || " ", c.getWidth(), c.getBgColorMode(), c.getBgColor(),
				...(decorated ? [c.getFgColorMode(), c.getFgColor(), !!c.isBold(), !!c.isDim(), !!c.isItalic(), !!c.isUnderline(), !!c.isInverse()] : [])];
		});
	});
}

async function write(term: Terminal, data: string) {
	await new Promise<void>((resolve) => term.write(data, resolve));
}

function observeExtraModes(term: Terminal) {
	const modes = new Map([[25, true], [1005, false], [1006, false], [1015, false], [1016, false]]);
	for (const final of ["h", "l"]) {
		term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
			for (const mode of params) {
				if (typeof mode === "number" && modes.has(mode)) modes.set(mode, final === "h");
			}
			return false;
		});
	}
	return modes;
}

async function roundTrip(name: string, input: string, incremental: string) {
	const term = new Terminal({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true });
	const host = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
	const screen = new PassthroughScreen(term);
	const sourceExtraModes = observeExtraModes(term);
	const hostExtraModes = observeExtraModes(host);
	try {
		await write(host, "Pi transcript must survive");
		// No sleep: restoring must wait for xterm's pending parser work.
		term.write(input);
		await screen.flush();
		await write(host, screen.serialize());
		assert.deepEqual(cells(host), cells(term), `${name}: screen/style`);
		assert.deepEqual(host.modes, term.modes, `${name}: modes`);
		assert.deepEqual(hostExtraModes, sourceExtraModes, `${name}: cursor visibility and mouse encoding`);
		assert.equal(host.options.cursorStyle, term.options.cursorStyle, `${name}: cursor style`);
		assert.equal(host.options.cursorBlink, term.options.cursorBlink, `${name}: cursor blinking`);
		assert.equal(host.buffer.active.cursorX, term.buffer.active.cursorX, `${name}: cursor column`);
		assert.equal(host.buffer.active.cursorY, term.buffer.active.cursorY, `${name}: cursor row`);
		await write(term, incremental);
		await write(host, incremental);
		assert.deepEqual(cells(host), cells(term), `${name}: subsequent incremental output`);
		await write(host, "\x1b[?1049l");
		assert.equal(host.buffer.active.getLine(0)?.translateToString(true), "Pi transcript must survive", `${name}: normal buffer preserved`);
		console.log(`PASS: ${name}`);
	} finally {
		term.dispose();
		host.dispose();
	}
}

await roundTrip("alternate screen, style transitions, wide characters and current SGR",
	"\x1b[?1049h\x1b[1;31;44mbold\x1b[22;39;49m plain\x1b[3;38;2;12;34;56m italic\x1b[23m normal\r\n中文\x1b[48;2;44;55;66m\x1b[K\x1b[2;4;32m",
	" next\x1b[0m plain");
await roundTrip("background-only rows at the bottom of the screen",
	"\x1b[?1049h\x1b[48;2;17;34;51m\x1b[2J", "");
await roundTrip("normal buffer uses the current viewport, not old scrollback",
	Array.from({ length: 20 }, (_, n) => `line ${n}\r\n`).join(""), "new bottom line");
await roundTrip("application keys, bracketed paste, mouse tracking and cursor style",
	"\x1b[?1049h\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[6 q\x1b[?25l\x1b[3;4Hscreen",
	" continuation");
await roundTrip("scrolling regions survive subsequent scrolling",
	"\x1b[?1049h\x1b[1;1Houtside top\x1b[8;1Houtside bottom\x1b[2;7r\x1b[7;1Hregion bottom", "\r\nscroll inside region");
await roundTrip("origin mode with a scrolling region",
	"\x1b[?1049h\x1b[2;7r\x1b[?6h\x1b[2;3Hrelative", " continued");

const term = new Terminal({ allowProposedApi: true });
const screen = new PassthroughScreen(term);
const pending = screen.flush();
term.dispose();
await pending;
console.log("PASS: disposal releases pending restoration");
