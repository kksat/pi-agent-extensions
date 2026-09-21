/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Tool-call recovery for providers that leak pseudo-JSON tool fences into the
 * assistant text stream.
 *
 * xAI Grok and some OpenAI-compatible proxies occasionally write a tool call as
 * text (for example `<tool_call>{"name":"bash","arguments":{...}}</tool_call>`)
 * instead of emitting native `tool_calls` deltas. Pi then sees zero `toolCall`
 * content blocks, treats the turn as complete, and yields back to the prompt.
 *
 * Pi's `message_end` extension event can replace the finalized assistant
 * message in place, and that replacement is visible to the agent loop before it
 * checks for tool calls. This extension uses that hook to parse the leaked
 * fences, convert them into real `toolCall` blocks, and strip the raw fence text
 * so it is not replayed to the model.
 *
 * Safety:
 * - Only runs when the provider produced no native tool calls.
 * - Only runs on clean `stop` turns (never truncated/errored/aborted output).
 * - Only recovers calls whose name is one of the currently active tools.
 * - Bare JSON is only treated as a tool call when it is the whole message or
 *   carries an explicit `tool_calls`/`function_call` wrapper.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseToolFences } from "./lib/parse-tool-fences.ts";

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		// The provider already emitted native tool calls; nothing to recover.
		if (message.content.some((block) => block.type === "toolCall")) return;

		// Never rewrite truncated or failed turns: the arguments may be incomplete.
		if (
			message.stopReason === "length" ||
			message.stopReason === "error" ||
			message.stopReason === "aborted"
		) {
			return;
		}

		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (!looksLikeToolFence(text)) return;

		const knownTools = new Set(pi.getActiveTools());
		const { toolCalls, cleanedText } = parseToolFences(text, knownTools);
		if (toolCalls.length === 0) return;

		const toolCallBlocks = toolCalls.map((call) => ({
			type: "toolCall" as const,
			id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
			name: call.name,
			arguments: call.arguments,
		}));

		const content: typeof message.content = [];
		let textPlaced = false;
		for (const block of message.content) {
			if (block.type === "text") {
				if (!textPlaced && cleanedText.trim().length > 0) {
					content.push({ type: "text", text: cleanedText });
					textPlaced = true;
				}
				continue;
			}
			content.push(block);
		}
		if (!textPlaced && cleanedText.trim().length > 0) {
			content.push({ type: "text", text: cleanedText });
		}
		content.push(...toolCallBlocks);

		return {
			message: {
				...message,
				content,
				stopReason: "toolUse" as const,
			},
		};
	});
}

function looksLikeToolFence(text: string): boolean {
	if (!text) return false;
	return (
		text.includes("<tool") ||
		text.includes("<function") ||
		text.includes("<invoke") ||
		text.includes("[TOOL_CALLS]") ||
		text.includes("```") ||
		text.includes("{")
	);
}