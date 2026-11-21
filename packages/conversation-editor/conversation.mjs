/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Pure helpers for the conversation-editor extension.
 *
 * Session entries are rendered into one readable Markdown document, and the
 * editor launch helpers position the cursor on a given line so the document
 * opens where the transcript was on screen.
 */

import { basename } from "node:path";

export const ANCHOR_MARKER = "<!-- pi-conversation-editor: current view -->";

const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_TOOL_ARGS_CHARS = 800;

export function truncateText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… [truncated, ${text.length - maxChars} more chars]`;
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.filter((part) => part !== "").join("\n");
}

function timeOf(entry) {
	const date = new Date(entry.timestamp);
	if (Number.isNaN(date.getTime())) return "";
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/** Render session entries (the active branch) as one Markdown document. */
export function renderConversation(entries, info = {}) {
	const lines = ["# Pi conversation"];
	const meta = [];
	if (info.sessionName) meta.push(`session: ${info.sessionName}`);
	if (info.model) meta.push(`model: ${info.model}`);
	meta.push(`entries: ${entries.length}`);
	meta.push(`exported: ${new Date().toISOString()}`);
	lines.push("", meta.join(" · "), "", "---", "");

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;

		if (entry.type === "compaction") {
			lines.push(`### 🗜 Compaction · ${timeOf(entry)}`, "", "The conversation before this point was compacted:", "", entry.summary ?? "", "");
			continue;
		}
		if (entry.type === "branch_summary") {
			lines.push(`### 🌿 Branch summary · ${timeOf(entry)}`, "", entry.summary ?? "", "");
			continue;
		}
		if (entry.type === "custom_message") {
			if (!entry.display) continue;
			lines.push(`### 📎 ${entry.customType} · ${timeOf(entry)}`, "", contentToText(entry.content), "");
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;

		const message = entry.message;
		if (message.role === "user") {
			lines.push(`### 👤 User · ${timeOf(entry)}`, "", contentToText(message.content), "");
			continue;
		}

		if (message.role === "assistant") {
			const textParts = [];
			const toolCalls = [];
			for (const block of message.content ?? []) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
					textParts.push(block.text);
				} else if (block.type === "toolCall") {
					toolCalls.push(block);
				}
				// Thinking blocks are skipped: reading copy, not a reasoning dump.
			}
			lines.push(`### 🤖 Assistant · ${timeOf(entry)}`, "");
			if (textParts.length > 0) lines.push(textParts.join("\n"), "");
			for (const call of toolCalls) {
				const args = JSON.stringify(call.arguments ?? {}, null, "\t");
				lines.push(`- \`${call.name ?? "tool"}\` ${truncateText(args, MAX_TOOL_ARGS_CHARS)}`, "");
			}
			continue;
		}

		if (message.role === "toolResult") {
			const text = contentToText(message.content);
			const label = message.isError ? "⚠ error" : "result";
			lines.push(`#### ↳ ${message.toolName ?? "tool"} · ${label}`, "", "````", truncateText(text, MAX_TOOL_RESULT_CHARS), "````", "");
			continue;
		}
	}

	return lines.join("\n");
}

/** Map a viewport fraction (0 = top, 1 = bottom) to a 1-based document line. */
export function anchorLineFor(fraction, totalLines) {
	if (!Number.isFinite(fraction)) return totalLines;
	const clamped = Math.min(1, Math.max(0, fraction));
	return Math.max(1, Math.min(totalLines, Math.round(clamped * totalLines)));
}

/**
 * Insert the anchor marker before a 1-based line.
 * Returns the new text and the 1-based line of the marker itself.
 */
export function insertAnchor(text, line) {
	const lines = text.split("\n");
	const at = Math.max(0, Math.min(lines.length, line - 1));
	lines.splice(at, 0, "", ANCHOR_MARKER);
	return { text: lines.join("\n"), line: at + 2 };
}

/** Build the editor command and arguments, positioning the cursor on `line` when supported. */
export function editorLaunch(command, filePath, line = 0) {
	const parts = String(command).trim().split(/\s+/).filter(Boolean);
	const editor = parts[0] ?? "nano";
	const args = parts.slice(1);
	const base = basename(editor).toLowerCase();

	if (line > 0) {
		if (["vim", "nvim", "vi", "vim.tiny", "gvim"].includes(base)) {
			// +N puts the cursor on line N; "normal zz" centers it in the window.
			return { command: editor, args: [...args, `+${line}`, "-c", "normal zz", filePath] };
		}
		if (["nano", "emacs", "emacsclient"].includes(base)) {
			return { command: editor, args: [...args, `+${line}`, filePath] };
		}
		if (["code", "code-insiders", "codium", "cursor"].includes(base)) {
			const withWait = args.includes("--wait") ? args : [...args, "--wait"];
			return { command: editor, args: [...withWait, "-g", `${filePath}:${line}`] };
		}
	}
	return { command: editor, args: [...args, filePath] };
}
