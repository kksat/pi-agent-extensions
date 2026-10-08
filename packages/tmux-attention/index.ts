/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Add "● " to a tmux window when Pi has settled or opened a blocking UI prompt.
 * tmux hooks remove it when the window is selected or its client regains focus.
 * cmux notifications are handled separately by the cmux-notify package.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clear, installHooks, mark, windowForPane } from "./tmux-attention.mjs";

export default function (pi: ExtensionAPI) {
	let socket: string | undefined;
	let pane: string | undefined;
	let window: string | undefined;
	let unsubscribeInput: (() => void) | undefined;
	const owner = String(process.pid);

	function update(attention: boolean) {
		if (!socket || !pane) return;
		try {
			const current = windowForPane(socket, pane);
			if (window && window !== current) clear(socket, window, owner);
			window = current;
			if (attention) mark(socket, window, owner);
			else clear(socket, window, owner);
		} catch {
			// tmux failures must never interfere with the agent or a UI prompt.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const match = process.env.TMUX?.match(/^(.*),\d+,\d+$/);
		if (!match || !process.env.TMUX_PANE) return;
		try {
			installHooks(match[1]);
			socket = match[1];
			pane = process.env.TMUX_PANE;
			window = windowForPane(socket, pane);
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				if (data.includes("\x1b[I")) update(false);
				return undefined;
			});
		} catch {
			ctx.ui.notify("Could not enable tmux attention markers", "warning");
		}
	});

	pi.on("agent_settled", (event) => update(!event.aborted));
	pi.on("ui_prompt_start", () => update(true));
	pi.on("ui_prompt_end", () => update(false));
	pi.on("agent_start", () => update(false));
	pi.on("input", (event) => {
		if (event.source === "interactive") update(false);
	});
	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (socket && window) {
			try {
				clear(socket, window, owner);
			} catch {
				// The window/server may already have closed.
			}
		}
		socket = pane = window = undefined;
	});
}
