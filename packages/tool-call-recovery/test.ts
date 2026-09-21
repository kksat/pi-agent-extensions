/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Self-running checks for the pseudo-JSON tool-fence recovery parser. Run with:
//   node --experimental-strip-types packages/tool-call-recovery/test.ts

import { parseToolFences } from "./lib/parse-tool-fences.ts";

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

function assertEqual(actual: unknown, expected: unknown, msg: string) {
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

const TOOLS = new Set(["bash", "read", "edit", "write"]);

// 1. <tool_call> with name/arguments
{
	const input = 'Sure.\n<tool_call>\n{"name":"bash","arguments":{"command":"ls -la"}}\n</tool_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "ls -la" } }], "tag: name/arguments");
	assertEqual(result.cleanedText, "Sure.", "tag: fence stripped");
}

// 2. <tool_calls> array
{
	const input =
		'<tool_calls>[{"name":"read","arguments":{"path":"a"}},{"name":"read","arguments":{"path":"b"}}]</tool_calls>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls.length, 2, "tag array: two calls");
	assertEqual(result.toolCalls[1], { name: "read", arguments: { path: "b" } }, "tag array: second call");
}

// 3. <function_call> with parameters
{
	const input = '<function_call>{"name":"bash","parameters":{"command":"pwd"}}</function_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "pwd" } }], "function_call: parameters");
}

// 4. Markdown json fence
{
	const input = 'Here you go:\n```json\n{"name":"write","arguments":{"path":"x","content":"hi"}}\n```';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "write", arguments: { path: "x", content: "hi" } }], "fence: json");
	assertEqual(result.cleanedText, "Here you go:", "fence: stripped");
}

// 5. [TOOL_CALLS] marker
{
	const input = '[TOOL_CALLS] [{"name":"bash","arguments":{"command":"whoami"}}]';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "whoami" } }], "marker: array");
}

// 6. OpenAI tool_calls wrapper with string arguments
{
	const input =
		'{"tool_calls":[{"function":{"name":"bash","arguments":"{\\"command\\":\\"date\\"}"}}]}';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "date" } }], "wrapper: string arguments");
}

// 7. Single-key form
{
	const input = '<tool_call>{"bash":{"command":"id"}}</tool_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "id" } }], "single-key form");
}

// 8. Anthropic-style invoke
{
	const input =
		'<invoke name="bash"><parameter name="command">echo hi</parameter></invoke>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "echo hi" } }], "invoke: parameter");
}

// 9. Unknown tool rejected
{
	const input = '<tool_call>{"name":"rm_rf","arguments":{"path":"/"}}</tool_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [], "unknown tool rejected");
	assertEqual(result.cleanedText, input, "unknown tool: text untouched");
}

// 10. Bare JSON embedded in prose is not executed
{
	const input = 'The config looks like {"name":"bash","arguments":{"command":"ls"}} to me.';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [], "bare JSON in prose rejected");
}

// 11. Bare JSON as the whole message is accepted
{
	const input = '{"name":"bash","arguments":{"command":"ls"}}';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "ls" } }], "bare JSON whole message");
}

// 12. Plain prose with no JSON is untouched
{
	const input = "I will run the tests now.";
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [], "prose: no calls");
	assertEqual(result.cleanedText, input, "prose: untouched");
}

// 13. Trailing comma salvage
{
	const input = '<tool_call>{"name":"bash","arguments":{"command":"ls",},}</tool_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [{ name: "bash", arguments: { command: "ls" } }], "trailing comma salvaged");
}

// 14. Multiple separate tags
{
	const input =
		'<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls.length, 2, "multiple tags: two calls");
	assertEqual(result.cleanedText, "", "multiple tags: fully stripped");
}

// 15. Non-tool fence language ignored
{
	const input = '```bash\necho {"name":"bash","arguments":{"command":"ls"}}\n```';
	const result = parseToolFences(input, TOOLS);
	assertEqual(result.toolCalls, [], "bash fence ignored");
}

// 16. No allow-list accepts any name
{
	const input = '<tool_call>{"name":"custom_tool","arguments":{"x":1}}</tool_call>';
	const result = parseToolFences(input);
	assertEqual(result.toolCalls, [{ name: "custom_tool", arguments: { x: 1 } }], "no allow-list: accepts any name");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);