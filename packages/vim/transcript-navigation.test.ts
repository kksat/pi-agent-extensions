/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, UserMessageComponent, initTheme, type KeybindingsManager as EditorKeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	Container, Input, KeybindingsManager, ScrollView, Spacer, Text, TuiAltScreen, VStack,
	type Component, type Terminal,
} from "@earendil-works/pi-tui";
import { VimEditor, type VimMode } from "./index.ts";

initTheme("dark", false);

class TestTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void) { this.onInput = onInput; }
	stop() {}
	async drainInput() {}
	write() {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
}

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

function answer(text: string, toolCall = false): AssistantMessageComponent {
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text }],
		api: "openai-responses", provider: "openai", model: "test", timestamp: 0,
		stopReason: toolCall ? "toolUse" : "stop",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	if (toolCall) message.content.push({ type: "toolCall", id: "tool", name: "bash", arguments: {} });
	return new AssistantMessageComponent(message, true);
}

function fixture(t: { after(fn: () => void): void }, spacing = 12, tail = 30) {
	const terminal = new TestTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	// The editor only needs matches/getKeys, not Pi's config-file reload methods.
	const editor = new VimEditor(tui, editorTheme, new KeybindingsManager({}) as EditorKeybindingsManager);
	editor.mode = "normal";
	editor.setText("draft prompt");
	const chat = new Container();
	const document = new Container();
	document.addChild(new Text("session header", 0, 0));
	document.addChild(chat);
	const questions: UserMessageComponent[] = [];
	const answers: AssistantMessageComponent[] = [];
	for (let index = 0; index < 4; index++) {
		questions.push(new UserMessageComponent(`Question ${index}: ${"wide 界 emoji 🦊 ".repeat(8)}`));
		answers.push(answer(`Answer ${index}: ${"wrapped content ".repeat(12)}`));
		chat.addChild(questions[index]!);
		chat.addChild(answer("working narration", true));
		chat.addChild(new Text("tool result, not a question or answer", 0, 0));
		chat.addChild(answers[index]!);
		chat.addChild(new Spacer(spacing));
	}
	chat.addChild(new Spacer(tail));
	const scrollView = new ScrollView(document, { primary: true, follow: "end", scrollbar: "always" });
	tui.setLayoutRoot(new VStack([
		{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
		{ component: editor },
	]));
	tui.setFocus(editor);
	tui.start();
	t.after(() => tui.stop());
	tui.renderNow();
	const jumpedRows: number[] = [];
	const scrollTo = scrollView.scrollTo.bind(scrollView);
	scrollView.scrollTo = (row, options) => {
		jumpedRows.push(row);
		scrollTo(row, options);
	};
	const rowOf = (component: Component): number => {
		const width = scrollView.getContentWidth(terminal.columns);
		let row = document.children[0]!.render(width).length;
		for (const child of chat.children) {
			if (child === component) return row;
			row += child.render(width).length;
		}
		throw new Error("Message is not mounted");
	};
	const send = (...keys: string[]) => {
		for (const key of keys) {
			terminal.onInput(key);
			tui.renderNow();
		}
	};
	const at = (row: number) => {
		scrollView.scrollTo(row, { disableFollow: true });
		tui.renderNow();
		jumpedRows.length = 0;
	};
	return { terminal, tui, editor, chat, questions, answers, scrollView, jumpedRows, rowOf, send, at };
}

test("j/k scroll by lines and u/d by half-pages without editing the draft", (t) => {
	const f = fixture(t);
	f.editor.setText("one\ntwo\nthree");
	f.editor.setCursorPosition({ line: 1, col: 1 });
	f.tui.renderNow();
	const start = f.rowOf(f.answers[1]!);
	f.at(start);
	const halfPage = Math.max(1, Math.floor(f.scrollView.viewportHeight / 2));
	f.send("j");
	assert.equal(f.scrollView.scrollTop, start + 1);
	f.send("k");
	assert.equal(f.scrollView.scrollTop, start);
	f.send("d");
	assert.equal(f.scrollView.scrollTop, start + halfPage);
	f.send("d");
	assert.equal(f.scrollView.scrollTop, start + 2 * halfPage);
	f.send("u", "u");
	assert.equal(f.scrollView.scrollTop, start);
	assert.equal(f.editor.getText(), "one\ntwo\nthree");
	assert.deepEqual(f.editor.getCursorPosition(), { line: 1, col: 1 });
	assert.equal(f.editor.operator, null);
	assert.equal(f.editor.pendingKeys, "");
	assert.equal(f.editor.mode, "normal");
});

test("scroll counts reset and half-pages track resized transcript height", (t) => {
	const f = fixture(t);
	const start = f.rowOf(f.answers[1]!);
	f.at(start);
	f.send("3", "j");
	assert.equal(f.scrollView.scrollTop, start + 3);
	f.send("2", "k");
	assert.equal(f.scrollView.scrollTop, start + 1);
	assert.equal(f.editor.countStr, "");
	f.terminal.rows = 14;
	f.tui.renderNow();
	const halfPage = Math.max(1, Math.floor(f.scrollView.viewportHeight / 2));
	f.send("2", "d");
	assert.equal(f.scrollView.scrollTop, start + 1 + 2 * halfPage);
	f.send("u");
	assert.equal(f.scrollView.scrollTop, start + 1 + halfPage);
	assert.equal(f.editor.countStr, "");
});

test("scrolling clamps to boundaries and resumes following output at the end", (t) => {
	const f = fixture(t);
	const bottom = f.scrollView.scrollTop;
	f.at(0);
	f.send("k", "u");
	assert.equal(f.scrollView.scrollTop, 0);
	f.send("9", "9", "9", "d");
	assert.equal(f.scrollView.scrollTop, bottom);
	assert.equal(f.scrollView.isFollowingEnd, true);
	f.send("u");
	assert(f.scrollView.scrollTop < bottom);
	assert.equal(f.scrollView.isFollowingEnd, false);
	const top = f.scrollView.scrollTop;
	f.chat.addChild(new Spacer(10));
	f.tui.renderNow();
	assert.equal(f.scrollView.scrollTop, top);
});

test("scrolling clears a clamped question/answer jump anchor", (t) => {
	const f = fixture(t, 0, 0);
	f.at(0);
	f.send("9", "]", "a");
	const clampedTop = f.scrollView.scrollTop;
	assert(clampedTop < f.rowOf(f.answers[3]!));
	f.send("j"); // Already at the bottom, but still exits message-jump navigation.
	f.send("[", "q");
	const expected = f.questions.map(f.rowOf).filter((row) => row < clampedTop).at(-1);
	assert.equal(f.jumpedRows.at(-1), expected);
});

test("explicit-register deletion, operator j/k motions, and U undo still edit the draft", (t) => {
	const f = fixture(t);
	const start = f.rowOf(f.answers[1]!);
	f.at(start);
	f.editor.setText("one two\nthree\nfour");
	f.editor.setCursorPosition({ line: 0, col: 0 });
	f.send('"', '"', "d", "w");
	assert.equal(f.editor.getText(), "two\nthree\nfour");
	f.send("u");
	assert.equal(f.editor.getText(), "two\nthree\nfour");
	f.send("d", "U");
	assert.equal(f.editor.getText(), "one two\nthree\nfour");
	f.send("\x12");
	assert.equal(f.editor.getText(), "two\nthree\nfour");
	f.send("U");
	f.send('"', '"', "d", "j");
	assert.equal(f.editor.getText(), "four");
	f.send("U");
	f.send('"', "a", "d", "d");
	assert.equal(f.editor.getText(), "three\nfour");
	f.send("U");
	f.editor.setCursorPosition({ line: 1, col: 0 });
	f.send("y", "k");
	assert.equal(f.editor.registers.get('"')?.text, "one two\nthree\n");
	assert.equal(f.scrollView.scrollTop, start);
	assert.equal(f.editor.operator, null);
});

test("Kitty-encoded scrolling keys and macros use the same scrolling path", (t) => {
	const f = fixture(t);
	const start = f.rowOf(f.answers[1]!);
	f.at(start);
	f.send("\x1b[106u");
	assert.equal(f.scrollView.scrollTop, start + 1);
	f.send("\x1b[107u");
	assert.equal(f.scrollView.scrollTop, start);
	const halfPage = Math.max(1, Math.floor(f.scrollView.viewportHeight / 2));
	f.send("\x1b[100u");
	assert.equal(f.scrollView.scrollTop, start + halfPage);
	f.send("\x1b[117u");
	assert.equal(f.scrollView.scrollTop, start);
	f.send("q", "b", "d", "q", "@", "b");
	assert.equal(f.scrollView.scrollTop, start + 2 * halfPage);
	assert.equal(f.editor.getText(), "draft prompt");
});

test("scrolling is safe for empty conversations and one-row viewports", (t) => {
	const f = fixture(t);
	f.chat.clear();
	f.editor.setText("");
	f.tui.renderNow();
	f.send("j", "k", "u", "d");
	assert.equal(f.scrollView.scrollTop, 0);
	f.chat.addChild(new Spacer(20));
	f.terminal.rows = 4;
	f.tui.renderNow();
	assert.equal(f.scrollView.viewportHeight, 1);
	f.at(0);
	f.send("d");
	assert.equal(f.scrollView.scrollTop, 1);
	f.send("u");
	assert.equal(f.scrollView.scrollTop, 0);
});

test("gg and G jump to conversation boundaries without moving the draft cursor", (t) => {
	const f = fixture(t);
	const bottom = f.scrollView.scrollTop;
	f.at(f.rowOf(f.answers[1]!));
	const cursor = f.editor.getCursorPosition();
	f.send("g");
	assert.equal(f.editor.pendingKeys, "g");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[1]!));
	f.send("g");
	assert.equal(f.scrollView.scrollTop, 0);
	assert.equal(f.scrollView.isFollowingEnd, false);
	f.send("G");
	assert.equal(f.scrollView.scrollTop, bottom);
	assert.equal(f.scrollView.isFollowingEnd, true);
	assert.equal(f.editor.getText(), "draft prompt");
	assert.deepEqual(f.editor.getCursorPosition(), cursor);
	assert.equal(f.editor.mode, "normal");
	assert.equal(f.editor.pendingKeys, "");

	// G follows streamed output; gg clears any role-jump anchor.
	f.chat.addChild(new Spacer(10));
	f.tui.renderNow();
	assert.equal(f.scrollView.scrollTop, bottom + 10);
	f.send("[", "a", "g", "g", "]", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[0]!));
});

