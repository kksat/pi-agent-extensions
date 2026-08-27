/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { VimEditor } from "./index.ts";

class MockTUI {
	terminal = { rows: 24, columns: 80 };
	requestRender() {}
}

class MockKeybindings {
	matches(_data: string, _id: string) {
		return false;
	}
	getKeys() {
		return [];
	}
}

const mockTheme = {
	borderColor: (s: string) => s,
	selectList: {
		selectedPrefix: (s: string) => s,
		selectedText: (s: string) => s,
		description: (s: string) => s,
		scrollInfo: (s: string) => s,
		noMatch: (s: string) => s,
	},
};

function createEditor(initialText = ""): VimEditor {
	const tui = new MockTUI() as any;
	const kb = new MockKeybindings() as any;
	const editor = new VimEditor(tui, mockTheme as any, kb);
	editor.setText(initialText);
	editor.mode = "normal";
	editor.setCursorPosition({ line: 0, col: 0 });
	return editor;
}

function sendKeys(editor: VimEditor, keys: string[]) {
	for (const k of keys) {
		editor.handleInput(k);
	}
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${msg}`);
	}
}

function assertEqual(actual: any, expected: any, msg: string) {
	const act = JSON.stringify(actual);
	const exp = JSON.stringify(expected);
	if (act === exp) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${msg} (got ${act}, expected ${exp})`);
	}
}

console.log("Running pi-vim unit tests...\n");

// Test 1: Basic Normal motions
{
	const ed = createEditor("hello world\nsecond line");
	assertEqual(ed.getCursorPosition(), { line: 0, col: 0 }, "initial cursor");
	sendKeys(ed, ["w"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 6 }, "w moves to next word");
	sendKeys(ed, ["e"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 10 }, "e moves to end of word");
	sendKeys(ed, ["b"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 6 }, "b moves to start of word");
	sendKeys(ed, ["0"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 0 }, "0 moves to line start");
	sendKeys(ed, ["$"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 10 }, "$ moves to line end");
	sendKeys(ed, ["j"]);
	assertEqual(ed.getCursorPosition(), { line: 1, col: 10 }, "j moves down");
	sendKeys(ed, ["k"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 10 }, "k moves up");
}

// Test 2: Text Deletion with dw, dd, x
{
	const ed = createEditor("const foo = 123;");
	sendKeys(ed, ["d", "w"]);
	assertEqual(ed.getText(), "foo = 123;", "dw deletes word forward");
	sendKeys(ed, ["x"]);
	assertEqual(ed.getText(), "oo = 123;", "x deletes character under cursor");
	sendKeys(ed, ["u"]);
	assertEqual(ed.getText(), "foo = 123;", "u undos x");
}

// Test 3: dd and paste
{
	const ed = createEditor("line 1\nline 2\nline 3");
	sendKeys(ed, ["d", "d"]);
	assertEqual(ed.getText(), "line 2\nline 3", "dd deletes first line");
	sendKeys(ed, ["p"]);
	assertEqual(ed.getText(), "line 2\nline 1\nline 3", "p pastes linewise below");
	sendKeys(ed, ["u"]);
	assertEqual(ed.getText(), "line 2\nline 3", "undo paste");
}

// Test 4: Counts (3w, 2x, 2dd)
{
	const ed = createEditor("one two three four five");
	sendKeys(ed, ["3", "w"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 14 }, "3w moves 3 words");
	sendKeys(ed, ["2", "x"]);
	assertEqual(ed.getText(), "one two three ur five", "2x deletes 2 chars");
}

// Test 5: Text Objects: di", da", di(, da(
{
	const ed = createEditor('const msg = "hello world";');
	ed.setCursorPosition({ line: 0, col: 15 });
	sendKeys(ed, ["d", "i", '"']);
	assertEqual(ed.getText(), 'const msg = "";', 'di" deletes inside quotes');

	const ed2 = createEditor("func(arg1, arg2);");
	ed2.setCursorPosition({ line: 0, col: 8 });
	sendKeys(ed2, ["d", "i", "("]);
	assertEqual(ed2.getText(), "func();", "di( deletes inside parentheses");

	const ed3 = createEditor("func(arg1, arg2);");
	ed3.setCursorPosition({ line: 0, col: 8 });
	sendKeys(ed3, ["d", "a", "("]);
	assertEqual(ed3.getText(), "func;", "da( deletes around parentheses");
}

