/**
 * Full-session compaction verification test.
 *
 * Uses a real 30-message transcript captured from the manual compaction test.
 * Validates that all fictional facts survive extraction, noise is removed,
 * tiered compression is applied, and the output matches the saved checkpoint.
 *
 * @module full-session-test
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { extractConversation } from "../lib/transcript.mjs";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures");
const TRANSCRIPT_PATH = path.join(FIXTURE_DIR, "full-session-transcript.jsonl");
const CHECKPOINT_PATH = path.join(FIXTURE_DIR, "full-session-checkpoint.md");

// Skip entire suite if fixture files don't exist (not yet captured)
const hasFixtures =
	fs.existsSync(TRANSCRIPT_PATH) && fs.existsSync(CHECKPOINT_PATH);

// ---------------------------------------------------------------------------
// Expected fictional facts — planted in user messages across cold/warm/hot tiers
// ---------------------------------------------------------------------------

const EXPECTED_FACTS = [
	// Cold tier (messages 1-10)
	{ id: "pg-port", text: "port 5433", tier: "cold" },
	{ id: "architect", text: "Diana Kowalski", tier: "cold" },
	{ id: "caddy-date", text: "January 14th", tier: "cold" },
	{ id: "gateway", text: "Caddy not nginx", tier: "cold" },
	{ id: "customer", text: "Batavia Digital", tier: "cold" },
	{ id: "region", text: "ap-southeast-3", tier: "cold" },
	{ id: "cron-job", text: "keymaster-rotate", tier: "cold" },
	{ id: "s3-path", text: "s3://zephyr9-artifacts-prod/v3/", tier: "cold" },
	{ id: "bug-id", text: "ZEP-4471", tier: "cold" },
	{ id: "bug-threshold", text: "2,847", tier: "cold" },
	{ id: "bug-file", text: "splitter.go line 389", tier: "cold" },
	{ id: "bug-fix-pr", text: "PR #1847", tier: "cold" },
	{ id: "bug-fix-author", text: "Tomás Herrera", tier: "cold" },
	{ id: "grpc-vote", text: "3-1 against", tier: "cold" },
	{ id: "cb-new", text: "8 errors/30s", tier: "cold" },
	{ id: "shard-option", text: "Option B", tier: "cold" },
	{ id: "shard-key", text: "region_id, customer_id", tier: "cold" },
	{ id: "rollback-trigger", text: "p99 > 340ms", tier: "cold" },
	{ id: "rejected-option", text: "Option A", tier: "cold" },
	{ id: "incident-id", text: "INC-2891", tier: "cold" },
	{ id: "incident-impact", text: "$184,000", tier: "cold" },
	{ id: "incident-txns", text: "2,341", tier: "cold" },
	{ id: "postmortem-owner", text: "Priya Ramanathan", tier: "cold" },
	{ id: "payment-provider", text: "Meridian Pay", tier: "cold" },
	{ id: "capacity-rps", text: "12,000 req/s", tier: "cold" },
	{ id: "binary-port", text: "port 9147", tier: "cold" },
	{ id: "nlb-reason", text: "TCP passthrough", tier: "cold" },
	{ id: "sec-finding", text: "SEC-0042", tier: "cold" },
	{ id: "sec-auditor", text: "Rachel Chen", tier: "cold" },
	{ id: "sec-firm", text: "Vanguard Security", tier: "cold" },
	{ id: "sec-deadline", text: "April 12th", tier: "cold" },
	{ id: "sec-remediation", text: "tmpfs", tier: "cold" },

	// Warm tier (messages 11-20)
	{ id: "deploy-cadence", text: "Thursday", tier: "warm" },
	{ id: "deploy-script", text: "scripts/deploy-prod.sh", tier: "warm" },
	{ id: "deploy-env", text: "DEPLOY_TOKEN", tier: "warm" },
	{ id: "revised-date", text: "September 12th", tier: "warm" },
	{ id: "soak-test", text: "72 hours", tier: "warm" },

	// Hot tier (messages 26-30)
	{ id: "escalation-p1", text: "P1", tier: "hot" },
	{ id: "escalation-sla", text: "48 hours", tier: "hot" },
	{ id: "rollback-image", text: "v3.8.2-stable", tier: "hot" },
	{ id: "grafana-url", text: "grafana.internal/d/ordermesh-fds", tier: "hot" },
	{ id: "oncall-pagerduty", text: "zephyr9-critical", tier: "hot" },
	{ id: "oncall-slack", text: "#zephyr9-war-room", tier: "hot" },
	{ id: "db-maxconn", text: "max_connections=200", tier: "hot" },
	{ id: "db-pool", text: "pool_size=20", tier: "hot" },
	{ id: "db-ordermesh-pool", text: "pool_size=40", tier: "hot" },
	{ id: "currency", text: "IDR", tier: "warm" },
];

// ---------------------------------------------------------------------------
// Content that should be REMOVED (noise)
// ---------------------------------------------------------------------------

const REMOVED_NOISE = [
	{
		id: "file-read-lib",
		text: "export function startEndTrim(content, limit",
		type: "read-result",
	},
	{ id: "thinking-block", text: "redacted_thinking", type: "thinking" },
	{ id: "edit-success", text: "File edited successfully", type: "edit-result" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("full-session compaction verification", {
	skip: !hasFixtures && "fixture files not captured yet",
}, () => {
	let checkpoint;

	it("extracts successfully", () => {
		checkpoint = extractConversation(TRANSCRIPT_PATH);
		assert.ok(checkpoint.length > 0, "Checkpoint should not be empty");
		assert.ok(
			checkpoint.startsWith("## Session State"),
			"Should start with state header",
		);
	});

	it("matches saved checkpoint (no regressions)", () => {
		if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
		const saved = fs.readFileSync(CHECKPOINT_PATH, "utf8");
		assert.equal(
			checkpoint.length,
			saved.length,
			`Checkpoint size changed: was ${saved.length}, now ${checkpoint.length} chars`,
		);
		assert.equal(
			checkpoint,
			saved,
			"Checkpoint content differs from saved baseline",
		);
	});

	describe("fictional fact preservation", () => {
		for (const fact of EXPECTED_FACTS) {
			it(`preserves [${fact.tier}] ${fact.id}: "${fact.text}"`, () => {
				if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
				assert.ok(
					checkpoint.toLowerCase().includes(fact.text.toLowerCase()),
					`FACT LOST [${fact.id}] (${fact.tier} tier): expected checkpoint to contain "${fact.text}"`,
				);
			});
		}
	});

	describe("noise removal", () => {
		for (const noise of REMOVED_NOISE) {
			it(`removes ${noise.id} (${noise.type})`, () => {
				if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
				assert.ok(
					!checkpoint.includes(noise.text),
					`NOISE KEPT [${noise.id}]: checkpoint should NOT contain "${noise.text}"`,
				);
			});
		}

		it("strips raw grep output", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			// Grep results come back as "file:line: content" — should be stripped
			assert.ok(
				!checkpoint.includes("← lib/trim.mjs:"),
				"Raw grep results should be stripped",
			);
		});
	});

	describe("tiered compression", () => {
		it("has user exchanges spanning cold tier (21+ from end)", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			const userCount = (checkpoint.match(/\] User:/g) || []).length;
			assert.ok(
				userCount > 20,
				`Need >20 user exchanges for cold tier testing, got ${userCount}`,
			);
		});

		it("applies cold-tier trimming to early assistant messages", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			const trimCount = (checkpoint.match(/trimmed from middle/g) || []).length;
			assert.ok(
				trimCount > 0,
				"Expected at least one cold-tier trimmed message",
			);
		});

		it("user messages are NEVER compressed regardless of tier", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			// User messages should never contain trim markers
			const userMsgs = checkpoint.split("User:").slice(1);
			for (const msg of userMsgs) {
				const userPart = msg.split("Asst:")[0];
				assert.ok(
					!userPart.includes("trimmed from middle"),
					"User message should never be trimmed",
				);
			}
		});
	});

	describe("structural integrity", () => {
		it("has state header with files modified", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			assert.ok(checkpoint.includes("Files modified:"));
			assert.ok(checkpoint.includes("/tmp/cg-coalesce-test.js"));
		});

		it("preserves edit diffs for /tmp/cg-coalesce-test.js", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			assert.ok(
				checkpoint.includes("→ Edit `/tmp/cg-coalesce-test.js`"),
				"Edit summaries should be present",
			);
		});

		it("preserves Write for file creation", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			assert.ok(
				checkpoint.includes("→ Write `/tmp/cg-coalesce-test.js`"),
				"Write summary should be present",
			);
		});

		it("preserves original file content in Write", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			assert.ok(
				checkpoint.includes("processOrder"),
				"Original function name should be in Write content",
			);
		});

		it("maintains chronological order", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			const zep4471Pos = checkpoint.indexOf("ZEP-4471");
			const inc2891Pos = checkpoint.indexOf("INC-2891");
			const sec0042Pos = checkpoint.indexOf("SEC-0042");
			const pagerdutyPos = checkpoint.indexOf("zephyr9-critical");

			assert.ok(zep4471Pos > -1, "ZEP-4471 found");
			assert.ok(inc2891Pos > -1, "INC-2891 found");
			assert.ok(sec0042Pos > -1, "SEC-0042 found");
			assert.ok(pagerdutyPos > -1, "PagerDuty found");
			assert.ok(zep4471Pos < inc2891Pos, "ZEP-4471 before INC-2891");
			assert.ok(inc2891Pos < sec0042Pos, "INC-2891 before SEC-0042");
			assert.ok(sec0042Pos < pagerdutyPos, "SEC-0042 before PagerDuty");
		});

		it("uses --- separators between messages", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			assert.ok(checkpoint.includes("\n\n---\n\n"));
		});
	});

	describe("compaction metrics", () => {
		it("achieves significant size reduction", () => {
			if (!checkpoint) checkpoint = extractConversation(TRANSCRIPT_PATH);
			const transcriptSize = fs.statSync(TRANSCRIPT_PATH).size;
			const ratio = checkpoint.length / transcriptSize;
			assert.ok(
				ratio < 0.15,
				`Compaction ratio ${(ratio * 100).toFixed(1)}% — expected <15%`,
			);
		});
	});
});