test("gg and G handle empty conversations and cancelled g prefixes", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[1]!));
	f.send("g", "\x1b");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[1]!));
	assert.equal(f.editor.pendingKeys, "");
	f.chat.clear();
	f.tui.renderNow();
	f.send("g", "g", "G");
	assert.equal(f.scrollView.scrollTop, 0);
	assert.equal(f.editor.getText(), "draft prompt");
});

test("counted gg/G and operator motions still address draft lines", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[1]!));
	const top = f.scrollView.scrollTop;
	f.editor.setText("one\n two\nthree");
	f.editor.setCursorPosition({ line: 2, col: 0 });
	f.send("2", "g", "g");
	assert.deepEqual(f.editor.getCursorPosition(), { line: 1, col: 1 });
	f.editor.setCursorPosition({ line: 0, col: 0 });
	f.send("2", "G");
	assert.deepEqual(f.editor.getCursorPosition(), { line: 1, col: 1 });
	f.send('"', '"', "d", "g", "g");
	assert.equal(f.editor.getText(), "three");
	f.editor.setText("one\n two\nthree");
	f.editor.setCursorPosition({ line: 1, col: 0 });
	f.send('"', '"', "d", "G");
	assert.equal(f.editor.getText(), "one");
	assert.equal(f.scrollView.scrollTop, top);
	assert.equal(f.scrollView.isFollowingEnd, false);
	assert.equal(f.editor.operator, null);
	assert.equal(f.editor.countStr, "");
});

