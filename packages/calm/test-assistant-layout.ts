/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installCalmAssistantLayout } from "./lib/fm-calm-assistant-layout.ts";
import { setCalmPresentation, setCalmStockExportRendering } from "./lib/fm-calm-visibility.ts";

type Message = Parameters<AssistantMessageComponent["updateContent"]>[0];
initTheme("dark", false);
const message = (content: Message["content"], stopReason: Message["stopReason"] = "stop"): Message => ({
  role: "assistant", content, stopReason, api: "openai-responses", provider: "openai", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: 0,
});
const toolCall = { type: "toolCall", id: "call", name: "agent-start", arguments: {} } as const;
const thinking = { type: "thinking", thinking: "private reasoning" } as const;
const final = message([thinking, { type: "text", text: "The final answer." }]);
const row = new AssistantMessageComponent(final, false);
const stock = row.render(80);
assert(stock.some((line) => line.includes("private reasoning")));

try {
  const legacy = { hidesThinking: () => true, hidesWorkingNote: () => true };
  const registry = globalThis as unknown as Record<symbol, unknown>;
  registry[Symbol.for("firstmate:calm-assistant-layout:pi-0.81.1")] = legacy;
  installCalmAssistantLayout();
  assert.equal(legacy.hidesThinking(), false);
  assert.equal(legacy.hidesWorkingNote(), false);
  setCalmPresentation(true);
  row.invalidate();
  assert(row.render(80).some((line) => line.includes("The final answer.")));
  assert(!row.render(80).some((line) => line.includes("private reasoning")), "thinking is hidden even when expanded");
  assert.equal((row as unknown as { lastMessage: Message }).lastMessage, final, "original message retained");

  for (const text of ["Short note", "Long narration ".repeat(40), "Multiline\nnarration"]) {
    const working = message([thinking, { type: "text", text }, toolCall], "toolUse");
    row.updateContent(working, true);
    assert.deepEqual(row.render(80), [], "all tool-use narration and its spacer are hidden");
    assert.equal((row as unknown as { lastMessage: Message }).lastMessage, working);
    assert.equal((row as unknown as { isStreaming: boolean }).isStreaming, true, "streaming argument forwarded");
    setCalmStockExportRendering(true);
    row.invalidate();
    assert(row.render(80).length > 0, "export restores working narration");
    setCalmStockExportRendering(false);
    row.invalidate();
    assert.deepEqual(row.render(40), []);
  }
  row.updateContent(message([thinking]), true);
  assert.deepEqual(row.render(80), [], "thinking-only streaming message occupies zero rows");
  row.updateContent(message([{ type: "text", text: "Streaming answer" }]), true);
  assert(row.render(80).some((line) => line.includes("Streaming answer")), "genuine text still streams");
  row.updateContent(message([{ type: "text", text: "Narration" }, toolCall]), true);
  assert.deepEqual(row.render(80), [], "once a tool call appears its narration disappears");
  for (const stopReason of ["aborted", "error", "length"] as const) {
    row.updateContent({ ...message([thinking, toolCall], stopReason), errorMessage: "Actionable failure" }, false);
    assert(row.render(80).some((line) => /Actionable failure|truncated/.test(line)), "run failure remains visible even with hidden tool calls");
  }
  row.updateContent(final, false);
  setCalmPresentation(false);
  assert.deepEqual(row.render(80), stock, "turning off restores the exact original presentation without invalidation");
  setCalmPresentation(true);
  setCalmStockExportRendering(true);
  row.invalidate();
  assert.deepEqual(row.render(80), stock, "export rendering is complete");
  setCalmStockExportRendering(false);
  assert(!row.render(80).some((line) => line.includes("private reasoning")), "ending export reapplies filtering without invalidation");
  const update = AssistantMessageComponent.prototype.updateContent;
  installCalmAssistantLayout();
  assert.equal(AssistantMessageComponent.prototype.updateContent, update, "reload does not stack wrappers");
  row.invalidate();
  assert(!row.render(80).some((line) => line.includes("private reasoning")));
  console.log("Calm assistant layout checks passed against Pi's real AssistantMessageComponent.");
} finally {
  setCalmPresentation(false);
  setCalmStockExportRendering(false);
}