// Test 6: Text Objects: diw, daw, diW, daW, di{, da{, di[, da[, di<, da<
{
	const ed = createEditor("hello beautiful world");
	ed.setCursorPosition({ line: 0, col: 8 });
	sendKeys(ed, ["d", "i", "w"]);
	assertEqual(ed.getText(), "hello  world", "diw deletes word without trailing space");

	const ed2 = createEditor("hello beautiful world");
	ed2.setCursorPosition({ line: 0, col: 8 });
	sendKeys(ed2, ["d", "a", "w"]);
	assertEqual(ed2.getText(), "hello world", "daw deletes word with trailing space");

	const ed3 = createEditor("const obj = { name: 'pi', age: 1 };");
	ed3.setCursorPosition({ line: 0, col: 18 });
	sendKeys(ed3, ["d", "i", "{"]);
	assertEqual(ed3.getText(), "const obj = {};", "di{ deletes inside braces");

	const ed4 = createEditor("const arr = [10, 20, 30];");
	ed4.setCursorPosition({ line: 0, col: 15 });
	sendKeys(ed4, ["d", "i", "["]);
	assertEqual(ed4.getText(), "const arr = [];", "di[ deletes inside brackets");

	const ed5 = createEditor("const tag = <Button active>;");
	ed5.setCursorPosition({ line: 0, col: 15 });
	sendKeys(ed5, ["d", "i", "<"]);
	assertEqual(ed5.getText(), "const tag = <>;", "di< deletes inside angle brackets");
}

// Test 7: Change Operator (cw, c$, cc, C, S, s)
{
	const ed = createEditor("hello world");
	sendKeys(ed, ["c", "w"]);
	assertEqual(ed.mode, "insert", "cw enters insert mode");
	assertEqual(ed.getText(), " world", "cw deletes current word");
	sendKeys(ed, ["b", "i", "g", "\x1b"]);
	assertEqual(ed.mode, "normal", "Escape returns to normal mode");
	assertEqual(ed.getText(), "big world", "inserted text replaces word");

	const ed2 = createEditor("foo bar baz");
	ed2.setCursorPosition({ line: 0, col: 4 });
	sendKeys(ed2, ["C"]);
	assertEqual(ed2.mode, "insert", "C enters insert mode");
	assertEqual(ed2.getText(), "foo ", "C deletes to end of line");
	sendKeys(ed2, ["n", "e", "w", "\x1b"]);
	assertEqual(ed2.getText(), "foo new", "C replaces tail");

	const ed3 = createEditor("old line");
	sendKeys(ed3, ["S"]);
	assertEqual(ed3.mode, "insert", "S enters insert mode");
	assertEqual(ed3.getText(), "", "S clears line");
	sendKeys(ed3, ["r", "e", "p", "l", "a", "c", "e", "d", "\x1b"]);
	assertEqual(ed3.getText(), "replaced", "S replaces line content");
}

// Test 8: Visual Mode (v, V, o)
{
	const ed = createEditor("hello world");
	sendKeys(ed, ["v", "e", "d"]);
	assertEqual(ed.mode, "normal", "d in visual mode deletes and returns to normal");
	assertEqual(ed.getText(), " world", "v+e+d deletes selected text");

	const ed2 = createEditor("line 1\nline 2\nline 3");
	sendKeys(ed2, ["V", "j", "d"]);
	assertEqual(ed2.getText(), "line 3", "V+j+d deletes visual lines");

	const ed3 = createEditor("first second third");
	sendKeys(ed3, ["v", "w", "w", "o"]);
	assertEqual(ed3.getCursorPosition(), { line: 0, col: 0 }, "o swaps cursor to start of selection");
}

// Test 9: Case Toggle (~, gu, gU)
{
	const ed = createEditor("hello");
	sendKeys(ed, ["~", "~"]);
	assertEqual(ed.getText(), "HEllo", "~ toggles character case");

	const ed2 = createEditor("hello world");
	sendKeys(ed2, ["v", "$", "U"]);
	assertEqual(ed2.getText(), "HELLO WORLD", "U uppercases visual selection");

	const ed3 = createEditor("HELLO WORLD");
	sendKeys(ed3, ["v", "$", "u"]);
	assertEqual(ed3.getText(), "hello world", "u lowercases visual selection");
}