test("Kitty-encoded gg and G navigate conversation boundaries", (t) => {
	const f = fixture(t);
	const bottom = f.scrollView.scrollTop;
	f.at(f.rowOf(f.answers[1]!));
	f.send("\x1b[103u", "\x1b[103u");
	assert.equal(f.scrollView.scrollTop, 0);
	f.send("\x1b[103;2u");
	assert.equal(f.scrollView.scrollTop, bottom);
	assert.equal(f.scrollView.isFollowingEnd, true);
});

test("all four normal-mode bindings jump by role without changing the draft or mode", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[1]!));
	const cursor = f.editor.getCursorPosition();
	f.send("[", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[1]!));
	f.send("[", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[0]!));
	f.send("]", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[1]!));
	f.send("]", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[1]!));
	assert.equal(f.editor.getText(), "draft prompt");
	assert.deepEqual(f.editor.getCursorPosition(), cursor);
	assert.equal(f.editor.mode, "normal");
	assert.equal(f.editor.recordingMacroReg, null);
	assert.equal(f.editor.pendingKeys, "");
});

test("repeated jumps, counts, and boundaries skip tool narration and results", (t) => {
	const f = fixture(t);
	f.at(0);
	f.send("[", "q");
	assert.deepEqual(f.jumpedRows, []);
	f.send("2", "]", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[1]!));
	f.send("[", "a", "[", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[0]!));
	f.send("9", "]", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[3]!));
	const before = f.jumpedRows.length;
	f.send("]", "q");
	assert.equal(f.jumpedRows.length, before);
	assert.equal(f.editor.countStr, "");
});

