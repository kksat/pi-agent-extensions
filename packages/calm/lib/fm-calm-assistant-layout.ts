// Presentation-only assistant filtering. Keep final/streaming replies, but hide
// all thinking and tool-use narration, regardless of its length or formatting.
// Original messages, context, storage, and exports are never modified.
// Verified against Pi 1.1.0: AssistantMessageComponent.updateContent(), including
// its optional streaming argument, and lastMessage for rebuilds on /calm toggles.
import type { AssistantMessageComponent as PiAssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { calmPresentationHides } from "./fm-calm-visibility.ts";

type AssistantMessage = Parameters<PiAssistantMessageComponent["updateContent"]>[0];
type CalmAssistantLayoutPatch = {
  hidesThinking: () => boolean;
  hidesWorkingNote: () => boolean;
};
const CALM_ASSISTANT_LAYOUT_PATCH = Symbol.for("firstmate:calm-assistant-layout:v2");

export function installCalmAssistantLayout(): void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: CalmAssistantLayoutPatch | undefined;
  };
  // Disable the old threshold-based wrapper after a live upgrade. Its closure
  // cannot be upgraded just by refreshing its visibility callbacks.
  const legacy = registry[Symbol.for("firstmate:calm-assistant-layout:pi-0.81.1")];
  if (legacy) {
    legacy.hidesThinking = () => false;
    legacy.hidesWorkingNote = () => false;
  }
  const hidesThinking = (): boolean => calmPresentationHides("assistant-thinking");
  const hidesWorkingNote = (): boolean => calmPresentationHides("assistant-working-note");
  const installed = registry[CALM_ASSISTANT_LAYOUT_PATCH];
  if (installed) {
    installed.hidesThinking = hidesThinking;
    installed.hidesWorkingNote = hidesWorkingNote;
    return;
  }

  const AssistantMessageComponent = PiCodingAgent.AssistantMessageComponent;
  if (typeof AssistantMessageComponent !== "function") {
    throw new Error("Firstmate Calm requires Pi AssistantMessageComponent");
  }
  const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
  if (typeof originalUpdateContent !== "function") {
    throw new Error("Firstmate Calm requires Pi AssistantMessageComponent.updateContent");
  }
  const originalRender = AssistantMessageComponent.prototype.render;
  if (typeof originalRender !== "function") {
    throw new Error("Firstmate Calm requires Pi AssistantMessageComponent.render");
  }
  const patch: CalmAssistantLayoutPatch = { hidesThinking, hidesWorkingNote };
  const renderedPolicies = new WeakMap<object, string>();
  const policyKey = (): string => `${patch.hidesThinking()}:${patch.hidesWorkingNote()}`;
  AssistantMessageComponent.prototype.updateContent = function (
    message: AssistantMessage,
    isStreaming?: boolean,
  ): void {
    const hideThinking = patch.hidesThinking();
    const hasToolCalls = message.content.some((block) => block.type === "toolCall");
    const hideWorkingNote = patch.hidesWorkingNote() &&
      (message.stopReason === "toolUse" || hasToolCalls);
    // Pi normally reports abort/error only on tool rows when calls exist. Those
    // rows are hidden now, so let the assistant row surface the actionable failure.
    const showFailure = patch.hidesWorkingNote() &&
      (message.stopReason === "aborted" || message.stopReason === "error");
    const presentationMessage = hideThinking || hideWorkingNote || showFailure
      ? {
          ...message,
          content: message.content.filter((block) =>
            !(hideThinking && block.type === "thinking") &&
            !(hideWorkingNote && block.type === "text") &&
            !(showFailure && block.type === "toolCall"),
          ),
        }
      : message;
    originalUpdateContent.call(this, presentationMessage, isStreaming);
    // Pi rebuilds the presentation from this field on toggle, resize, and theme
    // changes. Retain the unfiltered message so hidden content can be restored.
    (this as unknown as { lastMessage: AssistantMessage }).lastMessage = message;
    renderedPolicies.set(this, policyKey());
  };
  AssistantMessageComponent.prototype.render = function (width: number): string[] {
    // Exports and /reload can change the policy without a content update. Rebuild
    // only on policy transitions, not on every animation tick or terminal render.
    const state = this as unknown as { lastMessage?: AssistantMessage };
    if (state.lastMessage && renderedPolicies.get(this) !== policyKey()) {
      this.updateContent(state.lastMessage);
    }
    return originalRender.call(this, width);
  };
  registry[CALM_ASSISTANT_LAYOUT_PATCH] = patch;
}
