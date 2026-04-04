import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompactionStats } from "../lib/stats.mjs";

describe("formatCompactionStats", () => {
	it("computes correct stats for normal case", () => {
		// 400 bytes / 4 = 100 estimated post-tokens
		const content = "x".repeat(400);
		const { stats } = formatCompactionStats(1000, 10000, content);

		assert.equal(stats.preTokens, 1000);
		assert.equal(stats.postTokens, 100);
		assert.equal(stats.maxTokens, 10000);
		assert.equal(stats.saved, 900);
		assert.equal(stats.savedPct, 90.0);
		assert.equal(stats.prePct, 10.0);
		assert.equal(stats.postPct, 1.0);
	});

	it("clamps saved to 0 when post > pre", () => {
		// postTokens will be larger than preTokens
		const content = "x".repeat(2000); // 500 estimated tokens
		const { stats } = formatCompactionStats(100, 10000, content);

		assert.equal(stats.saved, 0);
		assert.equal(stats.savedPct, 0);
	});

	it("handles preTokens = 0 gracefully", () => {
		const content = "x".repeat(400);
		const { stats, block } = formatCompactionStats(0, 10000, content);

		assert.equal(stats.saved, 0);
		assert.equal(stats.prePct, 0);
		assert.ok(block.includes("unknown (token data unavailable)"));
		assert.ok(block.includes("Saved:   unknown"));
	});

	it("box does not contain apply instructions (skill adds those)", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(!block.includes("/resume"));
	});

	it("handles maxTokens = 0 without crashing", () => {
		const { stats } = formatCompactionStats(1000, 0, "x".repeat(100));
		assert.equal(stats.postPct, 0);
	});

	it("block contains the box drawing characters", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(block.startsWith("┌"));
		assert.ok(block.includes("└"));
		assert.ok(block.includes("Compaction Stats"));
		assert.ok(block.includes("Compaction Stats"));
	});

	it("includes payload line when prePayloadBytes provided", () => {
		const content = "x".repeat(400);
		const prePayloadBytes = 15 * 1024 * 1024; // 15MB
		const { stats, block } = formatCompactionStats(1000, 10000, content, {
			prePayloadBytes,
		});

		assert.ok(block.includes("Session:"));
		assert.ok(block.includes("15.0MB"));
		assert.equal(stats.prePayloadBytes, prePayloadBytes);
		assert.equal(stats.postPayloadBytes, 400); // content byte length
	});

	it("omits payload line when prePayloadBytes is 0", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(!block.includes("Session:"));
	});

	it("omits session line when both prePayloadBytes and overhead are 0", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(!block.includes("Session:"));
	});

	it("stats include payload byte values", () => {
		const content = "x".repeat(800);
		const { stats } = formatCompactionStats(1000, 10000, content, {
			prePayloadBytes: 5000000,
		});
		assert.equal(stats.prePayloadBytes, 5000000);
		assert.equal(stats.postPayloadBytes, 800);
	});
});