test("clamped message starts near the transcript end still advance and reverse", (t) => {
	const f = fixture(t, 0, 0);
	f.at(0);
	f.send("]", "a", "]", "a", "]", "a", "]", "a");
	assert.deepEqual(f.jumpedRows, f.answers.map(f.rowOf));
	assert(f.scrollView.scrollTop < f.rowOf(f.answers[3]!));
	assert.equal(f.scrollView.isFollowingEnd, false);
	f.send("[", "a", "[", "a");
	assert.deepEqual(f.jumpedRows.slice(-2), [f.rowOf(f.answers[2]!), f.rowOf(f.answers[1]!)]);
});

test("manual scrolling, wrapping, resize, and replaced transcript rows use fresh positions", (t) => {
	const f = fixture(t);
	f.at(0);
	f.send("]", "a");
	f.terminal.columns = 36;
	f.tui.renderNow();
	f.at(f.rowOf(f.questions[2]!) + 1);
	f.send("[", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[2]!));
	const replacement = new UserMessageComponent("question on a new session branch");
	f.chat.clear();
	f.chat.addChild(new Spacer(8));
	f.chat.addChild(replacement);
	f.chat.addChild(new Spacer(50));
	f.tui.renderNow();
	f.at(0);
	f.send("]", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(replacement));
});

test("hidden rows are skipped and newly appended answers become jump targets", (t) => {
	const f = fixture(t);
	f.questions[1]!.render = () => [];
	f.answers[1]!.render = () => [];
	f.tui.renderNow();
	f.at(f.rowOf(f.answers[0]!));
	f.send("]", "q");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[2]!));
	f.send("]", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[2]!));
	const appended = answer("A newly streamed answer");
	f.chat.addChild(appended);
	f.chat.addChild(new Spacer(40));
	f.tui.renderNow();
	f.send("2", "]", "a");
	assert.equal(f.scrollView.scrollTop, f.rowOf(appended));
});

test("Kitty-encoded bracket and suffix keys work in normal mode", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[1]!));
	f.send("\x1b[91u", "\x1b[113u");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[1]!));
	f.send("\x1b[93u", "\x1b[97u");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.answers[1]!));
});

test("insert mode types every binding literally", (t) => {
	const f = fixture(t);
	f.at(0);
	f.editor.setText("");
	f.send("i", "[", "q", "[", "a", "]", "q", "]", "a", "g", "g", "G", "j", "d", "k", "u");
	assert.equal(f.editor.getText(), "[q[a]q]aggGjdku");
	assert.equal(f.editor.mode, "insert");
	assert.deepEqual(f.jumpedRows, []);
});

test("replace, command, search, and visual modes never jump", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[1]!));
	const top = f.scrollView.scrollTop;
	for (const mode of ["replace", "command", "search", "visual", "visual_line", "visual_block"] satisfies VimMode[]) {
		f.editor.mode = mode;
		f.send("[", "q", "]", "q", "g", "g", "G");
		assert.deepEqual(f.jumpedRows, [], mode);
		assert.equal(f.scrollView.scrollTop, top, mode);
		assert.equal(f.scrollView.isFollowingEnd, false, mode);
		for (const key of ["j", "k", "u", "d"]) {
			f.editor.mode = mode;
			f.send(key);
			assert.equal(f.scrollView.scrollTop, top, `${mode}: ${key}`);
		}
	}
});

