/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import assert from "node:assert/strict";
import test from "node:test";
import {
	ANCHOR_MARKER,
	anchorLineFor,
	editorLaunch,
	insertAnchor,
	renderConversation,
	truncateText,
} from "./conversation.mjs";

test("renderConversation renders user, assistant, and tool results", () => {
	const entries = [
		{ type: "message", id: "1", parentId: null, timestamp: "2026-02-03T10:00:00.000Z", message: { role: "user", content: "hello there" } },
		{
			type: "message",
			id: "2",
			parentId: "1",
			timestamp: "2026-02-03T10:00:05.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "reading the file" },
					{ type: "thinking", thinking: "internal reasoning" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
				],
			},
		},
		{
			type: "message",
			id: "3",
			parentId: "2",
			timestamp: "2026-02-03T10:00:06.000Z",
			message: { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
		},
	];

	const text = renderConversation(entries, { sessionName: "demo", model: "test/model" });
	assert.match(text, /### 👤 User/);
	assert.match(text, /hello there/);
	assert.match(text, /### 🤖 Assistant/);
	assert.match(text, /reading the file/);
	assert.match(text, /- `read`/);
	assert.match(text, /"path": "\/tmp\/x"/);
	assert.match(text, /#### ↳ read · result/);
	assert.match(text, /file body/);
	// Thinking blocks are skipped.
	assert.doesNotMatch(text, /internal reasoning/);
	// Metadata line.
	assert.match(text, /session: demo/);
	assert.match(text, /model: test\/model/);
});

test("renderConversation skips non-display custom messages and usage entries", () => {
	const entries = [
		{ type: "custom_message", id: "1", parentId: null, timestamp: "2026-02-03T10:00:00.000Z", customType: "hidden", content: "secret", display: false },
		{ type: "usage", id: "2", parentId: "1", timestamp: "2026-02-03T10:00:01.000Z", kind: "cache_warm", usage: {} },
	];
	const text = renderConversation(entries);
	assert.doesNotMatch(text, /secret/);
	assert.doesNotMatch(text, /cache_warm/);
});

test("renderConversation truncates long tool results", () => {
	const long = "x".repeat(10_000);
	const entries = [
		{
			type: "message",
			id: "1",
			parentId: null,
			timestamp: "2026-02-03T10:00:00.000Z",
			message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: long }] },
		},
	];
	const text = renderConversation(entries);
	assert.match(text, /truncated, \d+ more chars/);
	assert.ok(text.length < long.length);
	assert.match(text, /#### ↳ bash · ⚠ error/);
});

test("anchorLineFor clamps and maps fractions", () => {
	assert.equal(anchorLineFor(0, 100), 1);
	assert.equal(anchorLineFor(1, 100), 100);
	assert.equal(anchorLineFor(0.5, 100), 50);
	assert.equal(anchorLineFor(-1, 100), 1);
	assert.equal(anchorLineFor(2, 100), 100);
	assert.equal(anchorLineFor(Number.NaN, 100), 100);
	assert.equal(anchorLineFor(0.5, 0), 1);
});

test("insertAnchor inserts the marker at the requested line", () => {
	const text = "one\ntwo\nthree";
	const anchored = insertAnchor(text, 2);
	const lines = anchored.text.split("\n");
	assert.equal(lines.indexOf(ANCHOR_MARKER), 2); // after "one", "", marker
	assert.equal(anchored.line, 3);
	assert.deepEqual(lines.slice(0, 2), ["one", ""]);
	assert.deepEqual(lines.slice(3), ["two", "three"]);
});

test("editorLaunch positions vim-family editors and centers the line", () => {
	const launch = editorLaunch("nvim -u NONE", "/tmp/conversation.md", 42);
	assert.equal(launch.command, "nvim");
	assert.deepEqual(launch.args, ["-u", "NONE", "+42", "-c", "normal zz", "/tmp/conversation.md"]);
});

test("editorLaunch positions nano and code", () => {
	assert.deepEqual(editorLaunch("nano", "/tmp/c.md", 7).args, ["+7", "/tmp/c.md"]);
	const code = editorLaunch("code --goto", "/tmp/c.md", 7);
	assert.deepEqual(code.args, ["--goto", "--wait", "-g", "/tmp/c.md:7"]);
});

test("editorLaunch falls back to a plain file argument", () => {
	const launch = editorLaunch("some-unknown-editor --flag", "/tmp/c.md", 7);
	assert.deepEqual(launch.args, ["--flag", "/tmp/c.md"]);
	assert.deepEqual(editorLaunch("vim", "/tmp/c.md", 0).args, ["/tmp/c.md"]);
});

test("truncateText is a no-op for short text", () => {
	assert.equal(truncateText("short", 100), "short");
});
