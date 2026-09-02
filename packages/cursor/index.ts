/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * pi extension: Cursor models via cursor-agent
 *
 * Lets pi use the models of your Cursor subscription (Composer, Claude, GPT,
 * Gemini, Grok, ...) by shelling out to the `cursor-agent` CLI — the same
 * approach the `@rama_nigg/open-cursor` opencode plugin uses.
 *
 * How it works (bridge mode):
 *  - Model discovery uses a built-in default catalog and cache file
 *    (`~/.pi/agent/cursor-models.json`) at startup for instant initialization.
 *    Run `/cursor-models` to query `cursor-agent models` and refresh the cache.
 *  - For each request the full pi conversation (system prompt, messages, tool
 *    schemas) is serialized into a single text prompt. The model is instructed
 *    to emit tool calls as one fenced JSON envelope instead of using
 *    cursor-agent's own built-in tools, because pi owns tool execution.
 *  - The prompt is piped to `cursor-agent --print --output-format stream-json
 *    --stream-partial-output`, and the stream-json events are translated into
 *    pi's AssistantMessageEventStream (thinking deltas, text deltas, usage).
 *  - A tool-call envelope found in the output is parsed into structured pi
 *    toolCall blocks so the normal pi agent loop continues.
 *
 * Authentication uses your existing Cursor login (`cursor-agent status` /
 * `cursor-agent login`). No API key needed.
 *
 * Environment variables:
 *   CURSOR_AGENT_BIN   path to the cursor-agent binary (default: resolved from PATH)
 *   CURSOR_BRIDGE_FORCE  set to "1" to pass --force to cursor-agent (lets its
 *                      built-in tools run unchecked; default off, not recommended)
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
	calculateCost,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "cursor";
const CURSOR_API_ID = "cursor-bridge";

function resolveBin(): string {
	return process.env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";
}

const CACHE_FILE = join(homedir(), ".pi", "agent", "cursor-models.json");

// ---------------------------------------------------------------------------
// Model discovery & caching
// ---------------------------------------------------------------------------

interface DiscoveredModel {
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
}

