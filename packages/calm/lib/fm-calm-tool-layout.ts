/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Hide every ToolExecutionComponent, regardless of tool name or owner, without
// re-registering tools or replacing executors. This includes built-ins, codemode,
// subagents, MCP tools, their shell, output, images, and leading spacer, including
// rows restored before /calm was toggled.
// Verified against Pi 1.1.0: ToolExecutionComponent.render(width). The caller
// catches a missing render seam independently of Calm's other adapters. Export/share rendering bypasses Calm via the same
// visibility policy as the existing assistant and operational-user adapters.
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { calmPresentationHides } from "./fm-calm-visibility.ts";

type CalmToolLayoutPatch = {
  hidesTools: () => boolean;
};
const CALM_TOOL_LAYOUT_PATCH = Symbol.for("firstmate:calm-tool-layout:v2");

export function installCalmToolLayout(): void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: CalmToolLayoutPatch | undefined;
  };
  const hidesTools = (): boolean => calmPresentationHides("assistant-tool-call");
  // A live /reload can leave the previous codemode-only wrapper in the chain.
  // Disable it so it cannot retain a stale policy, especially during export.
  const legacy = (globalThis as unknown as Record<symbol, { hidesCodemode: () => boolean }>)[
    Symbol.for("firstmate:calm-codemode-layout:v1")
  ];
  if (legacy) legacy.hidesCodemode = () => false;
  const installed = registry[CALM_TOOL_LAYOUT_PATCH];
  if (installed) {
    // Reload creates fresh module-local visibility state. Refresh the callback,
    // rather than stacking wrappers or leaving existing rows bound to old state.
    installed.hidesTools = hidesTools;
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
  const patch: CalmToolLayoutPatch = { hidesTools };
  ToolExecutionComponent.prototype.render = function (width: number): string[] {
    if (patch.hidesTools()) return [];
    return originalRender.call(this, width);
  };
  registry[CALM_TOOL_LAYOUT_PATCH] = patch;
}
