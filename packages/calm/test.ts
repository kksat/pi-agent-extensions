/* SPDX-License-Identifier: GPL-3.0-only
SPDX-FileCopyrightText: 2026 Kirill Satarin (@kksat)
*/

// Self-running checks for Calm's working-animation catalogue. Run with:
//   node --experimental-strip-types packages/calm/test.ts
// or through pi's jiti loader.

import {
	CALM_ANIMATIONS,
	CALM_ANIMATION_NAMES,
	createCalmAnimationSprite,
	createRandomCalmAnimationSprite,
} from "./lib/fm-calm-animations.ts";
import { createCalmWorkingShipAnimationFor } from "./lib/fm-calm-working-ship.ts";

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
	assertEqual(CALM_ANIMATIONS.length, 20, "catalogue holds 20 scenes");
	assertEqual(new Set(CALM_ANIMATION_NAMES).size, 20, "scene names are unique");
	assertEqual(CALM_ANIMATION_NAMES.length, CALM_ANIMATIONS.length, "names match catalogue");
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

// Test 7: random selection can reach every scene
{
	const seen = new Set<string>();
	for (let draw = 0; draw < 5000; draw += 1) {
		seen.add(createRandomCalmAnimationSprite().name);
	}
	assertEqual(seen.size, CALM_ANIMATIONS.length, "random selection covers every scene");
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

console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
	process.exit(1);
}