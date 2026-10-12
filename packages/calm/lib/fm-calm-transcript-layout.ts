/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Hide non-conversation presentation without changing transcript entries, widget
// ownership/disposal, footer data, or delivery to the model. Leave command
// confirmations, warnings/errors, and interactive selectors/overlays alone.
// Verified against Pi 1.1.0's InteractiveMode presentation methods. Each row's
// render callback reads the current policy, so toggles and export work retroactively.
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { Spacer, type Component } from "@earendil-works/pi-tui";
import { CALM_ANIMATION_GALLERY_WIDGET_KEY } from "./fm-calm-animation-gallery.ts";
import { CALM_WORKING_SHIP_WIDGET_KEY } from "./fm-calm-working-ship.ts";
import { calmPresentationHides } from "./fm-calm-visibility.ts";

type PresentationMode = {
  chatContainer: { children: Component[] };
  footerDataProvider: { getExtensionStatuses(): ReadonlyMap<string, string> };
};
type PresentationMethod = (this: PresentationMode, ...args: any[]) => void;
type CalmTranscriptLayoutPatch = { hidesNoise: () => boolean };
const CALM_TRANSCRIPT_LAYOUT_PATCH = Symbol.for("firstmate:calm-transcript-layout:v1");
const VISIBLE_WIDGETS = new Set([CALM_WORKING_SHIP_WIDGET_KEY, CALM_ANIMATION_GALLERY_WIDGET_KEY]);

export function installCalmTranscriptLayout(): void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: CalmTranscriptLayoutPatch | undefined;
  };
  const hidesNoise = (): boolean => calmPresentationHides("custom-message");
  const installed = registry[CALM_TRANSCRIPT_LAYOUT_PATCH];
  if (installed) {
    installed.hidesNoise = hidesNoise;
    return;
  }
  const prototype = PiCodingAgent.InteractiveMode?.prototype as unknown as Record<string, PresentationMethod>;
  const methods = [
    "addMessageToChat", "addCustomEntryToChat", "renderWidgetContainer", "setExtensionStatus",
    "addCacheWarmingUsage", "addCompactionCostNotice", "addCacheMissNotice", "maybeShowThinkingDropNotice",
  ];
  for (const name of methods) {
    if (typeof prototype?.[name] !== "function") {
      throw new Error(`Firstmate Calm requires Pi InteractiveMode.${name}`);
    }
  }
  const rowClasses = [
    PiCodingAgent.BashExecutionComponent,
    PiCodingAgent.CustomMessageComponent,
    PiCodingAgent.CompactionSummaryMessageComponent,
    PiCodingAgent.BranchSummaryMessageComponent,
    PiCodingAgent.SkillInvocationMessageComponent,
  ];
  for (const component of rowClasses) {
    if (typeof component?.prototype.render !== "function") {
      throw new Error("Firstmate Calm requires Pi's non-conversation row renderers");
    }
  }
  const patch: CalmTranscriptLayoutPatch = { hidesNoise };
  // Inherited render methods must be shadowed on each specific class, never on
  // Container itself (that would hide dialogs, the editor, and genuine replies).
  for (const component of rowClasses) {
    const originalRender = component.prototype.render;
    component.prototype.render = function (width: number): string[] {
      return patch.hidesNoise() ? [] : originalRender.call(this, width);
    };
  }

  const wrapped = new WeakSet<Component>();
  const hideRow = (component: Component, shouldHide = (): boolean => true): void => {
    if (wrapped.has(component)) return;
    wrapped.add(component);
    const originalRender = component.render;
    component.render = function (width: number): string[] {
      return patch.hidesNoise() && shouldHide() ? [] : originalRender.call(this, width);
    };
  };
  const originalAddMessage = prototype.addMessageToChat;
  prototype.addMessageToChat = function (message, ...args) {
    const start = this.chatContainer.children.length;
    originalAddMessage.call(this, message, ...args);
    const added = this.chatContainer.children.slice(start);
    if (["custom", "bashExecution", "compactionSummary", "branchSummary"].includes(message.role)) {
      for (const component of added) hideRow(component);
    } else if (message.role === "user") {
      // Skill bodies are operational; preserve the separate genuine user prompt
      // Pi renders alongside them. Remove only the skill body's leading spacer.
      for (let index = 0; index < added.length; index++) {
        if (added[index] instanceof PiCodingAgent.SkillInvocationMessageComponent &&
            added[index - 1] instanceof Spacer) hideRow(added[index - 1]);
      }
    }
  };
  const originalAddEntry = prototype.addCustomEntryToChat;
  prototype.addCustomEntryToChat = function (...args) {
    // Custom entries can be inserted before the streaming assistant, not appended.
    const before = new Set(this.chatContainer.children);
    originalAddEntry.call(this, ...args);
    for (const component of this.chatContainer.children) {
      if (!before.has(component)) hideRow(component);
    }
  };
  for (const name of methods.slice(4)) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      const start = this.chatContainer.children.length;
      original.call(this, ...args);
      for (const component of this.chatContainer.children.slice(start)) hideRow(component);
    };
  }

  const originalRenderWidgets = prototype.renderWidgetContainer;
  prototype.renderWidgetContainer = function (container, widgets: Map<string, Component>, ...args) {
    originalRenderWidgets.call(this, container, widgets, ...args);
    for (const [key, component] of widgets) {
      if (!VISIBLE_WIDGETS.has(key)) hideRow(component);
    }
    for (const component of container.children as Component[]) {
      if (component instanceof Spacer) {
        hideRow(component, () => ![...widgets.keys()].some((key) => VISIBLE_WIDGETS.has(key)));
      }
    }
  };
  const footerProviders = new WeakSet<object>();
  const originalSetStatus = prototype.setExtensionStatus;
  prototype.setExtensionStatus = function (...args) {
    const provider = this.footerDataProvider;
    if (!footerProviders.has(provider)) {
      footerProviders.add(provider);
      const originalStatuses = provider.getExtensionStatuses;
      provider.getExtensionStatuses = function () {
        return patch.hidesNoise() ? new Map<string, string>() : originalStatuses.call(this);
      };
    }
    originalSetStatus.call(this, ...args);
  };
  registry[CALM_TRANSCRIPT_LAYOUT_PATCH] = patch;
}
