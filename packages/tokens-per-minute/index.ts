/**
 * Tokens-per-minute footer extension.
 *
 * Tracks assistant message token usage over a rolling 60-second window and
 * shows the current input/output token rate in the bottom status bar.
 *
 * Rendered as: ⚡ in 12.3k | out 456 tok/min
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WINDOW_MS = 60_000;
const REFRESH_MS = 2_000;

interface Sample {
	t: number;
	input: number;
	output: number;
}

function fmt(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return String(Math.round(n));
}

export default function (pi: ExtensionAPI) {
	const samples: Sample[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	function render(ctx: { ui: { setStatus: (k: string, v: string) => void; theme: { fg: (c: string, s: string) => string } } }) {
		const now = Date.now();
		while (samples.length > 0 && now - samples[0].t > WINDOW_MS) samples.shift();

		let input = 0;
		let output = 0;
		for (const s of samples) {
			input += s.input;
			output += s.output;
		}

		const theme = ctx.ui.theme;
		const label = theme.fg("dim", "⚡ ");
		const inPart = theme.fg("dim", "in ") + theme.fg("accent", fmt(input));
		const sep = theme.fg("dim", " | ");
		const outPart = theme.fg("dim", "out ") + theme.fg("accent", fmt(output));
		const unit = theme.fg("dim", " tok/min");

		ctx.ui.setStatus("tpm", label + inPart + sep + outPart + unit);
	}

	pi.on("session_start", async (_event, ctx) => {
		render(ctx);
		if (timer === undefined) {
			timer = setInterval(() => {
				try {
					render(ctx);
				} catch {
					// context may be stale after shutdown; timer is cleared below
				}
			}, REFRESH_MS);
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
		samples.length = 0;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;

		samples.push({
			t: Date.now(),
			input: usage.input ?? 0,
			output: usage.output ?? 0,
		});
		render(ctx);
	});
}
