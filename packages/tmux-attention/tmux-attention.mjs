/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MARKER = "● ";
const STATE = "@pi_attention";
const HOOK_INDEX = 777001;
const HOOKS = ["session-window-changed", "client-session-changed", "client-attached", "client-focus-in"];

function tmux(socket, args) {
	return execFileSync("tmux", ["-S", socket, ...args], {
		encoding: "utf8",
		timeout: 2000,
		stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\n$/, "");
}

function quote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function localOption(socket, window, option) {
	// Without -A/-g, an empty result means the option was inherited.
	const value = tmux(socket, ["show-options", "-wqv", "-t", window, option]);
	return value || null;
}

function restoreOption(window, option, value) {
	return value === null
		? ["set-option", "-wu", "-t", window, option]
		: ["set-option", "-w", "-t", window, option, value];
}

function batch(socket, commands) {
	tmux(socket, commands.flatMap((command, index) => index ? [";", ...command] : command));
}

export function windowForPane(socket, pane) {
	if (!/^%\d+$/.test(pane)) throw new Error("Invalid tmux pane ID");
	return tmux(socket, ["display-message", "-p", "-t", pane, "#{window_id}"]);
}

export function installHooks(socket) {
	const script = fileURLToPath(import.meta.url);
	const command = [process.execPath, script, "clear", socket].map(quote).join(" ") + " '#{window_id}'";
	const hook = `if-shell -F '#{${STATE}}' ${quote(`run-shell -b ${quote(command)}`)}`;
	for (const name of HOOKS) {
		const existing = tmux(socket, ["show-options", "-gqv", `${name}[${HOOK_INDEX}]`]);
		// Reserve a separate array slot, never replace the user's other hooks.
		if (existing && !existing.includes(script)) throw new Error(`tmux hook slot ${name}[${HOOK_INDEX}] is occupied`);
		tmux(socket, ["set-hook", "-g", `${name}[${HOOK_INDEX}]`, hook]);
	}
}

export function mark(socket, window, owner) {
	if (!/^@\d+$/.test(window)) throw new Error("Invalid tmux window ID");
	const stored = localOption(socket, window, STATE);
	if (stored) {
		const state = JSON.parse(stored);
		if (!state.owners.includes(owner)) {
			state.owners.push(owner);
			tmux(socket, ["set-option", "-w", "-t", window, STATE, JSON.stringify(state)]);
		}
		return;
	}
	const name = tmux(socket, ["display-message", "-p", "-t", window, "#{window_name}"]);
	const state = {
		name,
		automaticRename: localOption(socket, window, "automatic-rename"),
		allowRename: localOption(socket, window, "allow-rename"),
		owners: [owner],
	};
	batch(socket, [
		["set-option", "-w", "-t", window, STATE, JSON.stringify(state)],
		["set-option", "-w", "-t", window, "allow-rename", "off"],
		// rename-window expands tmux formats even with an argv-based invocation.
		["rename-window", "-t", window, (MARKER + name).replace(/#/g, "##")],
	]);
}

export function clear(socket, window, owner) {
	if (!/^@\d+$/.test(window)) throw new Error("Invalid tmux window ID");
	const stored = localOption(socket, window, STATE);
	if (!stored) return;
	const state = JSON.parse(stored);
	if (owner !== undefined) {
		state.owners = state.owners.filter((item) => item !== owner);
		if (state.owners.length) {
			tmux(socket, ["set-option", "-w", "-t", window, STATE, JSON.stringify(state)]);
			return;
		}
	}
	const name = tmux(socket, ["display-message", "-p", "-t", window, "#{window_name}"]);
	const commands = [];
	// A manual/external rename during attention takes precedence over the snapshot.
	if (name === MARKER + state.name) {
		commands.push(["rename-window", "-t", window, state.name.replace(/#/g, "##")]);
		commands.push(restoreOption(window, "automatic-rename", state.automaticRename));
	} else if (name.startsWith(MARKER)) {
		commands.push(["rename-window", "-t", window, name.slice(MARKER.length).replace(/#/g, "##")]);
	}
	commands.push(restoreOption(window, "allow-rename", state.allowRename));
	commands.push(["set-option", "-wu", "-t", window, STATE]);
	batch(socket, commands);
}

// tmux runs this independently, so selecting a window clears its marker even
// while Pi is blocked in a dialog (or after Pi has exited unexpectedly).
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "clear") {
	try {
		clear(process.argv[3], process.argv[4]);
	} catch {
		// The pane/window/server may have disappeared since the hook fired.
	}
}