test("Escape and invalid suffixes cancel prefixes without triggering append or macros", (t) => {
	const f = fixture(t);
	f.at(0);
	f.send("3", "[", "\x1b");
	assert.equal(f.editor.pendingKeys, "");
	assert.equal(f.editor.countStr, "");
	f.send("[", "x", "]", "x");
	assert.equal(f.editor.getText(), "draft prompt");
	assert.equal(f.editor.mode, "normal");
	assert.deepEqual(f.jumpedRows, []);
	f.send('"', '"', "d", "[", "q");
	assert.equal(f.editor.operator, null);
	assert.equal(f.editor.recordingMacroReg, null);
	assert.deepEqual(f.jumpedRows, []);
});

test("brackets remain usable as find/replace characters and text objects", (t) => {
	const f = fixture(t);
	f.at(0);
	f.editor.setText("x[abc]y");
	f.editor.setCursorPosition({ line: 0, col: 0 });
	f.send("f", "[");
	assert.equal(f.editor.getCursorPosition().col, 1);
	f.send('"', '"', "d", "i", "[");
	assert.equal(f.editor.getText(), "x[]y");
	f.editor.setCursorPosition({ line: 0, col: 1 });
	f.send("r", "]");
	assert.equal(f.editor.getText(), "x]]y");
	assert.deepEqual(f.jumpedRows, []);
});

test("recording a question jump does not stop the macro or lose its q", (t) => {
	const f = fixture(t);
	f.at(f.rowOf(f.answers[2]!));
	f.send("q", "b", "[", "q");
	assert.equal(f.editor.recordingMacroReg, "b");
	f.send("q");
	assert.deepEqual(JSON.parse(f.editor.registers.get("b")!.text), ["[", "q"]);
	f.send("@", "b");
	assert.equal(f.scrollView.scrollTop, f.rowOf(f.questions[1]!));
});

test("single-key paste chunks are literal even after a pending jump prefix", (t) => {
	const f = fixture(t);
	f.at(0);
	f.editor.setText("");
	f.send("[", "\x1b[200~", "[", "q", "[", "a", "]", "q", "]", "a", "g", "g", "G", "j", "k", "u", "d", "\x1b[201~");
	assert.equal(f.editor.getText(), "[q[a]q]aggGjkud");
	assert.equal(f.editor.mode, "normal");
	assert.equal(f.editor.pendingKeys, "");
	assert.deepEqual(f.jumpedRows, []);
});

test("focused overlays and autocomplete retain ownership of typing", (t) => {
	const f = fixture(t);
	f.at(0);
	const input = new Input();
	const overlay = f.tui.showOverlay(input);
	f.send("[", "q", "]", "a", "g", "g", "G", "j", "k", "u", "d");
	assert.equal(input.getValue(), "[q]aggGjkud");
	assert.deepEqual(f.jumpedRows, []);
	overlay.hide();
	f.editor.setText("");
	f.editor.isShowingAutocomplete = () => true;
	f.send("[", "q", "]", "a", "g", "g", "G", "j", "k", "u", "d");
	assert.equal(f.editor.getText(), "[q]aggGjkud");
	assert.deepEqual(f.jumpedRows, []);
});

test("regular mode and missing fullscreen layouts safely consume the bindings", () => {
	for (const mode of ["regular", "fullscreen"] as const) {
		const tui = { mode, terminal: new TestTerminal(), requestRender() {} };
		const editor = new VimEditor(tui as unknown as TuiAltScreen, editorTheme, new KeybindingsManager({}) as EditorKeybindingsManager);
		editor.setText("draft");
		for (const key of ["[", "q", "[", "a", "]", "q", "]", "a", "g", "g", "G"]) editor.handleInput(key);
		assert.equal(editor.getText(), "draft");
		assert.equal(editor.mode, "normal");
		assert.equal(editor.pendingKeys, "");
		assert.equal(editor.recordingMacroReg, null);
		if (mode === "fullscreen") {
			for (const key of ["j", "k", "u", "d"]) editor.handleInput(key);
			assert.equal(editor.getText(), "draft");
			assert.equal(editor.operator, null);
		}
	}
});