// Test 10: Find Char (f, F, t, T, ;, ,)
{
	const ed = createEditor("const x = a + b + c;");
	sendKeys(ed, ["f", "+"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 12 }, "f+ jumps to first +");
	sendKeys(ed, [";"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 16 }, "; repeats f+ to second +");
	sendKeys(ed, [","]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 12 }, ", reverses search back to first +");
}

// Test 11: Matching Bracket (%)
{
	const ed = createEditor("const fn = (x) => [1, 2, { a: (3) }];");
	ed.setCursorPosition({ line: 0, col: 18 }); // on [
	sendKeys(ed, ["%"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 35 }, "% jumps from [ to ]");
	sendKeys(ed, ["%"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 18 }, "% jumps back to [");
}

// Test 12: Join Lines (J)
{
	const ed = createEditor("first line\nsecond line");
	sendKeys(ed, ["J"]);
	assertEqual(ed.getText(), "first line second line", "J joins lines with space");
}

// Test 13: Replace Char (r)
{
	const ed = createEditor("hello");
	sendKeys(ed, ["r", "X"]);
	assertEqual(ed.getText(), "Xello", "r replaces character under cursor");
}

// Test 14: Indent and Unindent (>>, <<)
{
	const ed = createEditor("line 1\nline 2");
	sendKeys(ed, [">", ">"]);
	assertEqual(ed.getText(), "    line 1\nline 2", ">> indents line");
	sendKeys(ed, ["<", "<"]);
	assertEqual(ed.getText(), "line 1\nline 2", "<< unindents line");
}

// Test 15: Search (/pattern, ?, n, N)
{
	const ed = createEditor("apple banana cherry apple banana");
	sendKeys(ed, ["/", "a", "p", "p", "l", "e", "\r"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 20 }, "/apple from 0 finds next apple");
	sendKeys(ed, ["n"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 0 }, "n wraps around to first apple");
	sendKeys(ed, ["N"]);
	assertEqual(ed.getCursorPosition(), { line: 0, col: 20 }, "N jumps backward to second apple");
}

// Test 16: Dot Repeat (.)
{
	const ed = createEditor("apple banana cherry");
	sendKeys(ed, ["d", "w"]);
	assertEqual(ed.getText(), "banana cherry", "dw deletes first word");
	sendKeys(ed, ["."]);
	assertEqual(ed.getText(), "cherry", ". repeats dw");
}

// Test 17: Fast jk escape
{
	const ed = createEditor("start ");
	ed.mode = "insert";
	ed.setCursorPosition({ line: 0, col: 6 });
	sendKeys(ed, ["j", "k"]);
	assertEqual(ed.mode, "normal", "jk exits insert mode");
	assertEqual(ed.getText(), "start ", "jk does not leave j behind");
}

// Test 18: Redo with Ctrl+R
{
	const ed = createEditor("alpha beta gamma");
	sendKeys(ed, ["d", "w"]);
	assertEqual(ed.getText(), "beta gamma", "dw deleted alpha");
	sendKeys(ed, ["u"]);
	assertEqual(ed.getText(), "alpha beta gamma", "undo restored alpha");
	sendKeys(ed, ["\x12"]); // Ctrl+R
	assertEqual(ed.getText(), "beta gamma", "Ctrl+R redid deletion");
}

// Test 19: Named Registers ("a)
{
	const ed = createEditor("line A\nline B");
	sendKeys(ed, ['"', "a", "d", "d"]);
	assertEqual(ed.getText(), "line B", "deleted into register a");
	sendKeys(ed, ['"', "a", "p"]);
	assertEqual(ed.getText(), "line B\nline A", "pasted from register a");
}

// Test 20: Multiplication of counts (2d3w)
{
	const ed = createEditor("w1 w2 w3 w4 w5 w6 w7 w8");
	sendKeys(ed, ["2", "d", "3", "w"]);
	assertEqual(ed.getText(), "w7 w8", "2d3w deletes 6 words (2 * 3)");
}

