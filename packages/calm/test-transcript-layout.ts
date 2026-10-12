/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import assert from "node:assert/strict";
import { getMarkdownTheme, initTheme, InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { CALM_ANIMATION_GALLERY_WIDGET_KEY } from "./lib/fm-calm-animation-gallery.ts";
import { CALM_WORKING_SHIP_WIDGET_KEY } from "./lib/fm-calm-working-ship.ts";
import { installCalmTranscriptLayout } from "./lib/fm-calm-transcript-layout.ts";
import { setCalmPresentation, setCalmStockExportRendering } from "./lib/fm-calm-visibility.ts";

initTheme("dark", false);
// Use the real host methods and components without starting a terminal/session.
const mode = Object.create(InteractiveMode.prototype);
for (const key of ["session", "settingsManager"]) {
  Object.defineProperty(mode, key, { value: undefined, writable: true });
}
const statuses = new Map<string, string>();
const history: string[] = [];
Object.assign(mode, {
  chatContainer: new Container(), ui: { requestRender() {} }, outputPad: 1,
  toolOutputExpanded: false, editor: { addToHistory: (text: string) => history.push(text) },
  footerDataProvider: {
    getExtensionStatuses: () => statuses,
    setExtensionStatus: (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
  },
  getMarkdownThemeWithSettings: getMarkdownTheme, getMarkdownTransformers: () => [],
  getUserMessageText: (message: { content: string }) => message.content,
  session: { extensionRunner: {
    getMessageRenderer: () => undefined,
    getEntryRenderer: () => () => new Text("custom entry details", 0, 0),
  } },
  settingsManager: { getShowCacheMissNotices: () => true },
});

try {
  installCalmTranscriptLayout();
  // Include real side-agent message types, and an unknown extension type: this
  // must not depend on maintaining a list of particular subagent extensions.
  for (const customType of ["side-agent-prompt", "side-agent-status", "side-agents-report", "other-extension"]) {
    mode.addMessageToChat({ role: "custom", customType, content: "subagent operational detail", display: true });
  }
  mode.addMessageToChat({ role: "compactionSummary", summary: "summary", tokensBefore: 1000 });
  mode.addMessageToChat({ role: "branchSummary", summary: "branch summary" });
  mode.addMessageToChat({ role: "bashExecution", command: "echo output", output: "output", exitCode: 0 });
  mode.addCustomEntryToChat({ type: "custom", customType: "extension-entry", data: {} });
  mode.addCacheMissNotice({ missedTokens: 50_000, missedCost: 1, modelChanged: false, idleMs: 0 });
  mode.addCacheWarmingUsage({ usage: { cost: { total: 0.1 }, cacheRead: 1000, cacheWrite: 0 } });
  mode.addCompactionCostNotice({ source: "auto", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } });
  const stock = mode.chatContainer.render(80);
  assert(stock.some((line: string) => line.includes("subagent operational detail")));
  assert(stock.some((line: string) => line.includes("custom entry details")));
  const originalChildren = [...mode.chatContainer.children];
  setCalmPresentation(true);
  assert.deepEqual(mode.chatContainer.render(80), [], "routine rows and external leading spacers all disappear");
  assert.deepEqual(mode.chatContainer.children, originalChildren, "no transcript components are deleted");
  mode.chatContainer.invalidate();
  assert.deepEqual(mode.chatContainer.render(40), [], "invalidating and resizing do not reveal noise");
  setCalmStockExportRendering(true);
  assert.deepEqual(mode.chatContainer.render(80), stock, "export gets exact stock rows");
  setCalmStockExportRendering(false);
  setCalmPresentation(false);
  assert.deepEqual(mode.chatContainer.render(80), stock, "off restores existing rows");

  mode.chatContainer.clear();
  mode.addMessageToChat({ role: "user", content: "My genuine prompt" }, { populateHistory: true });
  mode.addMessageToChat({ role: "user", content: '<skill name="test" location="/tmp/test">\nOperational skill body\n</skill>\n\nMy skill arguments' }, { populateHistory: true });
  const userRows = mode.chatContainer.children.filter((component: unknown) => component instanceof UserMessageComponent);
  const genuineLines = userRows.flatMap((component: UserMessageComponent) => ["", ...component.render(80)]);
  setCalmPresentation(true);
  const live = mode.chatContainer.render(80);
  assert(live.some((line: string) => line.includes("My genuine prompt")));
  assert(live.some((line: string) => line.includes("My skill arguments")));
  assert(!live.some((line: string) => line.includes("[skill]")), "skill body hidden, user's arguments preserved");
  assert.equal(history.length, 2, "user history populated normally");
  assert(live.length <= genuineLines.length, "no orphan skill spacer");
  mode.showStatus("Session exported to: /tmp/session.html");
  mode.showWarning("Approval required");
  mode.showError("Provider unavailable");
  const required = mode.chatContainer.render(80).join("\n");
  assert(required.includes("Session exported to:"), "command confirmation remains visible");
  assert(required.includes("Approval required"), "warnings remain visible");
  assert(required.includes("Provider unavailable"), "errors remain visible");

  const widgets = new Map([
    ["subagent-progress", new Text("subagent progress", 0, 0)],
    [CALM_WORKING_SHIP_WIDGET_KEY, new Text("working animation", 0, 0)],
    [CALM_ANIMATION_GALLERY_WIDGET_KEY, new Text("requested preview", 0, 0)],
  ]);
  const widgetContainer = new Container();
  mode.renderWidgetContainer(widgetContainer, widgets, true, true);
  const widgetLines = widgetContainer.render(80).join("\n");
  assert(!widgetLines.includes("subagent progress"));
  assert(widgetLines.includes("working animation"));
  assert(widgetLines.includes("requested preview"), "explicit Calm preview stays visible");
  const hiddenWidgets = new Map([["other-progress", new Text("noise", 0, 0)]]);
  const hiddenContainer = new Container();
  mode.renderWidgetContainer(hiddenContainer, hiddenWidgets, true, true);
  assert.deepEqual(hiddenContainer.render(80), [], "hidden widgets have no leading spacer");
  assert.equal(hiddenWidgets.size, 1, "widget ownership and disposal are untouched");
  setCalmPresentation(false);
  assert(widgetContainer.render(80).join("\n").includes("subagent progress"));
  assert(hiddenContainer.render(80).join("\n").includes("noise"));

  mode.setExtensionStatus("side-agents", "running agent");
  assert.equal(mode.footerDataProvider.getExtensionStatuses(), statuses);
  setCalmPresentation(true);
  assert.equal(mode.footerDataProvider.getExtensionStatuses().size, 0, "routine extension footer statuses hidden");
  assert.equal(statuses.get("side-agents"), "running agent", "status state retained");
  mode.setExtensionStatus("side-agents", "agent finished");
  setCalmStockExportRendering(true);
  assert.equal(mode.footerDataProvider.getExtensionStatuses().get("side-agents"), "agent finished");
  setCalmStockExportRendering(false);

  // Entries inserted before a streaming row must also be hidden without hiding
  // or removing the existing genuine conversation.
  mode.streamingComponent = userRows[0];
  mode.addCustomEntryToChat({ type: "custom", customType: "inserted-entry", data: {} });
  assert(!mode.chatContainer.render(80).join("\n").includes("custom entry details"));
  assert(mode.chatContainer.render(80).join("\n").includes("My genuine prompt"));
  const addMessage = mode.addMessageToChat;
  const patch = (globalThis as unknown as Record<symbol, { hidesNoise: () => boolean }>)[
    Symbol.for("firstmate:calm-transcript-layout:v1")
  ];
  patch.hidesNoise = () => false;
  assert(mode.chatContainer.render(80).join("\n").includes("custom entry details"));
  installCalmTranscriptLayout();
  assert(!mode.chatContainer.render(80).join("\n").includes("custom entry details"), "reload refreshes existing rows' callbacks");
  assert.equal(mode.addMessageToChat, addMessage, "reload does not stack presentation wrappers");
  console.log("Calm transcript-noise checks passed against Pi's real InteractiveMode components.");
} finally {
  setCalmPresentation(false);
  setCalmStockExportRendering(false);
}
