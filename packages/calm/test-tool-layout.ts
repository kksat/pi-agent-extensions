/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Exercise Pi's real rows, including tools owned by other extensions and names
// not registered yet (e.g. MCP tools in a restored session).
import assert from "node:assert/strict";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { installCalmToolLayout } from "./lib/fm-calm-tool-layout.ts";
import { setCalmPresentation, setCalmStockExportRendering } from "./lib/fm-calm-visibility.ts";

initTheme("dark", false);
const tui = { requestRender() {} } as TUI;
const args = { description: "subagent task", code: 'text("tool output")' };
const result = {
  content: [{ type: "text", text: "tool output" }],
  details: { nestedCalls: [{ name: "read" }] },
  isError: false,
};
const names = [
  "codemode", "read", "bash", "edit", "write", "grep", "find", "ls",
  "agent-start", "agent-check", "agent-wait-any", "agent-send", "subagent",
  "worktree_create", "mcp__unknown__tool", "unrelated-tool",
];
const rows = names.map((name, index) => new ToolExecutionComponent(
  name, `call-${index}`, args, undefined, undefined, tui, process.cwd(),
));
for (const row of rows) assert(row.render(80).length > 0, "baseline tool calls are visible");

try {
  // Simulate the previous version installed in a process before /reload.
  const legacy = { hidesCodemode: () => true };
  const registry = globalThis as unknown as Record<symbol, unknown>;
  registry[Symbol.for("firstmate:calm-codemode-layout:v1")] = legacy;
  installCalmToolLayout();
  assert.equal(legacy.hidesCodemode(), false, "upgrade disables the stale codemode-only policy");
  setCalmPresentation(true);
  for (const row of rows) {
    assert.deepEqual(row.render(80), [], "existing rows of every tool are hidden");
    row.updateArgs(args);
    row.markExecutionStarted();
    row.setArgsComplete();
    row.updateResult(result, true);
    assert.deepEqual(row.render(80), [], "partial output and shell occupy zero rows");
    row.updateResult(result);
    row.setExpanded(true);
    row.invalidate();
    assert.deepEqual(row.render(40), [], "completed/expanded/resized rows remain hidden");
    assert.equal((row as unknown as { args: unknown }).args, args);
    assert.equal((row as unknown as { result: unknown }).result, result, "results and nested metadata are intact");
  }
  setCalmPresentation(false);
  const stock = rows.map((row) => row.render(80));
  for (const lines of stock) assert(lines.some((line) => line.includes("tool output")), "off restores every result");
  setCalmPresentation(true);
  setCalmStockExportRendering(true);
  rows.forEach((row, index) => assert.deepEqual(row.render(80), stock[index], "export gets exact stock rendering"));
  setCalmStockExportRendering(false);
  for (const row of rows) assert.deepEqual(row.render(80), [], "ending export hides rows immediately");

  const render = ToolExecutionComponent.prototype.render;
  const patch = registry[Symbol.for("firstmate:calm-tool-layout:v2")] as { hidesTools: () => boolean };
  patch.hidesTools = () => false;
  assert.deepEqual(rows[0].render(80), stock[0]);
  installCalmToolLayout();
  assert.equal(ToolExecutionComponent.prototype.render, render, "reload never stacks another wrapper");
  for (const row of rows) assert.deepEqual(row.render(80), [], "reload refreshes existing rows' policy");

  for (const renderShell of ["self", "default"] as const) {
    const custom = new ToolExecutionComponent("agent-start", renderShell, args, undefined, {
      renderShell,
      renderCall: () => new Text("custom subagent call", 0, 0),
      renderResult: () => new Text("custom subagent output", 0, 0),
    }, tui, process.cwd());
    custom.updateResult(result);
    assert.deepEqual(custom.render(80), [], "custom subagent renderers are hidden");
    setCalmPresentation(false);
    assert(custom.render(80).some((line) => line.includes("custom subagent output")));
    setCalmPresentation(true);
  }
  const imageResult = {
    ...result,
    content: [...result.content, { type: "image", mimeType: "image/png", data:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tZ8AAAAASUVORK5CYII=" }],
  };
  rows[0].updateResult(imageResult);
  assert.deepEqual(rows[0].render(80), [], "tool images cannot escape the hidden row");
  assert.equal((rows[0] as unknown as { result: unknown }).result, imageResult, "image data is retained");
  for (const row of rows) {
    const failed = { ...result, isError: true };
    row.updateResult(failed);
    assert.deepEqual(row.render(80), [], "tool failures are hidden but not deleted");
    assert.equal((row as unknown as { result: unknown }).result, failed);
  }
  console.log("Calm all-tool layout checks passed against Pi's real ToolExecutionComponent.");
} finally {
  setCalmPresentation(false);
  setCalmStockExportRendering(false);
}
