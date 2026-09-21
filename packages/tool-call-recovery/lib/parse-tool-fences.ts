/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Recovery parser for pseudo-JSON tool calls that some OpenAI-compatible
 * providers (notably xAI Grok and various proxies) write into the assistant
 * *text* stream instead of emitting native `tool_calls` deltas.
 *
 * The parser is deliberately conservative. A JSON value only becomes a tool
 * call when it carries a recognizable tool name and an arguments payload, and
 * (when a tool allow-list is supplied) the name is one of the active tools.
 * This keeps ordinary prose that happens to contain JSON from being executed.
 *
 * Supported shapes:
 *
 *   <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>
 *   <tool_calls>[{"name":"read","arguments":{"path":"a"}}]</tool_calls>
 *   <function_call>{"name":"bash","parameters":{"command":"ls"}}</function_call>
 *   ```json
 *   {"name":"bash","arguments":{"command":"ls"}}
 *   ```
 *   [TOOL_CALLS] [{"name":"bash","arguments":{"command":"ls"}}]
 *   {"tool_calls":[{"function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]}
 *   {"bash":{"command":"ls"}}
 *   <invoke name="bash"><parameter name="command">ls</parameter></invoke>
 */

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ParseToolFencesResult {
	toolCalls: ParsedToolCall[];
	cleanedText: string;
}

interface Region {
	start: number;
	end: number;
	content: string;
	/** When true the whole trimmed content must be a single JSON value. */
	strict: boolean;
}

interface JsonSpan {
	value: unknown;
	start: number;
	end: number;
}

const TAG_PATTERNS: RegExp[] = [
	/<tool_calls>([\s\S]*?)<\/tool_calls>/gi,
	/<tool_call>([\s\S]*?)<\/tool_call>/gi,
	/<function_calls>([\s\S]*?)<\/function_calls>/gi,
	/<function_call>([\s\S]*?)<\/function_call>/gi,
	/<tool_use>([\s\S]*?)<\/tool_use>/gi,
	/<tool>([\s\S]*?)<\/tool>/gi,
];

const FENCE_PATTERN = /```([a-zA-Z_]*)[ \t]*\r?\n?([\s\S]*?)```/gi;

const TOOL_FENCE_LANGUAGES = new Set([
	"",
	"json",
	"tool_call",
	"tool_calls",
	"function_call",
	"function_calls",
]);

const MARKER_PATTERN = /\[TOOL_CALLS\]/i;

const INVOKE_PATTERN = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const PARAMETER_PATTERN = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;

/**
 * Parse pseudo-JSON tool fences out of an assistant text stream.
 *
 * @param text       The concatenated assistant text content.
 * @param knownTools Optional allow-list of active tool names. When supplied,
 *                   only calls whose name is in the set are recovered.
 */
export function parseToolFences(
	text: string,
	knownTools?: ReadonlySet<string>,
): ParseToolFencesResult {
	if (!text || text.trim().length === 0) {
		return { toolCalls: [], cleanedText: text };
	}

	const toolCalls: ParsedToolCall[] = [];
	const removals: Array<{ start: number; end: number }> = [];

	// 1. Explicit tags and fences.
	for (const region of collectRegions(text)) {
		const values = region.strict
			? strictJsonValues(region.content)
			: findJsonValues(region.content).map((span) => span.value);
		const calls = values.flatMap((value) => normalizeToolCalls(value, knownTools));
		if (calls.length > 0) {
			toolCalls.push(...calls);
			removals.push({ start: region.start, end: region.end });
		}
	}

	// 2. Anthropic-style <invoke name="..."><parameter .../></invoke>.
	if (toolCalls.length === 0) {
		for (const region of collectInvokeRegions(text)) {
			const calls = parseInvoke(region.content, knownTools);
			if (calls.length > 0) {
				toolCalls.push(...calls);
				removals.push({ start: region.start, end: region.end });
			}
		}
	}

	// 3. [TOOL_CALLS] marker followed by a JSON payload.
	if (toolCalls.length === 0) {
		const marker = MARKER_PATTERN.exec(text);
		if (marker) {
			const after = text.slice(marker.index + marker[0].length);
			for (const span of findJsonValues(after)) {
				const calls = normalizeToolCalls(span.value, knownTools);
				if (calls.length > 0) {
					toolCalls.push(...calls);
					removals.push({
						start: marker.index,
						end: marker.index + marker[0].length + span.end,
					});
					break;
				}
			}
		}
	}

	// 4. Bare JSON fallback. Only when the JSON is the whole message or carries
	//    an explicit tool_calls/function_call wrapper, to avoid executing JSON
	//    that the model is merely discussing.
	if (toolCalls.length === 0) {
		for (const span of findJsonValues(text)) {
			if (!isBareToolCallCandidate(text, span)) continue;
			const calls = normalizeToolCalls(span.value, knownTools);
			if (calls.length > 0) {
				toolCalls.push(...calls);
				removals.push({ start: span.start, end: span.end });
			}
		}
	}

	if (toolCalls.length === 0) {
		return { toolCalls: [], cleanedText: text };
	}

	return { toolCalls, cleanedText: removeSpans(text, removals) };
}

function collectRegions(text: string): Region[] {
	const regions: Region[] = [];

	for (const pattern of TAG_PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			regions.push({
				start: match.index,
				end: match.index + match[0].length,
				content: match[1],
				strict: false,
			});
		}
	}

	FENCE_PATTERN.lastIndex = 0;
	let fence: RegExpExecArray | null;
	while ((fence = FENCE_PATTERN.exec(text)) !== null) {
		const language = (fence[1] ?? "").toLowerCase();
		if (!TOOL_FENCE_LANGUAGES.has(language)) continue;
		regions.push({
			start: fence.index,
			end: fence.index + fence[0].length,
			content: fence[2],
			strict: true,
		});
	}

	return regions;
}

function collectInvokeRegions(text: string): Region[] {
	const regions: Region[] = [];
	INVOKE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INVOKE_PATTERN.exec(text)) !== null) {
		regions.push({
			start: match.index,
			end: match.index + match[0].length,
			content: match[0],
			strict: false,
		});
	}
	return regions;
}

