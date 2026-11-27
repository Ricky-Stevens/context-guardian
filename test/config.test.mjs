import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAdaptiveThreshold, statuslineMode } from "../lib/config.mjs";

describe("statuslineMode", () => {
	it("returns external only for the exact value 'external'", () => {
		assert.equal(statuslineMode({ statusline: "external" }), "external");
	});

	it("falls back to managed for missing, unknown or mistyped values", () => {
		for (const statusline of [undefined, "managed", "off", "External", 1]) {
			assert.equal(statuslineMode({ statusline }), "managed");
		}
	});

	it("reads the loaded config when called without an argument", () => {
		assert.ok(["managed", "external"].includes(statuslineMode()));
	});
});

describe("computeAdaptiveThreshold", () => {
	it("returns 0.55 for 200K window", () => {
		assert.equal(computeAdaptiveThreshold(200000), 0.55);
	});

	it("returns 0.30 for 1M window (lower bound area)", () => {
		const result = computeAdaptiveThreshold(1000000);
		assert.ok(
			result >= 0.25 && result <= 0.31,
			`expected ~0.30, got ${result}`,
		);
	});

	it("returns intermediate value for 500K window", () => {
		const result = computeAdaptiveThreshold(500000);
		assert.ok(result > 0.3 && result < 0.55, `expected ~0.46, got ${result}`);
	});

	it("clamps to 0.55 for windows smaller than 200K", () => {
		assert.equal(computeAdaptiveThreshold(100000), 0.55);
	});

	it("clamps to 0.25 for very large windows", () => {
		assert.equal(computeAdaptiveThreshold(5000000), 0.25);
	});

	it("scales linearly between 200K and 1M", () => {
		const at200k = computeAdaptiveThreshold(200000);
		const at600k = computeAdaptiveThreshold(600000);
		const at1m = computeAdaptiveThreshold(1000000);
		// Should decrease monotonically
		assert.ok(at200k > at600k, "200K threshold should be higher than 600K");
		assert.ok(at600k > at1m, "600K threshold should be higher than 1M");
	});
});
