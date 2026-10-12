/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import calm from "./index.ts";
import { calmPresentationIsActive } from "./lib/fm-calm-visibility.ts";
import { CALM_WORKING_SHIP_WIDGET_KEY } from "./lib/fm-calm-working-ship.ts";

const home = mkdtempSync(join(tmpdir(), "calm-extension-test-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const handlers = new Map<string, (...args: any[]) => any>();
const commands = new Map<string, { handler: (...args: any[]) => any }>();
const registrations: unknown[] = [];
const events: unknown[] = [];
const widgets = new Map<string, unknown>();
let workingVisible = true;
const statuses: unknown[] = [];
const ui = {
  setWidget: (key: string, widget: unknown) => widgets.set(key, widget),
  setWorkingVisible: (visible: boolean) => { workingVisible = visible; },
  setHiddenThinkingLabel() {},
  setStatus: (...args: unknown[]) => statuses.push(args),
  onTerminalInput: () => () => {},
  notify: () => { throw new Error("Unexpected warning or notification"); },
  // Intentionally no setToolsExpanded(): /calm must not emit expansion notices
  // just to force a redraw, nor change the user's expansion preference.
};
const ctx = { ui, mode: "tui" };
try {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const preference = join(home, ".pi", "agent", "calm");
  writeFileSync(preference, "on\n");
  calm({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: unknown) => registrations.push(tool),
    registerEntryRenderer() {},
    registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command),
    events: { emit: (...args: unknown[]) => events.push(args) },
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  assert.equal(registrations.length, 0, "all-tool rendering must not claim other extensions' tools");
  handlers.get("session_start")!({}, ctx);
  assert.equal(calmPresentationIsActive(), true, "saved preference restored");
  handlers.get("agent_start")!({}, ctx);
  assert.equal(workingVisible, false, "stock working indicator replaced");
  assert.equal(typeof widgets.get(CALM_WORKING_SHIP_WIDGET_KEY), "function");
  await commands.get("calm")!.handler("", ctx);
  assert.equal(calmPresentationIsActive(), false);
  assert.equal(readFileSync(preference, "utf8"), "off\n");
  assert.equal(workingVisible, true);
  await commands.get("calm")!.handler("", ctx);
  assert.equal(calmPresentationIsActive(), true);
  assert.equal(readFileSync(preference, "utf8"), "on\n");
  assert.equal(registrations.length, 0, "activation never takes over built-in names either");
  assert.equal(workingVisible, false);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(workingVisible, true);
  assert.equal(widgets.get(CALM_WORKING_SHIP_WIDGET_KEY), undefined);
  assert(events.length > 0 && statuses.length > 0, "state changes publish and request redraws");
  handlers.get("session_shutdown")!({}, ctx);
  console.log("Calm extension lifecycle and no-tool-ownership checks passed.");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