function parseInvoke(raw: string, knownTools?: ReadonlySet<string>): ParsedToolCall[] {
	INVOKE_PATTERN.lastIndex = 0;
	const invoke = INVOKE_PATTERN.exec(raw);
	if (!invoke) return [];
	const name = invoke[1]?.trim();
	if (!name) return [];
	if (knownTools && !knownTools.has(name)) return [];

	const args: Record<string, unknown> = {};
	PARAMETER_PATTERN.lastIndex = 0;
	let parameter: RegExpExecArray | null;
	while ((parameter = PARAMETER_PATTERN.exec(invoke[2])) !== null) {
		const key = parameter[1]?.trim();
		if (!key) continue;
		args[key] = coerceScalar(parameter[2]);
	}
	return [{ name, arguments: args }];
}

function coerceScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return "";
	const parsed = tryParseJson(trimmed);
	return parsed === undefined ? trimmed : parsed;
}

function strictJsonValues(content: string): unknown[] {
	const trimmed = content.trim();
	if (!trimmed) return [];
	const value = tryParseJson(trimmed);
	return value === undefined ? [] : [value];
}

function findJsonValues(text: string): JsonSpan[] {
	const spans: JsonSpan[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "{" || ch === "[") {
			const end = matchBalanced(text, i);
			if (end !== -1) {
				const value = tryParseJson(text.slice(i, end));
				if (value !== undefined) {
					spans.push({ value, start: i, end });
					i = end;
					continue;
				}
			}
		}
		i++;
	}
	return spans;
}

/** Return the index just past the balanced `{...}`/`[...]` starting at `start`. */
function matchBalanced(text: string, start: number): number {
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// Light salvage: drop trailing commas before a closing brace/bracket.
		const salvaged = raw.replace(/,\s*([}\]])/g, "$1");
		if (salvaged !== raw) {
			try {
				return JSON.parse(salvaged);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		const parsed = tryParseJson(value);
		return asRecord(parsed) ?? {};
	}
	return asRecord(value) ?? {};
}

function makeToolCall(
	name: string,
	args: unknown,
	knownTools?: ReadonlySet<string>,
): ParsedToolCall | undefined {
	if (knownTools && !knownTools.has(name)) return undefined;
	return { name, arguments: parseArguments(args) };
}

function normalizeToolCalls(
	value: unknown,
	knownTools?: ReadonlySet<string>,
): ParsedToolCall[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => normalizeToolCalls(entry, knownTools));
	}

	const obj = asRecord(value);
	if (!obj) return [];

	// { tool_calls: [...] } / { toolCalls: [...] }
	const nested = obj.tool_calls ?? obj.toolCalls;
	if (nested !== undefined) {
		const calls = normalizeToolCalls(nested, knownTools);
		if (calls.length > 0) return calls;
	}

	// { function_call: { name, arguments } }
	if (obj.function_call !== undefined) {
		const calls = normalizeToolCalls(obj.function_call, knownTools);
		if (calls.length > 0) return calls;
	}

	// { type: "function", function: { name, arguments } }
	const fn = asRecord(obj.function);
	if (fn) {
		const name = pickString(fn.name);
		if (name) {
			const call = makeToolCall(
				name,
				fn.arguments ?? fn.parameters ?? fn.input,
				knownTools,
			);
			if (call) return [call];
		}
	}

	// { name|tool|tool_name|recipient_name, arguments|parameters|input|args }
	const name = pickString(obj.name, obj.tool, obj.tool_name, obj.recipient_name);
	if (name) {
		const call = makeToolCall(
			name,
			obj.arguments ?? obj.parameters ?? obj.input ?? obj.args,
			knownTools,
		);
		if (call) return [call];
	}

	// Single-key form: { "bash": { "command": "ls" } }
	const keys = Object.keys(obj);
	if (keys.length === 1) {
		const onlyKey = keys[0];
		if (!knownTools || knownTools.has(onlyKey)) {
			const args = asRecord(obj[onlyKey]);
			if (args) return [{ name: onlyKey, arguments: args }];
		}
	}

	return [];
}

function isBareToolCallCandidate(text: string, span: JsonSpan): boolean {
	const before = text.slice(0, span.start).trim();
	const after = text.slice(span.end).trim();
	if (before.length === 0 && after.length === 0) return true;

	const obj = asRecord(span.value);
	if (!obj) return false;
	return (
		obj.tool_calls !== undefined ||
		obj.toolCalls !== undefined ||
		obj.function_call !== undefined
	);
}

function removeSpans(
	text: string,
	spans: Array<{ start: number; end: number }>,
): string {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let result = "";
	let cursor = 0;
	for (const span of sorted) {
		if (span.start < cursor) continue;
		result += text.slice(cursor, span.start);
		cursor = span.end;
	}
	result += text.slice(cursor);
	return result.replace(/\n{3,}/g, "\n\n").trim();
}