/**
 * Open Current Folder in $EDITOR (Neovim)
 *
 * Shortcut: Ctrl+E
 *
 * This extension opens the current folder in $EDITOR (Neovim) with clean
 * terminal state management. When you close Neovim (:q, :qa, or ZZ),
 * you return immediately to Pi.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+e", {
		description: "Open the current folder in $EDITOR (Neovim)",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;

			const editor = process.env.EDITOR || "nvim";

			await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
				// 1. Stop Pi's TUI and release the terminal
				tui.stop();

				// 2. Clear screen and switch to normal terminal buffer
				process.stdout.write("\x1b[2J\x1b[H");

				try {
					// 3. Run editor synchronously with full interactive stdio
					const shell = process.env.SHELL || "/bin/sh";
					spawnSync(shell, ["-c", `exec "\$EDITOR" "\$1"`, "pi-open-folder", ctx.cwd], {
						stdio: "inherit",
						env: process.env,
					});
				} catch (err: any) {
					// Fallback direct execution
					try {
						spawnSync(editor, [ctx.cwd], {
							stdio: "inherit",
							env: process.env,
						});
					} catch {
						// Ignore
					}
				} finally {
					// 4. Restore Pi's TUI and re-render
					tui.start();
					tui.requestRender(true);
				}

				done();
				return { render: () => [], invalidate: () => {} };
			});
		},
	});
}
