/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Uses Pi's real tool row, not a mock renderer. Host peer dependencies must be
// available, as they are when Pi loads the extension through its jiti loader.
import assert from "node:assert/strict";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { installCalmToolLayout } from "./lib/fm-calm-tool-layout.ts";
import { setCalmPresentation, setCalmStockExportRendering } from "./lib/fm-calm-visibility.ts";

initTheme("dark", false);
const tui = { requestRender() {} } as TUI;
const args = { code: 'text("codemode output")' };
const result = { content: [{ type: "text", text: "codemode output" }], details: { nestedCalls: [{ name: "read" }] }, isError: false };
const row = new ToolExecutionComponent("codemode", "test-call", args, undefined, undefined, tui, process.cwd());
const other = new ToolExecutionComponent("unrelated-tool", "other-call", {}, undefined, undefined, tui, process.cwd());
const otherLines = other.render(80);
assert(row.render(80).some((line) => line.includes("codemode")), "baseline reproduces the visible codemode row");

try {
  setCalmPresentation(true);
  installCalmToolLayout();
  assert.deepEqual(row.render(80), [], "Calm hides a codemode row created before the adapter was installed");
  row.updateArgs(args);
  row.markExecutionStarted();
  row.setArgsComplete();
  row.updateResult(result, true);
  assert.deepEqual(row.render(80), [], "partial codemode output and its shell occupy zero rows");
  row.updateResult(result);
  row.setExpanded(true);
  row.invalidate();
  assert.deepEqual(row.render(40), [], "completed/expanded/resized codemode rows remain hidden");
  assert.equal((row as unknown as { args: unknown }).args, args, "arguments are never replaced");
  assert.equal((row as unknown as { result: unknown }).result, result, "results and nested-call metadata are never replaced");
  assert.deepEqual(other.render(80), otherLines, "unrelated extension tools keep their original rendering");

  setCalmPresentation(false);
  const stock = row.render(80);
  assert(stock.some((line) => line.includes("codemode output")), "Calm off restores the full result");
  setCalmPresentation(true);
  assert.deepEqual(row.render(80), [], "Calm on hides that same existing row again");
  setCalmStockExportRendering(true);
  assert.deepEqual(row.render(80), stock, "export/share mode gets the exact stock rendering");
  setCalmStockExportRendering(false);
  assert.deepEqual(row.render(80), [], "ending export returns immediately to hidden rendering");

  const render = ToolExecutionComponent.prototype.render;
  const patch = (globalThis as unknown as Record<symbol, { hidesCodemode: () => boolean }>)[Symbol.for("firstmate:calm-codemode-layout:v1")];
  patch.hidesCodemode = () => false;
  assert.deepEqual(row.render(80), stock, "an old policy callback can be replaced without changing the tool row");
  installCalmToolLayout();
  assert.equal(ToolExecutionComponent.prototype.render, render, "reload never stacks another render wrapper");
  assert.deepEqual(row.render(80), [], "reload refreshes the visibility callback for existing rows");

  const selfRendered = new ToolExecutionComponent("codemode", "self-call", args, undefined, {
    renderShell: "self",
    renderCall: () => new Text("custom codemode call", 0, 0),
    renderResult: () => new Text("custom codemode output", 0, 0),
  }, tui, process.cwd());
  selfRendered.updateResult(result);
  assert.deepEqual(selfRendered.render(80), [], "custom self-rendering codemode definitions are also hidden");
  setCalmPresentation(false);
  assert(selfRendered.render(80).some((line) => line.includes("custom codemode output")), "custom renderers are preserved when Calm is off");

  setCalmPresentation(true);
  row.updateResult({ ...result, isError: true });
  assert.deepEqual(row.render(80), [], "failed codemode rows are hidden like the other tool rows");
  setCalmPresentation(false);
  assert(row.render(80).some((line) => line.includes("codemode output")), "the failed result remains available when Calm is off");
  console.log("Calm codemode layout checks passed against Pi's real ToolExecutionComponent.");
} finally {
  setCalmPresentation(false);
  setCalmStockExportRendering(false);
}
