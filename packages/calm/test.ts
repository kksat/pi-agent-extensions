/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Self-running checks for Calm's working-animation catalogue. Run with:
//   node --experimental-strip-types packages/calm/test.ts
// or through pi's jiti loader.

import { mock } from "node:test";
import { createCalmAnimationGallery } from "./lib/fm-calm-animation-gallery.ts";
import {
	CALM_ANIMATIONS,
	CALM_ANIMATION_NAMES,
	CALM_PROGRESS_ANIMATION_NUMBERS,
	CALM_WORKING_ANIMATION_NUMBERS,
	CALM_WORKING_ANIMATIONS,
	createCalmAnimationSprite,
	createRandomCalmAnimationSprite,
} from "./lib/fm-calm-animations.ts";
import {
	CALM_WORKING_SHIP_TICK_MS,
	createCalmWorkingShipAnimationFor,
	createCalmWorkingShipWidget,
} from "./lib/fm-calm-working-ship.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${msg}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
	const act = JSON.stringify(actual);
	const exp = JSON.stringify(expected);
	if (act === exp) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${msg} (got ${act}, expected ${exp})`);
	}
}

const ANSI = /\u001b\[[0-9;]*m/g;
const WIDTHS = [0, 1, 2, 3, 5, 10, 20, 40, 80, 200];

// Test 1: catalogue shape
{
	assertEqual(CALM_ANIMATIONS.length, 25, "catalogue holds 20 originals plus five progress scenes");
	assertEqual(new Set(CALM_ANIMATION_NAMES).size, 25, "scene names are unique");
	assertEqual(CALM_ANIMATION_NAMES.length, CALM_ANIMATIONS.length, "names match catalogue");
	assertEqual(CALM_ANIMATION_NAMES.slice(0, 20), ["sailboat", "fish", "duck", "clouds", "stars", "moon", "rain", "snow", "ball", "pendulum", "spinner", "progress", "pulse", "wave", "rocket", "balloon", "butterfly", "cat", "coffee", "windmill"], "the original 20 numbers never change");
	assertEqual(CALM_ANIMATION_NAMES.slice(20), ["scanner", "conveyor", "comet", "segments", "zipper"], "new bars occupy stable numbers 21–25");
}

// Test 2: every scene renders at every width for a full animation cycle
{
	let renderFailures = 0;
	let widthFailures = 0;
	for (let index = 0; index < CALM_ANIMATIONS.length; index += 1) {
		const sprite = createCalmAnimationSprite(index);
		const animation = createCalmWorkingShipAnimationFor(sprite);
		for (const width of WIDTHS) {
			for (let tick = 0; tick < 60; tick += 1) {
				let lines: string[];
				try {
					lines = animation.render(width);
				} catch {
					renderFailures++;
					break;
				}
				for (const line of lines) {
					const visible = line.replace(ANSI, "");
					if (Array.from(visible).length > width) widthFailures++;
				}
				animation.tick();
			}
		}
	}
	assertEqual(renderFailures, 0, "no scene throws while rendering");
	assertEqual(widthFailures, 0, "no scene paints past the requested width");
}

// Test 3: freeze, resume, clamp, and reset are safe for every scene
{
	let failures = 0;
	for (let index = 0; index < CALM_ANIMATIONS.length; index += 1) {
		const sprite = createCalmAnimationSprite(index);
		try {
			sprite.frame(40);
			sprite.tick();
			sprite.tick();
			sprite.restoreLastRendered();
			sprite.clampToWidth(10);
			sprite.frame(10);
			sprite.reset();
			sprite.frame(40);
		} catch {
			failures++;
		}
	}
	assertEqual(failures, 0, "freeze/resume/clamp/reset never throw");
}

// Test 4: restoreLastRendered rewinds to the last painted frame
{
	const sprite = createCalmAnimationSprite(1);
	const animation = createCalmWorkingShipAnimationFor(sprite);
	const before = animation.render(40);
	animation.tick();
	animation.tick();
	animation.tick();
	animation.restoreLastRendered();
	assertEqual(animation.render(40), before, "restoreLastRendered rewinds the scene");
}

// Test 5: reset returns to the initial frame
{
	const sprite = createCalmAnimationSprite(1);
	const animation = createCalmWorkingShipAnimationFor(sprite);
	const initial = animation.render(40);
	for (let tick = 0; tick < 7; tick += 1) animation.tick();
	animation.reset();
	assertEqual(animation.render(40), initial, "reset returns to the initial frame");
}

// Test 6: deterministic index selection wraps
{
	assertEqual(createCalmAnimationSprite(0).name, CALM_ANIMATION_NAMES[0], "index 0 selects first");
	assertEqual(
		createCalmAnimationSprite(CALM_ANIMATIONS.length).name,
		CALM_ANIMATION_NAMES[0],
		"index past the end wraps",
	);
	assertEqual(
		createCalmAnimationSprite(-1).name,
		CALM_ANIMATION_NAMES[CALM_ANIMATIONS.length - 1],
		"negative index wraps",
	);
}

// Test 7: random selection keeps the preferred originals and new progress bars
{
	const seen = new Set<string>();
	for (let draw = 0; draw < 5000; draw += 1) {
		seen.add(createRandomCalmAnimationSprite().name);
	}
	assertEqual([...seen].sort(), CALM_WORKING_ANIMATIONS.map((scene) => scene.name).sort(), "random selection covers only the preferred scenes");
	assertEqual(CALM_WORKING_ANIMATION_NUMBERS, [1, 2, 3, 9, 11, 12, 14, 17, 18, 21, 22, 23, 24, 25], "rotation keeps preferred originals and adds the five new bars");
	assertEqual(CALM_PROGRESS_ANIMATION_NUMBERS, [12, 21, 22, 23, 24, 25], "progress preview includes bar 12 and the five new bars");
	assert(CALM_WORKING_ANIMATIONS.every((scene) => WIDTHS.every((width) => scene.create().frame(width).length <= 2)), "every working scene occupies at most two rows");
}

// Test 8: instances are independent
{
	const first = createCalmAnimationSprite(1);
	const second = createCalmAnimationSprite(1);
	for (let tick = 0; tick < 5; tick += 1) first.tick();
	assert(
		JSON.stringify(first.frame(40)) !== JSON.stringify(second.frame(40)),
		"two instances of one scene keep independent state",
	);
}

// Test 9: the live gallery has all labels and fits through resize boundaries
{
	const animation = createCalmWorkingShipAnimationFor(createCalmAnimationGallery());
	let widthFailures = 0;
	let missingLabels = 0;
	for (const width of [...WIDTHS, 15, 16, 34, 35, 53, 54, 72, 73, 91, 92, 120]) {
		for (let tick = 0; tick < 60; tick += 1) {
			const lines = animation.render(width).map((line) => line.replace(ANSI, ""));
			if (width === 0 && lines.length !== 0) widthFailures++;
			if (lines.some((line) => Array.from(line).length !== width)) widthFailures++;
			if (width >= 16) {
				const labels = lines.join("\n").match(/\[\d{2}\] [a-z]+/g) ?? [];
				if (JSON.stringify(labels) !== JSON.stringify(CALM_ANIMATION_NAMES.map(
					(name, index) => `[${String(index + 1).padStart(2, "0")}] ${name}`,
				))) missingLabels++;
			}
			animation.tick();
		}
	}
	assertEqual(widthFailures, 0, "gallery rows exactly fit the width, including resize boundaries");
	assertEqual(missingLabels, 0, "gallery numbers and names match all 25 scenes in stable order");
	assert(animation.render(80).length <= 24, "80-column reference gallery stays compact");
}

// Test 10: the gallery uses the real frames and advances every scene together
{
	const gallery = createCalmWorkingShipAnimationFor(createCalmAnimationGallery());
	const scenes = CALM_ANIMATIONS.map((definition) => createCalmWorkingShipAnimationFor(definition.create()));
	let mismatches = 0;
	for (let tick = 0; tick < 60; tick += 1) {
		// At 20 columns, one cell per row makes every scene directly comparable.
		const actual = gallery.render(20).slice(1, -1).map((line) => line.replace(ANSI, ""));
		const expected = scenes.flatMap((scene, index) => [
			`[${String(index + 1).padStart(2, "0")}] ${scene.name}`.padEnd(20),
			...scene.render(20).map((line) => line.replace(ANSI, "").padEnd(20)),
		]);
		if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches++;
		gallery.tick();
		for (const scene of scenes) scene.tick();
	}
	assertEqual(mismatches, 0, "every preview matches its actual working animation over 60 ticks");
}

// Test 11: gallery state is independent, and freeze/reset keep their usual contract
{
	const gallery = createCalmWorkingShipAnimationFor(createCalmAnimationGallery());
	const other = createCalmWorkingShipAnimationFor(createCalmAnimationGallery());
	const initial = gallery.render(80);
	for (let tick = 0; tick < 7; tick += 1) gallery.tick();
	const advanced = gallery.render(80);
	assert(JSON.stringify(advanced) !== JSON.stringify(initial), "gallery visibly animates");
	assertEqual(other.render(80), initial, "preview instances keep independent state");
	gallery.tick();
	gallery.tick();
	gallery.restoreLastRendered();
	assertEqual(gallery.render(80), advanced, "gallery freezes at its last painted frame");
	gallery.clampToWidth(20);
	assert(gallery.render(20).length > 0, "gallery safely reflows while frozen");
	gallery.reset();
	assertEqual(gallery.render(80), initial, "gallery reset returns every scene to its initial frame");
}

// Test 12: the shared widget scheduler animates the gallery and stops on disposal
{
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		let renders = 0;
		const tui = { requestRender: () => { renders++; } } as Parameters<typeof createCalmWorkingShipWidget>[0];
		const widget = createCalmWorkingShipWidget(tui, createCalmWorkingShipAnimationFor(createCalmAnimationGallery()));
		const initial = widget.render(80);
		mock.timers.tick(CALM_WORKING_SHIP_TICK_MS);
		assertEqual(renders, 1, "one shared preview timer requests one render per tick");
		assert(JSON.stringify(widget.render(80)) !== JSON.stringify(initial), "widget timer advances the live gallery");
		widget.dispose();
		widget.dispose();
		mock.timers.tick(CALM_WORKING_SHIP_TICK_MS * 10);
		assertEqual(renders, 1, "idempotent disposal stops preview render requests");
		assertEqual(widget.render(80), [], "disposed gallery paints nothing");
	} finally {
		mock.timers.reset();
	}
}

// Test 13: filtered previews preserve numbers, and focus mode uses the whole width
{
	const preferred = createCalmWorkingShipAnimationFor(createCalmAnimationGallery({ numbers: CALM_WORKING_ANIMATION_NUMBERS }));
	const labels = preferred.render(80).join("\n").replace(ANSI, "").match(/\[\d{2}\] [a-z]+/g) ?? [];
	assertEqual(labels, CALM_WORKING_ANIMATION_NUMBERS.map((number) => `[${String(number).padStart(2, "0")}] ${CALM_ANIMATIONS[number - 1].name}`), "shortlist preview preserves catalogue numbering");
	assert(preferred.render(80).length <= 14, "default working preview stays compact at 80 columns");
	let mismatches = 0;
	for (const number of CALM_WORKING_ANIMATION_NUMBERS) {
		const preview = createCalmWorkingShipAnimationFor(createCalmAnimationGallery({ numbers: [number], fullWidth: true }));
		const original = createCalmWorkingShipAnimationFor(createCalmAnimationSprite(number - 1));
		for (const width of WIDTHS) {
			for (let tick = 0; tick < 20; tick += 1) {
				const lines = preview.render(width).map((line) => line.replace(ANSI, ""));
				const expected = original.render(width).map((line) => line.replace(ANSI, "").padEnd(width));
				if (width > 0 && JSON.stringify(lines.slice(1, -1)) !== JSON.stringify(expected)) mismatches++;
				if (width === 0 && lines.length !== 0) mismatches++;
				if (lines.length > 4) mismatches++;
				preview.tick();
				original.tick();
			}
		}
	}
	assertEqual(mismatches, 0, "focused previews match full-width working frames and use at most four rows including labels");
}

// Test 14: the more-visible spinner sweeps the whole track in one row
{
	const spinner = createCalmAnimationSprite(10);
	const positions = new Set<number>();
	let frameFailures = 0;
	for (let tick = 0; tick < 160; tick += 1) {
		const frame = spinner.frame(40);
		const line = frame[0].map((run) => run.text).join("");
		positions.add(line.search(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/));
		if (frame.length !== 1 || Array.from(line).length !== 40 || !line.includes("[ ") || !line.includes(" ]")) frameFailures++;
		if (!frame[0].some((run) => run.color === "bright" && run.text.length > 0)) frameFailures++;
		spinner.tick();
	}
	assertEqual(frameFailures, 0, "spinner is bright, bracketed, full-width, and one row tall");
	assert(positions.has(2) && positions.has(37) && positions.size === 36, "spinner visits every position from left edge to right edge");
}

// Test 15: every new bar uses one full-width row and visibly moves through all quarters
{
	for (let number = 21; number <= 25; number += 1) {
		let geometryFailures = 0;
		let visibilityFailures = 0;
		let motionFailures = 0;
		const animation = createCalmAnimationSprite(number - 1);
		for (const width of [...WIDTHS, 4, 6, 7, 16, 100]) {
			animation.reset();
			const frames = new Set<string>();
			const quarters = new Set<number>();
			for (let tick = 0; tick < 128; tick += 1) {
				const frame = animation.frame(width);
				if (width === 0) {
					if (frame.length !== 0) geometryFailures++;
				} else {
					const row = frame[0];
					const line = row.map((run) => run.text).join("");
					frames.add(JSON.stringify(row));
					if (frame.length !== 1 || Array.from(line).length !== width || line.includes(" ")) geometryFailures++;
					if (width >= 4 && (line[0] !== "[" || line[width - 1] !== "]")) geometryFailures++;
					if (!row.some((run) => ["bright", "accent", "green"].includes(run.color) && run.text.length > 0)) visibilityFailures++;
					let column = 0;
					for (const run of row) {
						for (const _glyph of Array.from(run.text)) {
							if (["bright", "accent", "green"].includes(run.color) && width >= 10 && column > 0 && column < width - 1) {
								quarters.add(Math.min(3, Math.floor((column - 1) * 4 / (width - 2))));
							}
							column++;
						}
					}
				}
				animation.tick();
			}
			// A ten-column segmented bar fits only two packets; wider tracks
			// must expose at least four distinct animation frames.
			if (width >= 10 && (frames.size < (width < 20 ? 2 : 4) || quarters.size !== 4)) motionFailures++;
		}
		assertEqual(geometryFailures, 0, `${animation.name}: exactly one full-width row, including tiny widths`);
		assertEqual(visibilityFailures, 0, `${animation.name}: visible highlight on every non-empty frame`);
		assertEqual(motionFailures, 0, `${animation.name}: motion reaches all four screen quarters`);
		animation.reset();
		const initial = animation.frame(80);
		for (let tick = 0; tick < 19; tick += 1) animation.tick();
		const advanced = animation.frame(80);
		animation.tick();
		animation.tick();
		animation.restoreLastRendered();
		assertEqual(animation.frame(80), advanced, `${animation.name}: freeze returns to the last visible frame`);
		animation.reset();
		assertEqual(animation.frame(80), initial, `${animation.name}: reset returns to the initial frame`);
	}
}

// Test 16: the progress comparison is full-width, not squeezed into gallery cells
{
	const gallery = createCalmWorkingShipAnimationFor(createCalmAnimationGallery({ numbers: CALM_PROGRESS_ANIMATION_NUMBERS, fullWidth: true }));
	const scenes = CALM_PROGRESS_ANIMATION_NUMBERS.map((number) => createCalmWorkingShipAnimationFor(createCalmAnimationSprite(number - 1)));
	let mismatches = 0;
	for (let tick = 0; tick < 128; tick += 1) {
		const lines = gallery.render(100).map((line) => line.replace(ANSI, ""));
		const expected = scenes.flatMap((scene, index) => [
			`[${String(CALM_PROGRESS_ANIMATION_NUMBERS[index]).padStart(2, "0")}] ${scene.name}`.padEnd(100),
			...scene.render(100).map((line) => line.replace(ANSI, "").padEnd(100)),
		]);
		if (JSON.stringify(lines.slice(1, -1)) !== JSON.stringify(expected)) mismatches++;
		gallery.tick();
		for (const scene of scenes) scene.tick();
	}
	assertEqual(mismatches, 0, "progress comparison preserves the true terminal width over two cycles");
	assertEqual(gallery.render(100).length, 14, "six full-width bar previews use 14 rows including labels and help");
}

console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
	process.exit(1);
}