// Test 21: Insert shortcuts (I, A, o, O)
{
	const ed = createEditor("  middle  ");
	sendKeys(ed, ["I", "S", "\x1b"]);
	assertEqual(ed.getText(), "  Smiddle  ", "I inserts at first non-blank");

	const ed2 = createEditor("end");
	sendKeys(ed2, ["A", "!", "\x1b"]);
	assertEqual(ed2.getText(), "end!", "A appends at line end");

	const ed3 = createEditor("first\nsecond");
	sendKeys(ed3, ["o", "n", "e", "w", "\x1b"]);
	assertEqual(ed3.getText(), "first\nnew\nsecond", "o inserts newline below");

	const ed4 = createEditor("first\nsecond");
	ed4.setCursorPosition({ line: 1, col: 0 });
	sendKeys(ed4, ["O", "t", "o", "p", "\x1b"]);
	assertEqual(ed4.getText(), "first\ntop\nsecond", "O inserts newline above");
}

// Test 22: Paragraph motions ({, })
{
	const ed = createEditor("para 1 line 1\npara 1 line 2\n\npara 2 line 1\npara 2 line 2");
	sendKeys(ed, ["}"]);
	assertEqual(ed.getCursorPosition().line, 2, "} jumps to blank line");
	sendKeys(ed, ["}"]);
	assertEqual(ed.getCursorPosition().line, 4, "} jumps to bottom of buffer");
	sendKeys(ed, ["{"]);
	assertEqual(ed.getCursorPosition().line, 2, "{ jumps to blank line upward");
}

// Test 23: Ex commands (:s, :quote, :unquote, :fence, :reflow, :bullet)
{
	const ed = createEditor("hello foo world foo");
	sendKeys(ed, [":", "%", "s", "/", "f", "o", "o", "/", "b", "a", "r", "/", "g", "\r"]);
	assertEqual(ed.getText(), "hello bar world bar", ":%s/foo/bar/g replaces all occurrences");

	const ed2 = createEditor("line 1\nline 2");
	sendKeys(ed2, [":", "q", "u", "o", "t", "e", "\r"]);
	assertEqual(ed2.getText(), "> line 1\n> line 2", ":quote adds markdown quote");
	sendKeys(ed2, [":", "u", "n", "q", "u", "o", "t", "e", "\r"]);
	assertEqual(ed2.getText(), "line 1\nline 2", ":unquote removes markdown quote");

	const ed3 = createEditor("const x = 1;");
	sendKeys(ed3, [":", "f", "e", "n", "c", "e", " ", "t", "s", "\r"]);
	assertEqual(ed3.getText(), "```ts\nconst x = 1;\n```", ":fence ts wraps in code block");

	const ed4 = createEditor("apple\nbanana");
	sendKeys(ed4, [":", "b", "u", "l", "l", "e", "t", "\r"]);
	assertEqual(ed4.getText(), "- apple\n- banana", ":bullet adds bullet list");
}

// Test 24: Marks (m{a-z}, '{a-z}, `{a-z})
{
	const ed = createEditor("line 1\n  line 2 indented\nline 3");
	ed.setCursorPosition({ line: 1, col: 7 });
	sendKeys(ed, ["m", "a"]);
	ed.setCursorPosition({ line: 0, col: 0 });
	sendKeys(ed, ["'", "a"]);
	assertEqual(ed.getCursorPosition(), { line: 1, col: 2 }, "'a jumps to mark line first non-blank");
	sendKeys(ed, ["`", "a"]);
	assertEqual(ed.getCursorPosition(), { line: 1, col: 7 }, "`a jumps to exact mark position");
}

// Test 25: Macros (qa, q, @a, @@)
{
	const ed = createEditor("item1\nitem2\nitem3");
	// Record macro into 'a': I, -, space, Esc, j
	sendKeys(ed, ["q", "a", "I", "-", " ", "\x1b", "j", "q"]);
	assertEqual(ed.getText(), "- item1\nitem2\nitem3", "macro recorded first line");
	sendKeys(ed, ["@", "a"]);
	assertEqual(ed.getText(), "- item1\n- item2\nitem3", "@a replayed macro on second line");
	sendKeys(ed, ["@", "@"]);
	assertEqual(ed.getText(), "- item1\n- item2\n- item3", "@@ repeated last macro on third line");
}

// Test 26: Visual Block Mode (Alt+B / Ctrl+V, d)
{
	const ed = createEditor("abcd\nefgh\nijkl");
	ed.setCursorPosition({ line: 0, col: 1 });
	sendKeys(ed, ["\x1bb", "j", "l", "d"]); // Alt+B down right d
	assertEqual(ed.getText(), "ad\neh\nijkl", "Visual block deletes rectangle");
}

console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
	process.exit(1);
}
