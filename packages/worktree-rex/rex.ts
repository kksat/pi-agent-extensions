/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { TerminalTarget, WorktreeTerminal } from "../worktree/terminal.ts";

export type RexRun = (args: string[], signal?: AbortSignal) => Promise<string>;

const runRex: RexRun = (args, signal) => new Promise((resolve, reject) => {
	execFile("rex", ["--autostart=false", ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal }, (error, stdout, stderr) => {
		if (error) reject(new Error(stderr.trim() || error.message));
		else resolve(stdout.trim());
	});
});

interface RexBlock { block_id: string; creator_name: string; host_id?: string }
interface RexWindow {
	window_id: string;
	layers: Array<{ blocks: RexBlock[] }>;
}
interface RexSession { session_id: string; active_window_id?: string; windows: RexWindow[] }
interface RexIdentity { endpoint: string; host_id: string; session_id?: string }
interface LocatedWindow extends TerminalTarget { paths: string[]; blockIds: string[] }

function canonical(dir: string): string {
	try { return realpathSync(dir); } catch { return path.resolve(dir); }
}

function inside(root: string, child: string): boolean {
	const relative = path.relative(canonical(root), canonical(child));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function label(branch: string): string {
	return `wt:${branch.replace(/[\/\\:*?"<>|]/g, "-")}`;
}

/** Uses the installed Rex CLI, never tmux or Rex's private server socket. */
export class RexTerminal implements WorktreeTerminal {
	readonly label = "Rex";
	readonly registryFile = "worktrees-rex.json";

	private run: RexRun;
	private env: NodeJS.ProcessEnv;

	constructor(run: RexRun = runRex, env: NodeJS.ProcessEnv = process.env) {
		this.run = run;
		this.env = env;
	}

	private async json<T>(args: string[], signal?: AbortSignal): Promise<T> {
		return JSON.parse(await this.run(args, signal)) as T;
	}

	private async identity(signal?: AbortSignal): Promise<RexIdentity> {
		const identity = await this.json<RexIdentity>(["whoami", "--json"], signal);
		// Git and the registry are local. Never open a local checkout on a remote server.
		if (!identity.endpoint?.startsWith("unix://")) throw new Error("worktree-rex requires a local Rex server (unix:// endpoint).");
		return identity;
	}

	private async windows(): Promise<LocatedWindow[]> {
		const identity = await this.identity();
		const { sessions } = await this.json<{ sessions: Array<{ session_id: string }> }>(["ls", "--json"]);
		const windows: LocatedWindow[] = [];
		for (const { session_id } of sessions) {
			const session = await this.json<RexSession>(["session", "inspect", session_id, "--json"]);
			for (const window of session.windows) {
				const blocks = window.layers.flatMap((layer) => layer.blocks)
					.filter((block) => block.creator_name === "com.superlogical.terminal" && block.host_id === identity.host_id);
				const paths: string[] = [];
				for (const block of blocks) {
					try {
						const process = await this.json<{ foreground?: { cwd?: string } | null; child?: { cwd?: string } | null }>([
							"block", "call", "-s", session_id, "-b", block.block_id, "process",
						]);
						const cwd = process.foreground?.cwd ?? process.child?.cwd;
						if (cwd) paths.push(cwd);
					} catch (error) {
						// Ignore a block that exited during discovery, not access or connection failures.
						if (!/not found|does not exist|no such block/i.test(String(error))) throw error;
					}
				}
				windows.push({ sessionId: session_id, windowId: window.window_id, blockId: blocks[0]?.block_id,
					paths, blockIds: window.layers.flatMap((layer) => layer.blocks.map((block) => block.block_id)) });
			}
		}
		return windows;
	}

	private matches(window: LocatedWindow, root: string, recorded?: TerminalTarget): boolean {
		return (recorded?.sessionId === window.sessionId && recorded.windowId === window.windowId) ||
			window.paths.some((cwd) => inside(root, cwd));
	}

	async findMany(checkouts: Array<{ path: string; terminal?: TerminalTarget }>): Promise<Map<string, TerminalTarget>> {
		const targets = new Map<string, TerminalTarget>();
		if (!checkouts.length) return targets;
		// One server snapshot per list operation, regardless of the number of worktrees.
		const windows = await this.windows();
		for (const checkout of checkouts) {
			const recorded = checkout.terminal;
			const found = windows.find((window) => recorded?.sessionId === window.sessionId && recorded.windowId === window.windowId) ??
				windows.find((window) => this.matches(window, checkout.path));
			if (found) targets.set(checkout.path, { sessionId: found.sessionId, windowId: found.windowId, blockId: found.blockId });
		}
		return targets;
	}

	async find(worktreePath: string, recorded?: TerminalTarget): Promise<TerminalTarget | undefined> {
		return (await this.findMany([{ path: worktreePath, terminal: recorded }])).get(worktreePath);
	}

	async spawn(worktreePath: string, branch: string, signal?: AbortSignal): Promise<TerminalTarget> {
		const identity = await this.identity(signal);
		const sessionId = identity.session_id;
		// A stale inherited ID must not redirect work into some other active session.
		if (this.env.REX_SESSION && this.env.REX_SESSION !== sessionId) throw new Error("REX_SESSION is stale or unavailable; check rex whoami --json.");
		const args = sessionId
			? ["window", "new", "-s", sessionId, label(branch), "--focus=false"]
			: ["new", `pi-wt-${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`, "--window", label(branch)];
		const created = await this.json<{
			session_id?: string; window_id?: string; block_ids?: string[];
			initial_windows?: Array<{ window_id: string; block_ids: string[] }>;
		}>([...args, "-c", worktreePath, "--keep-open", "--json", "--", "pi", "--name", `wt:${branch}`], signal);
		const window = created.initial_windows?.[0] ?? created;
		const target = { sessionId: created.session_id ?? sessionId, windowId: window.window_id, blockId: window.block_ids?.[0] };
		if (!target.sessionId || !target.windowId || !target.blockId) {
			throw new Error("Rex did not return session, window, and block IDs. Inspect Rex before retrying to avoid duplicate tabs.");
		}
		return { sessionId: target.sessionId, windowId: target.windowId, blockId: target.blockId };
	}

	async close(worktreePath: string, recorded?: TerminalTarget): Promise<void> {
		const windows = (await this.windows()).filter((window) => this.matches(window, worktreePath, recorded));
		// Never disconnect the agent before it can finish removing the checkout and recording the result.
		if (windows.some((window) => window.blockIds.includes(this.env.REX_BLOCK ?? ""))) {
			throw new Error("Cannot close the Rex tab running this agent. Remove this worktree from another tab.");
		}
		for (const window of windows) {
			await this.run(["window", "close", "-s", window.sessionId, window.windowId]);
		}
	}

	async rename(worktreePath: string, branch: string, recorded?: TerminalTarget): Promise<void> {
		const target = await this.find(worktreePath, recorded);
		if (target) await this.run(["window", "rename", "-s", target.sessionId, target.windowId, label(branch)]);
	}

	async switch(target: TerminalTarget): Promise<string> {
		await this.identity();
		await this.run(["focus", "-s", target.sessionId, target.windowId]);
		const session = await this.json<RexSession>(["session", "inspect", target.sessionId, "--json"]);
		if (session.active_window_id !== target.windowId) throw new Error("Rex did not activate the requested tab.");
		if (target.sessionId !== this.env.REX_SESSION) {
			// Let the CLI reject ambiguous clients rather than guessing which app to switch.
			const client = this.env.REX_CLIENT ? ["-C", this.env.REX_CLIENT] : [];
			await this.run([...client, "do", "session.select", `session_id=${target.sessionId}`, `window_id=${target.windowId}`]);
		}
		return `Switched to Rex tab ${target.windowId} in session ${target.sessionId}.`;
	}

	describe(target: TerminalTarget): string {
		return `Rex tab: ${target.windowId}\nSession: ${target.sessionId}\nSwitch with: /worktree switch, or rex focus -s ${target.sessionId} ${target.windowId}`;
	}
}
