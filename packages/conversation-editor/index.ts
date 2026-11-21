/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/**
 * Open the whole conversation in an external editor for reading and copying.
 *
 * Shortcut: ctrl+alt+g (override with the PI_CONVERSATION_EDITOR_KEY env var).
 * Like the built-in ctrl+g prompt editor, pi suspends while the editor runs.
 *
 * The document opens where the transcript is on screen: in fullscreen mode the
 * transcript scroll position is mapped to a document line, in regular mode the
 * conversation ends at the bottom of the terminal, so the document opens at the
 * end. An HTML comment marks the anchored position for editors without
 * line-positioning support.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, type TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anchorLineFor,
	editorLaunch,
	insertAnchor,
	renderConversation,
} from "./conversation.mjs";

const SHORTCUT = process.env.PI_CONVERSATION_EDITOR_KEY || "ctrl+alt+g";

/** Grab the current TUI via a custom() factory that closes immediately. */
async function captureTui(ui: ExtensionUIContext): Promise<TUI | undefined> {
	try {
		// The factory receives the live TUI; done() is called synchronously, so
		// the empty component is never mounted and the editor text is untouched.
		return await ui.custom<TUI>(async (tui, _theme, _keybindings, done) => {
			done(tui);
			return { render: () => [] as string[] };
		});
	} catch {
		return undefined;
	}
}

/** Find the primary transcript ScrollView in the component tree, if any. */
function findTranscriptScrollView(tui: TUI): ScrollView | undefined {
	const seen = new Set<unknown>();
	const queue: unknown[] = [...(tui.children ?? [])];
	const layoutRoot = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
	if (layoutRoot) queue.push(layoutRoot);

	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (node instanceof ScrollView) {
			if ((node as unknown as { primary?: boolean }).primary) return node;
			continue;
		}
		const children = (node as unknown as { children?: unknown[] }).children;
		if (Array.isArray(children)) queue.push(...children);
	}
	return undefined;
}

/**
 * Fraction of the transcript currently on screen (0 = top, 1 = bottom).
 * Falls back to 1 (bottom) when there is no live transcript scroll view,
 * which is the regular (non-fullscreen) mode: the conversation ends at the
 * bottom of the terminal there.
 */
function scrollFraction(tui: TUI): number {
	try {
		const scrollView = findTranscriptScrollView(tui);
		if (!scrollView) return 1;
		if (scrollView.isFollowingEnd) return 1;
		const contentHeight = (scrollView as unknown as { contentHeight?: number }).contentHeight;
		if (typeof contentHeight !== "number" || contentHeight <= 0) return 1;
		const viewportCenter = scrollView.scrollTop + scrollView.viewportHeight / 2;
		return Math.min(1, Math.max(0, viewportCenter / contentHeight));
	} catch {
		return 1;
	}
}

export default function (pi: ExtensionAPI) {
	let inFlight = false;

	pi.registerShortcut(SHORTCUT, {
		description: "Open the whole conversation in an external editor",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || inFlight) return;
			inFlight = true;
			try {
				const tui = await captureTui(ctx.ui);
				if (!tui) {
					ctx.ui.notify("conversation-editor: no TUI available", "error");
					return;
				}

				const fraction = scrollFraction(tui);
				const manager = ctx.sessionManager;
				const text = renderConversation(manager.getBranch(), {
					sessionName: manager.getSessionName() ?? manager.getSessionId(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				});
				const totalLines = text.split("\n").length;
				const anchored = insertAnchor(text, anchorLineFor(fraction, totalLines));

				const command = process.env.VISUAL || process.env.EDITOR || "nano";
				const directory = mkdtempSync(join(tmpdir(), "pi-conversation-"));
				const file = join(directory, "conversation.md");
				writeFileSync(file, anchored.text, "utf-8");

				let failure: string | undefined;
				tui.stop();
				try {
					const launch = editorLaunch(command, file, anchored.line);
					process.stdout.write(`Opening conversation in: ${command}\nPi will resume when the editor exits.\n`);
					const exit = await new Promise<number | null>((resolve) => {
						const child = spawn(launch.command, launch.args, { stdio: "inherit" });
						child.on("error", () => resolve(null));
						child.on("close", (code) => resolve(code ?? 0));
					});
					if (exit === null) failure = `failed to launch ${command}`;
				} finally {
					rmSync(directory, { recursive: true, force: true });
					tui.start();
					tui.requestRender(true);
				}
				if (failure) ctx.ui.notify(`conversation-editor: ${failure}`, "error");
			} catch (error) {
				ctx.ui.notify(`conversation-editor: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				inFlight = false;
			}
		},
	});
}
