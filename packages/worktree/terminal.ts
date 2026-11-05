/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

/** Stable terminal IDs persisted with a managed checkout. */
export interface TerminalTarget {
	sessionId: string;
	windowId: string;
	blockId?: string;
}

/** Terminal operations shared by the worktree commands and model tools. */
export interface WorktreeTerminal {
	label: string;
	registryFile: string;
	findMany(checkouts: Array<{ path: string; terminal?: TerminalTarget }>): Promise<Map<string, TerminalTarget>>;
	spawn(worktreePath: string, branch: string, signal?: AbortSignal): Promise<TerminalTarget>;
	close(worktreePath: string, recorded?: TerminalTarget): Promise<void>;
	rename(worktreePath: string, branch: string, recorded?: TerminalTarget): Promise<void>;
	switch(target: TerminalTarget): Promise<string>;
	describe(target: TerminalTarget): string;
}
