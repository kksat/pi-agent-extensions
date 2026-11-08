/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import registerWorktree, { type WorktreeApi } from "../worktree/index.ts";
import type { WorktreeTerminal } from "../worktree/terminal.ts";
import { RexTerminal } from "./rex.ts";

/** Keybinding id for the switch hotkey. Remap or disable it in keybindings.json. */
const SWITCH_KEYBINDING = "worktree.switch";
const DEFAULT_SWITCH_KEYS: KeyId[] = ["alt+w"];

function switchKeyIds(): KeyId[] {
	try {
		const user = getKeybindings().getUserBindings()[SWITCH_KEYBINDING];
		if (user === undefined) return DEFAULT_SWITCH_KEYS;
		return Array.isArray(user) ? user : [user];
	} catch {
		// Without a terminal UI there is no keybindings manager; keep the default.
		return DEFAULT_SWITCH_KEYS;
	}
}

/**
 * Binds the switch hotkey: pressing it picks a worktree, then jumps to its Rex
 * tab, opening one when no tab runs in that checkout. Terminal input the key
 * does not match passes through untouched.
 */
export function registerSwitchHotkey(pi: ExtensionAPI, api: WorktreeApi): void {
	let removeInput: (() => void) | undefined;
	let switching = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		removeInput?.();
		removeInput = ctx.ui.onTerminalInput((data) => {
			if (!switchKeyIds().some((key) => matchesKey(data, key))) return undefined;
			if (switching) return { consume: true };
			switching = true;
			void api.switchWorktree(ctx).finally(() => {
				switching = false;
			});
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		removeInput?.();
		removeInput = undefined;
	});
}

export default function (pi: ExtensionAPI, terminal: WorktreeTerminal = new RexTerminal()) {
	registerSwitchHotkey(pi, registerWorktree(pi, terminal));
}
