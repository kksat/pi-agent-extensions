/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Pi has no global tool-renderer override, and codemode belongs to a separate
// extension. Hide its entire ToolExecutionComponent instead of re-registering
// the tool or replacing its executor. This includes the shell, output, images,
// and leading spacer, including on rows restored before /calm was toggled.
// Verified against Pi 1.0.0: ToolExecutionComponent.render(width) and its runtime
// toolName field. The caller catches a missing render seam independently of
// Calm's other adapters. Export/share rendering bypasses Calm via the same
// visibility policy as the existing assistant and operational-user adapters.
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { calmPresentationHides } from "./fm-calm-visibility.ts";

type CalmToolLayoutPatch = {
  hidesCodemode: () => boolean;
};
const CALM_TOOL_LAYOUT_PATCH = Symbol.for("firstmate:calm-codemode-layout:v1");

export function installCalmToolLayout(): void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: CalmToolLayoutPatch | undefined;
  };
  const hidesCodemode = (): boolean => calmPresentationHides("assistant-tool-call");
  const installed = registry[CALM_TOOL_LAYOUT_PATCH];
  if (installed) {
    // Reload creates fresh module-local visibility state. Refresh the callback,
    // rather than stacking wrappers or leaving existing rows bound to old state.
    installed.hidesCodemode = hidesCodemode;
    return;
  }

  const ToolExecutionComponent = PiCodingAgent.ToolExecutionComponent;
  if (typeof ToolExecutionComponent !== "function") {
    throw new Error("Firstmate Calm requires Pi ToolExecutionComponent");
  }
  const originalRender = ToolExecutionComponent.prototype.render;
  if (typeof originalRender !== "function") {
    throw new Error("Firstmate Calm requires Pi ToolExecutionComponent.render");
  }
  const patch: CalmToolLayoutPatch = { hidesCodemode };
  ToolExecutionComponent.prototype.render = function (width: number): string[] {
    const state = this as unknown as { toolName?: string };
    if (state.toolName === "codemode" && patch.hidesCodemode()) return [];
    return originalRender.call(this, width);
  };
  registry[CALM_TOOL_LAYOUT_PATCH] = patch;
}
