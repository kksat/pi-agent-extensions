/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Requires the package's Pi peer dependencies.
//   node --experimental-strip-types packages/worktree/command-menu.test.ts

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { WorktreeCommandMenu } from "./command-menu.ts";

initTheme("dark", false);
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function fixture(t: TestContext, bindings: KeybindingsConfig = {}) {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
	setKeybindings(keybindings);
	t.after(() => setKeybindings(previous));
	const selected: string[] = [];
	let cancelled = 0;
	let renders = 0;
	const menu = new WorktreeCommandMenu({
		theme,
		keybindings,
		onSelect: (command) => { selected.push(command); },
		onCancel: () => { cancelled++; },
		requestRender: () => { renders++; },
		maxVisible: 10,
	});
	menu.focused = true;
	return { menu, selected, cancelled: () => cancelled, renders: () => renders };
}

const up = "\x1b[A";
const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";
const backspace = "\x7f";
const clear = "\x15";

function text(menu: WorktreeCommandMenu): string {
	return menu.render(100).join("\n");
}

test("blank menu shows every command and still supports selection without typing", (t) => {
	const f = fixture(t);
	for (const label of ["Create", "List", "Browse sessions", "Switch", "Rebase", "Create PR", "Rename", "Remove", "Clean", "Help"]) {
		assert.ok(text(f.menu).includes(label), label);
	}
	f.menu.handleInput(down);
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["list"]);
});

test("typing fuzzy nonconsecutive characters filters and selects rebase", (t) => {
	const f = fixture(t);
	for (const letter of "rbs") f.menu.handleInput(letter);
	assert.ok(text(f.menu).includes("Rebase"));
	assert.ok(!text(f.menu).includes("Create"));
	assert.ok(!text(f.menu).includes("Remove"));
	assert.ok(text(f.menu).includes("Search: rbs"));
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["rebase"]);
	assert.equal(f.renders(), 4);
});

test("search is case-insensitive and matches descriptive words", (t) => {
	const f = fixture(t);
	f.menu.handleInput("BROWSE");
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["sessions"]);
});

test("complete command names select the correct action", (t) => {
	const f = fixture(t);
	for (const command of ["create", "list", "sessions", "switch", "rebase", "pr", "rename", "remove", "clean", "help"]) {
		f.menu.handleInput(clear);
		f.menu.handleInput(command);
		f.menu.handleInput(enter);
		assert.equal(f.selected.at(-1), command);
	}
});

test("query changes reset the highlight to the best fuzzy match", (t) => {
	const f = fixture(t);
	f.menu.handleInput(down);
	f.menu.handleInput(down);
	f.menu.handleInput("rebase");
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["rebase"]);
});

test("backspace and clearing the query restore commands", (t) => {
	const f = fixture(t);
	f.menu.handleInput("helpx");
	assert.ok(text(f.menu).includes("No matching commands"));
	f.menu.handleInput(backspace);
	assert.ok(text(f.menu).includes("Help"));
	f.menu.handleInput(clear);
	assert.ok(text(f.menu).includes("Create"));
	assert.ok(text(f.menu).includes("Rebase"));
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["create"]);
});

test("no matches cannot execute a command and typing can recover", (t) => {
	const f = fixture(t);
	f.menu.handleInput("zzzzzz");
	f.menu.handleInput(down);
	f.menu.handleInput(up);
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, []);
	assert.ok(text(f.menu).includes("No matching commands"));
	f.menu.handleInput(clear);
	f.menu.handleInput("list");
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["list"]);
});

test("Escape and Ctrl+C cancel even when no commands match", (t) => {
	const f = fixture(t);
	f.menu.handleInput("zzzzzz");
	f.menu.handleInput(escape);
	assert.equal(f.cancelled(), 1);
	assert.deepEqual(f.selected, []);
	f.menu.handleInput("\x03");
	assert.equal(f.cancelled(), 2);
	assert.deepEqual(f.selected, []);
});

test("selection wraps in both directions", (t) => {
	const f = fixture(t);
	f.menu.handleInput(up);
	f.menu.handleInput(enter);
	f.menu.handleInput(down);
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["help", "create"]);
});

test("configured navigation, confirmation, and cancellation bindings work", (t) => {
	const f = fixture(t, {
		"tui.select.down": "ctrl+n",
		"tui.select.confirm": "ctrl+o",
		"tui.select.cancel": "ctrl+x",
	});
	f.menu.handleInput("\x0e");
	f.menu.handleInput("\x0f");
	assert.deepEqual(f.selected, ["list"]);
	f.menu.handleInput("\x18");
	assert.equal(f.cancelled(), 1);
});

test("page navigation stays within the command list", (t) => {
	const f = fixture(t);
	f.menu.handleInput("\x1b[6~");
	f.menu.handleInput(enter);
	f.menu.handleInput("\x1b[5~");
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["help", "create"]);
});

test("bracketed paste updates the query without executing it", (t) => {
	const f = fixture(t);
	f.menu.handleInput("\x1b[200~rebase\x1b[201~");
	assert.deepEqual(f.selected, []);
	assert.ok(text(f.menu).includes("Search: rebase"));
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["rebase"]);
});

test("chunked bracketed paste cannot confirm on a pasted newline", (t) => {
	const f = fixture(t);
	for (const chunk of ["\x1b[200~", "re", "\r", "base", "\x1b[201~"]) f.menu.handleInput(chunk);
	assert.deepEqual(f.selected, []);
	assert.equal(f.cancelled(), 0);
	assert.ok(text(f.menu).includes("Rebase"));
	f.menu.handleInput(enter);
	assert.deepEqual(f.selected, ["rebase"]);
});

test("Enter arriving after a paste in the same event selects the new match", (t) => {
	const f = fixture(t);
	f.menu.handleInput("\x1b[200~rebase\x1b[201~\r");
	assert.deepEqual(f.selected, ["rebase"]);
});

test("focus is forwarded to the input and survives filtering", (t) => {
	const f = fixture(t);
	assert.equal(f.menu.focused, true);
	assert.ok(text(f.menu).includes(CURSOR_MARKER));
	f.menu.handleInput("rbs");
	assert.ok(text(f.menu).includes(CURSOR_MARKER));
	f.menu.focused = false;
	assert.ok(!text(f.menu).includes(CURSOR_MARKER));
});

test("rendered lines fit narrow widths before and after search and invalidation", (t) => {
	const f = fixture(t);
	for (const width of [1, 8, 20, 40, 80]) {
		for (const line of f.menu.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
	f.menu.handleInput("unknown");
	f.menu.invalidate();
	for (const width of [1, 8, 20, 40, 80]) {
		for (const line of f.menu.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
});
