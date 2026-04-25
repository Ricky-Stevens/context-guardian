import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompactionStats } from "../lib/stats.mjs";

describe("formatCompactionStats", () => {
	it("computes correct stats for normal case", () => {
		// 400 bytes / 4 = 100 estimated checkpoint tokens
		const content = "x".repeat(400);
		const { stats } = formatCompactionStats(1000, 10000, content);

		assert.equal(stats.preTokens, 1000);
		assert.equal(stats.checkpointTokens, 100);
		assert.equal(stats.maxTokens, 10000);
		// No overhead passed → removed = preTokens - checkpoint = 900
		assert.equal(stats.removed, 900);
		assert.equal(stats.prePct, 10.0);
	});

	it("subtracts baseline overhead from removed count", () => {
		// preTokens=1000 includes baseline=300 + content=700.
		// Checkpoint=100 tokens. Removed conversation = 700-100 = 600.
		const content = "x".repeat(400); // 100 tokens
		const { stats } = formatCompactionStats(1000, 10000, content, {
			overhead: 300,
		});
		assert.equal(stats.removed, 600);
	});

	it("clamps removed to 0 when checkpoint+overhead > preTokens", () => {
		const content = "x".repeat(2000); // 500 estimated tokens
		const { stats } = formatCompactionStats(100, 10000, content);
		assert.equal(stats.removed, 0);
	});

	it("handles preTokens = 0 gracefully", () => {
		const content = "x".repeat(400);
		const { stats, block } = formatCompactionStats(0, 10000, content);

		assert.equal(stats.removed, 0);
		assert.equal(stats.prePct, 0);
		assert.ok(block.includes("unknown (token data unavailable)"));
		assert.ok(block.includes("Stripped:      unknown"));
	});

	it("box uses unified vocabulary, not the old After/Saved prediction", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(400));
		assert.ok(block.includes("Context usage:"));
		assert.ok(block.includes("Stripped:"));
		assert.ok(!block.includes("Before:"));
		assert.ok(!block.includes("After:"));
		assert.ok(!block.includes("Saved:"));
		assert.ok(!block.includes("Removed:"));
	});

	it("box does not contain apply instructions (skill adds those)", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(!block.includes("/resume"));
	});

	it("block contains the box drawing characters", () => {
		const { block } = formatCompactionStats(1000, 10000, "x".repeat(100));
		assert.ok(block.startsWith("┌"));
		assert.ok(block.includes("└"));
		assert.ok(block.includes("Compaction Stats"));
	});

	it("box does not render MB lines (those were confusing)", () => {
		// Bytes still flow back through stats for logging, but the rendered
		// box should not include Session/Snapshot/MB lines.
		const content = "x".repeat(400);
		const prePayloadBytes = 15 * 1024 * 1024;
		const { stats, block } = formatCompactionStats(1000, 10000, content, {
			prePayloadBytes,
		});

		assert.ok(!block.includes("Session size:"));
		assert.ok(!block.includes("Snapshot size:"));
		assert.ok(!block.includes("MB"));
		// Stats object still exposes the byte counts for callers that log them
		assert.equal(stats.prePayloadBytes, prePayloadBytes);
		assert.equal(stats.postPayloadBytes, 400);
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
