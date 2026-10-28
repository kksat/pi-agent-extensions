/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type ScrollView, type TUI } from "@earendil-works/pi-tui";

type MessageRole = "user" | "assistant";
type Direction = -1 | 1;

interface MessageStart {
	component: Component;
	role: MessageRole;
	row: number;
}

interface LayoutBox {
	component: Component;
	rect: { width: number };
	children: LayoutBox[];
	scrollView?: ScrollView;
}

// Pi exposes scrolling on ScrollView, but not the active transcript layout to
// extensions. Keep the read-only Pi 1.4 fullscreen adapter isolated here.
type TranscriptTUI = TUI & {
	currentLayout?: { root: LayoutBox; primaryScrollView?: ScrollView };
};

function findScrollBox(box: LayoutBox, scrollView: ScrollView): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = findScrollBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

function getMessageStarts(document: Component, width: number): MessageStart[] {
	const starts: MessageStart[] = [];
	const visit = (component: Component, row: number): number => {
		// Only plain, unmodified Containers concatenate without extra padding.
		// Render all other components as opaque rows, once per navigation pass.
		if (component instanceof Container && component.constructor === Container &&
			component.render === Container.prototype.render) {
			let height = 0;
			for (const child of component.children) height += visit(child, row + height);
			return height;
		}
		const lines = component.render(width);
		if (lines.length === 0) return 0;
		if (component instanceof UserMessageComponent) {
			starts.push({ component, role: "user", row });
		} else if (component instanceof AssistantMessageComponent) {
			// Like Pi's native prompt jumps, skip tool-use narration and tool-only
			// turns: only answer rows carry the OSC 133 prompt-start marker.
			if (/^\x1b\]133;A(?:\x07|\x1b\\)/.test(lines[0]!)) {
				starts.push({ component, role: "assistant", row });
			}
		}
		return lines.length;
	};
	visit(document, 0);
	return starts;
}

/** Navigates the conversation transcript in fullscreen mode. */
export class TranscriptNavigator {
	private lastJump?: { scrollView: ScrollView; component: Component; scrollTop: number };
	private tui: TUI;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	/** Scrolls by count lines or half-pages, using the current transcript viewport height. */
	scroll(direction: Direction, unit: "line" | "halfPage", count = 1): void {
		if (this.tui.mode !== "fullscreen") return;
		const scrollView = (this.tui as TranscriptTUI).currentLayout?.primaryScrollView;
		if (!scrollView) return;

		const step = unit === "line" ? 1 : Math.max(1, Math.floor(scrollView.viewportHeight / 2));
		this.lastJump = undefined;
		scrollView.scrollBy(direction * step * count);
		this.tui.requestRender();
	}

	/** Scrolls to the transcript start or end; the end resumes following new output. */
	jumpToBoundary(boundary: "start" | "end"): void {
		if (this.tui.mode !== "fullscreen") return;
		const scrollView = (this.tui as TranscriptTUI).currentLayout?.primaryScrollView;
		if (!scrollView) return;

		this.lastJump = undefined;
		if (boundary === "start") scrollView.scrollToStart();
		else scrollView.scrollToEnd();
		this.tui.requestRender();
	}

	/** Moves by up to count matching messages; does nothing at a transcript boundary. */
	jump(role: MessageRole, direction: Direction, count = 1): void {
		if (this.tui.mode !== "fullscreen") return;
		const layout = (this.tui as TranscriptTUI).currentLayout;
		const scrollView = layout?.primaryScrollView;
		if (!layout || !scrollView) return;
		const box = findScrollBox(layout.root, scrollView);
		const document = box?.children[0]?.component;
		if (!box || !document) return;

		const starts = getMessageStarts(document, scrollView.getContentWidth(box.rect.width));
		let anchor = scrollView.scrollTop;
		// Near the end, ScrollView clamps several message starts to the same
		// scrollTop. Retain the selected message so repeated jumps still advance.
		const lastJump = this.lastJump;
		if (lastJump?.scrollView === scrollView &&
			lastJump.scrollTop === scrollView.scrollTop && !scrollView.isFollowingEnd) {
			anchor = starts.find((start) => start.component === lastJump.component)?.row ?? anchor;
		}
		const candidates = starts.filter((start) => start.role === role &&
			(direction < 0 ? start.row < anchor : start.row > anchor));
		if (direction < 0) candidates.reverse();
		const target = candidates[Math.min(count, candidates.length) - 1];
		if (!target) return;

		scrollView.scrollTo(target.row, { disableFollow: true });
		this.lastJump = { scrollView, component: target.component, scrollTop: scrollView.scrollTop };
		this.tui.requestRender();
	}
}