const DEFAULT_MODELS: DiscoveredModel[] = [
	{ id: "auto", name: "Auto", contextWindow: 400_000, reasoning: false },
	{ id: "composer-2.5", name: "Composer 2.5", contextWindow: 400_000, reasoning: false },
	{ id: "composer-1.5", name: "Composer 1.5", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.6-low", name: "Cursor Grok 4.6 Low", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.6-medium", name: "Cursor Grok 4.6 Medium", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.6-xhigh", name: "Cursor Grok 4.6 Extra High", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.5-low", name: "Cursor Grok 4.5 Low", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.5-medium", name: "Cursor Grok 4.5 Medium", contextWindow: 400_000, reasoning: false },
	{ id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5", contextWindow: 400_000, reasoning: false },
	{ id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000, reasoning: false },
	{ id: "gpt-5.4-high", name: "GPT-5.4 High", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-sonnet-5-low", name: "Claude Sonnet 5 Low", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-sonnet-5-medium", name: "Claude Sonnet 5 Medium", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-sonnet-5-high", name: "Claude Sonnet 5", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-sonnet-5-xhigh", name: "Claude Sonnet 5 Extra High", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-sonnet-5-thinking-low", name: "Claude Sonnet 5 Low Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-sonnet-5-thinking-medium", name: "Claude Sonnet 5 Medium Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-sonnet-5-thinking-high", name: "Claude Sonnet 5 Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-sonnet-5-thinking-xhigh", name: "Claude Sonnet 5 Extra High Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-4.6-sonnet-medium", name: "Claude Sonnet 4.6", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-4.6-sonnet-medium-thinking", name: "Claude Sonnet 4.6 Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-4.6-opus-high", name: "Claude Opus 4.6", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-4.6-opus-max", name: "Claude Opus 4.6 Max", contextWindow: 1_000_000, reasoning: false },
	{ id: "claude-4.6-opus-high-thinking", name: "Claude Opus 4.6 Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-4.6-opus-max-thinking", name: "Claude Opus 4.6 Max Thinking", contextWindow: 1_000_000, reasoning: true },
	{ id: "claude-4.5-opus-high", name: "Claude Opus 4.5", contextWindow: 400_000, reasoning: false },
	{ id: "claude-4.5-opus-high-thinking", name: "Claude Opus 4.5 Thinking", contextWindow: 400_000, reasoning: true },
	{ id: "claude-4.5-sonnet", name: "Claude Sonnet 4.5", contextWindow: 400_000, reasoning: false },
	{ id: "claude-4.5-sonnet-thinking", name: "Claude Sonnet 4.5 Thinking", contextWindow: 400_000, reasoning: true },
	{ id: "claude-4-sonnet", name: "Claude Sonnet 4", contextWindow: 400_000, reasoning: false },
	{ id: "claude-4-sonnet-thinking", name: "Claude Sonnet 4 Thinking", contextWindow: 400_000, reasoning: true },
	{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 1_000_000, reasoning: false },
	{ id: "gemini-3-flash", name: "Gemini 3 Flash", contextWindow: 1_000_000, reasoning: false },
];

function loadCachedModels(): DiscoveredModel[] {
	if (existsSync(CACHE_FILE)) {
		try {
			const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
			if (Array.isArray(data) && data.length > 0) {
				return data;
			}
		} catch {
			// fall through to defaults
		}
	}
	return DEFAULT_MODELS;
}

function saveCachedModels(models: DiscoveredModel[]): void {
	try {
		writeFileSync(CACHE_FILE, JSON.stringify(models, null, 2), "utf-8");
	} catch {
		// ignore write failures
	}
}

async function discoverModels(bin: string): Promise<DiscoveredModel[]> {
	try {
		const { stdout } = await execFileAsync(bin, ["models"], { timeout: 20_000 });
		const models: DiscoveredModel[] = [];
		for (const line of stdout.split("\n")) {
			// Lines look like: "auto - Auto (default)" / "gpt-5.4-high - GPT-5.4 1M High"
			const match = line.match(/^(\S+)\s+-\s+(.+)$/);
			if (!match) continue;
			const id = match[1];
			let name = match[2].trim().replace(/\s*\(default\)\s*$/, "");
			if (!id || id === "Available" || id.toLowerCase() === "model") continue;
			const million = /\b1M\b/i.test(name);
			name = name.replace(/\b1M\b\s*/gi, "").trim() || name;
			models.push({
				id,
				name,
				contextWindow: million ? 1_000_000 : 400_000,
				reasoning: /thinking|reasoning/i.test(id),
			});
		}
		if (models.length > 0) return models;
	} catch {
		// fall through to defaults
	}
	return DEFAULT_MODELS;
}

// ---------------------------------------------------------------------------
// Prompt building (bridge serialization)
// ---------------------------------------------------------------------------

function extractText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function buildToolSchemaBlock(tools: Context["tools"]): string {
	if (!tools || tools.length === 0) {
		return "No tools are available in this session; answer in plain text.";
	}
	const descs = tools
		.map((tool) => {
			let params = "{}";
			try {
				params = JSON.stringify(tool.parameters ?? {});
			} catch {
				/* ignore */
			}
			return `- ${tool.name}: ${tool.description}\n  Parameters (JSON schema): ${params}`;
		})
		.join("\n");
	return descs;
}

function buildPrompt(context: Context): string {
	const lines: string[] = [];

	lines.push(
		[
			"SYSTEM: pi bridge mode is active.",
			"You are the model behind the pi coding agent. The host application owns and executes ALL tools.",
			"",
			"Available tools:",
			buildToolSchemaBlock(context.tools),
			"",
			"To call one or more tools, respond with EXACTLY ONE fenced JSON object and nothing else:",
			"```json",
			'{"tool_calls": [{"name": "<tool name>", "arguments": {<arguments matching the parameter schema>}}]}',
			"```",
			"Rules:",
			'- "arguments" must be a JSON object matching the tool\'s parameter schema.',
			"- After emitting the envelope, stop immediately. Results arrive on your next turn as TOOL_RESULT entries.",
			"- If you need results before continuing, emit the envelope and end your turn.",
			"- Do NOT use any built-in Cursor agent tools (read, write/edit, bash/shell, grep, glob, task, todo). They are unavailable in this integration; all actions go through the protocol above.",
			"- If you don't need tools, reply normally in markdown.",
			"- Never wrap the envelope in additional prose or explanation.",
		].join("\n"),
	);

	if (context.systemPrompt?.trim()) {
		lines.push(`SYSTEM: ${context.systemPrompt.trim()}`);
	}

	const toolCallNames = new Map<string, string>();
	for (const message of context.messages as Message[]) {
		if (message.role === "user") {
			const text = extractText(message.content).trim();
			if (text) lines.push(`USER: ${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim()) parts.push(block.text);
				} else if (block.type === "toolCall") {
					if (block.id && block.name) toolCallNames.set(block.id, block.name);
					parts.push(`tool_call(id: ${block.id}, name: ${block.name}, args: ${JSON.stringify(block.arguments ?? {})})`);
				}
				// thinking blocks are skipped
			}
			if (parts.length > 0) lines.push(`ASSISTANT: ${parts.join("\n")}`);
			continue;
		}
		if (message.role === "toolResult") {
			const body = extractText(message.content).trim();
			const name = message.toolName || toolCallNames.get(message.toolCallId) || "unknown";
			const prefix = `TOOL_RESULT (call_id: ${message.toolCallId}, name: ${name})`;
			const suffix = message.isError ? " [the tool reported an error]" : "";
			lines.push(`${prefix}: ${body || "(empty result)"}${suffix}`);
		}
	}

	if (context.messages.some((m) => m.role === "toolResult")) {
		lines.push("The above tool calls have been executed. Continue your response based on these results.");
	}

	return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool-call envelope extraction
// ---------------------------------------------------------------------------

interface EnvelopeResult {
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

function tryExtractEnvelope(raw: string): EnvelopeResult | "incomplete" | "invalid" {
	const trimmed = raw.trim();
	if (!trimmed) return "incomplete";

	let jsonText: string | null = null;
	let fenceMaybeOpen = false;

	const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i);
	if (fenced) {
		jsonText = fenced[1].trim();
	} else if (/^```(?:json)?/i.test(trimmed)) {
		fenceMaybeOpen = !/\n```/.test(trimmed);
		jsonText = null;
	} else if (trimmed.startsWith("{")) {
		jsonText = trimmed;
	} else {
		return "invalid";
	}

	if (fenceMaybeOpen) return "incomplete";
	if (!jsonText) return "incomplete";
	if (!trimmed.endsWith("}") && !fenced) return "incomplete";

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		// Complete-looking but unparseable: bare object still growing, keep waiting
		// unless it clearly can't become our envelope.
		return jsonText.startsWith("{") ? "incomplete" : "invalid";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.tool_calls)) return "invalid";

	const toolCalls: EnvelopeResult["toolCalls"] = [];
	for (const entry of obj.tool_calls) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.name !== "string") continue;
		const args =
			typeof e.arguments === "object" && e.arguments !== null
				? (e.arguments as Record<string, unknown>)
				: {};
		toolCalls.push({ name: e.name, arguments: args });
	}
	return { toolCalls };
}

// ---------------------------------------------------------------------------
// stream-simple implementation
// ---------------------------------------------------------------------------



function streamCursorBridge(
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		let child: ReturnType<typeof spawn> | null = null;
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			child?.kill("SIGTERM");
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const bin = resolveBin();
			const args = [
				"--print",
				"--output-format",
				"stream-json",
				"--stream-partial-output",
				"--trust",
				"--workspace",
				process.cwd(),
				"--model",
				model.id,
			];
			if (process.env.CURSOR_BRIDGE_FORCE === "1") {
				args.push("--force");
			}

			stream.push({ type: "start", partial: output });

			child = spawn(bin, args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			});

			let stderrTail = "";
			let exitCode: number | null = null;

			child.stderr!.setEncoding("utf8");
			child.stderr!.on("data", (chunk: string) => {
				stderrTail = (stderrTail + chunk).slice(-2000);
			});

			const waitExit = new Promise<void>((resolve, reject) => {
				child.on("error", reject);
				child.on("close", (code) => {
					exitCode = code;
					resolve();
				});
			});

			const lineReader = createInterface({ input: child.stdout! });

			child.stdin!.write(buildPrompt(context));
			child.stdin!.end();

			// Output assembly state
			type BlockKind = "text" | "thinking";
			let currentKind: BlockKind | null = null;
			let currentIndex = -1;

			let emittedAssistant = ""; // all assistant text seen (for delta diffing)
			let buf = ""; // held-back text for envelope detection
			let bufState: "undecided" | "text" | "candidate" = "undecided";
			let extractedToolCalls: ToolCall[] | null = null;
			let resultUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null =
				null;
			let resultOk: boolean | null = null;
			let resultErrorText: string | null = null;

			const closeBlock = () => {
				if (currentKind === "text") {
					const block = output.content[currentIndex];
					if (block && block.type === "text") {
						stream.push({ type: "text_end", contentIndex: currentIndex, content: block.text, partial: output });
					}
				} else if (currentKind === "thinking") {
					const block = output.content[currentIndex];
					if (block && block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: currentIndex, content: block.thinking, partial: output });
					}
				}
				currentKind = null;
				currentIndex = -1;
			};

			const openThinking = () => {
				if (currentKind === "thinking") return;
				closeBlock();
				output.content.push({ type: "thinking", thinking: "" });
				currentIndex = output.content.length - 1;
				currentKind = "thinking";
				stream.push({ type: "thinking_start", contentIndex: currentIndex, partial: output });
			};

			const openText = () => {
				if (currentKind === "text") return;
				closeBlock();
				output.content.push({ type: "text", text: "" });
				currentIndex = output.content.length - 1;
				currentKind = "text";
				stream.push({ type: "text_start", contentIndex: currentIndex, partial: output });
			};

			const emitPlainText = (delta: string) => {
				if (!delta) return;
				openText();
				const block = output.content[currentIndex];
				if (block.type !== "text") return;
				block.text += delta;
				stream.push({ type: "text_delta", contentIndex: currentIndex, delta, partial: output });
			};

			const flushBufferAsText = () => {
				if (buf) {
					emitPlainText(buf);
					buf = "";
				}
				bufState = "text";
			};

			// Feed a raw assistant-text delta through the envelope detector.
			const handleTextDelta = (delta: string) => {
				if (!delta) return;
				if (bufState === "text") {
					emitPlainText(delta);
					return;
				}
				buf += delta;
				if (bufState === "undecided") {
					const meaningful = buf.trimStart();
					if (meaningful.length === 0) return; // whitespace only, keep holding
					if (meaningful.startsWith("{") || meaningful.startsWith("```")) {
						bufState = "candidate";
					} else {
						flushBufferAsText();
						return;
					}
				}
				// candidate state: try to extract a complete envelope
				const outcome = tryExtractEnvelope(buf);
				if (outcome === "incomplete") return; // keep buffering
				if (outcome === "invalid") {
					flushBufferAsText();
					return;
				}
				// Valid envelope: convert to structured tool calls (never shown as text)
				extractedToolCalls = outcome.toolCalls.map((call, i) => ({
					type: "toolCall" as const,
					id: `call_cursor_${Date.now()}_${i}`,
					name: call.name,
					arguments: call.arguments,
				}));
				buf = "";
				bufState = "text";
			};

			const handleLine = (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let event: any;
				try {
					event = JSON.parse(trimmed);
				} catch {
					return;
				}
				if (!event || typeof event !== "object") return;

				switch (event.type) {
					case "thinking": {
						if (event.subtype === "delta" && typeof event.text === "string") {
							openThinking();
							const block = output.content[currentIndex];
							if (block.type === "thinking") {
								block.thinking += event.text;
								stream.push({
									type: "thinking_delta",
									contentIndex: currentIndex,
									delta: event.text,
									partial: output,
								});
							}
						}
						break;
					}
					case "assistant": {
						const content = event.message?.content;
						if (!Array.isArray(content)) break;
						const full = content
							.filter((c: any) => c?.type === "text" && typeof c.text === "string")
							.map((c: any) => c.text)
							.join("");
						if (!full) break;
						// Partial deltas grow monotonically toward the final consolidated
						// event, which repeats the full text — only forward new suffixes.
						if (full.startsWith(emittedAssistant)) {
							const delta = full.slice(emittedAssistant.length);
							emittedAssistant = full;
							if (delta) handleTextDelta(delta);
						}
						break;
					}
					case "result": {
						resultOk = event.subtype === "success" && event.is_error !== true;
						if (event.result) resultErrorText = String(event.result);
						if (event.usage && typeof event.usage === "object") {
							resultUsage = {
								inputTokens: Number(event.usage.inputTokens) || 0,
								outputTokens: Number(event.usage.outputTokens) || 0,
								cacheReadTokens: Number(event.usage.cacheReadTokens) || 0,
								cacheWriteTokens: Number(event.usage.cacheWriteTokens) || 0,
							};
						}
						break;
					}
					default:
						// "system", "user", native "tool_call" events: ignored — pi owns tools.
						break;
				}
			};

			lineReader.on("line", handleLine);
			await waitExit;
			lineReader.close();

			options?.signal?.removeEventListener("abort", onAbort);

			// Flush anything still held by the detector.
			if (bufState !== "text" || buf) flushBufferAsText();
			closeBlock();

			if (aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Request aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			if (exitCode !== 0 && resultOk === null) {
				throw new Error(
					`cursor-agent exited with code ${exitCode}${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}`,
				);
			}

			if (resultUsage) {
				output.usage.input = resultUsage.inputTokens;
				output.usage.output = resultUsage.outputTokens;
				output.usage.cacheRead = resultUsage.cacheReadTokens;
				output.usage.cacheWrite = resultUsage.cacheWriteTokens;
				output.usage.totalTokens =
					resultUsage.inputTokens + resultUsage.outputTokens + resultUsage.cacheReadTokens + resultUsage.cacheWriteTokens;
				calculateCost(model, output.usage);
			}

			if (resultOk === false) {
				output.stopReason = "error";
				output.errorMessage = resultErrorText || "cursor-agent reported an error";
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}

			if (extractedToolCalls && extractedToolCalls.length > 0) {
				for (const call of extractedToolCalls) {
					output.content.push(call);
					const index = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
					const json = JSON.stringify(call.arguments);
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: json, partial: output });
					stream.push({
						type: "toolcall_end",
						contentIndex: index,
						toolCall: { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments },
						partial: output,
					});
				}
				output.stopReason = "toolUse";
			} else {
				output.stopReason = "stop";
			}

			if (output.stopReason === "pending") {
				throw new Error("Provider stream ended without a stop reason");
			}

			stream.push({ type: "done", reason: output.stopReason as Extract<StopReason, "stop" | "toolUse">, message: output });
			stream.end();
		} catch (error) {
			options?.signal?.removeEventListener("abort", onAbort);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error
					? error.message.includes("ENOENT")
						? "cursor-agent binary not found. Install Cursor CLI and run `cursor-agent login`."
						: error.message
					: String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

function registerCursorProvider(pi: ExtensionAPI, models: DiscoveredModel[]) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Cursor",
		api: CURSOR_API_ID,
		// Placeholder — requests never hit HTTP; streaming goes through streamSimple.
		baseUrl: "http://cursor-agent-local",
		// Not actually used (auth comes from your `cursor-agent login`), but the
		// provider config expects an API key when models are defined.
		apiKey: "cursor-agent-local-auth",
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: 64_000,
		})),
		streamSimple: streamCursorBridge,
	});
}

export default function (pi: ExtensionAPI) {
	const bin = resolveBin();
	const initialModels = loadCachedModels();

	registerCursorProvider(pi, initialModels);

	pi.registerCommand("cursor-models", {
		description: "Re-discover available Cursor models via cursor-agent",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Discovering Cursor models via cursor-agent...", "info");
			const models = await discoverModels(bin);
			saveCachedModels(models);
			registerCursorProvider(pi, models);
			ctx.ui.notify(
				`Found and cached ${models.length} Cursor models:\n${models.map((m) => `  cursor/${m.id} — ${m.name}`).join("\n")}`,
				"info",
			);
		},
	});
}
