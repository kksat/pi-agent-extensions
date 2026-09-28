/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Notify cmux when a Pi turn has fully stopped and is waiting for the user.
 *
 * `agent_settled` is the point where retries, compaction, and queued follow-ups
 * will not continue on their own. The OSC 777 sequence is written to /dev/tty
 * because Pi owns stdout. Inside tmux it is wrapped so tmux passthrough
 * (`allow-passthrough all`) delivers it to cmux from this pane.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function cmuxNotify(title: string, body: string): void {
	const safe = (s: string) => s.replace(/[;\x1b\x07]/g, " ");
	const osc = `\x1b]777;notify;${safe(title)};${safe(body)}\x07`;
	// Double the OSC's ESC inside tmux's passthrough wrapper.
	const seq = process.env.TMUX ? `\x1bPtmux;\x1b${osc}\x1b\\` : osc;
	const fd = openSync("/dev/tty", "w");
	try {
		writeSync(fd, seq);
	} finally {
		closeSync(fd);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", () => {
		try {
			cmuxNotify("pi", "Needs your input");
		} catch {
			// No controlling tty, or the write was rejected. Don't fail the turn.
		}
	});
}
