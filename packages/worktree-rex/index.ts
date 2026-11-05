/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerWorktree from "../worktree/index.ts";
import { RexTerminal } from "./rex.ts";

export default function (pi: ExtensionAPI) {
	registerWorktree(pi, new RexTerminal());
}
