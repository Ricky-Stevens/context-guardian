import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	generateStateHeader,
	isCGMenuMessage,
	processAssistantContent,
	processUserContent,
	shouldSkipUserMessage,
} from "../lib/extract-helpers.mjs";

// ---------------------------------------------------------------------------
// generateStateHeader — topic extraction and header formatting
// ---------------------------------------------------------------------------

describe("generateStateHeader", () => {
	it("includes Session State heading", () => {
		const header = generateStateHeader([], new Set(), 0);
		assert.ok(header.startsWith("## Session State"));
	});

	it("extracts ticket IDs from user messages", () => {
		const msgs = ["**User:** Bug ZEP-4471 is critical"];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("ZEP-4471"));
	});

	it("extracts multiple ticket IDs", () => {
		const msgs = [
			"**User:** Fix ZEP-4471 and check INC-2891 and SEC-0042",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("ZEP-4471"));
		assert.ok(header.includes("INC-2891"));
		assert.ok(header.includes("SEC-0042"));
	});

	it("extracts named entities (proper nouns)", () => {
		const msgs = [
			"**User:** Diana Kowalski approved the plan from Vanguard Security",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Diana Kowalski"));
		assert.ok(header.includes("Vanguard Security"));
	});

	it("filters date-like false positives from topics", () => {
		const msgs = [
			"**User:** On Saturday March 15th we discovered the issue",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		const topicsLine = header.split("\n").find((l) => l.startsWith("Topics"));
		assert.ok(!topicsLine.includes("Saturday March"));
	});

	it("filters Context Guardian noise from topics", () => {
		const msgs = [
			"**User:** Check the Context Guardian Stats and run Smart Compact",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		const topicsLine = header.split("\n").find((l) => l.startsWith("Topics"));
		assert.ok(!topicsLine.includes("Context Guardian Stats"));
		assert.ok(!topicsLine.includes("Smart Compact"));
	});

	it("filters code identifiers (ALL_CAPS_UNDERSCORES) from topics", () => {
		const msgs = ["**User:** Check the COMPACT_MARKER_RE regex"];
		const header = generateStateHeader(msgs, new Set(), 0);
		const topicsLine = header.split("\n").find((l) => l.startsWith("Topics"));
		assert.ok(!topicsLine.includes("COMPACT_MARKER_RE"));
	});

	it("extracts decision subjects", () => {
		const msgs = [
			"**User:** I chose Option B for sharding",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("B for sharding"));
	});

	it("extracts quoted project names", () => {
		const msgs = ['**User:** Our project "Zephyr-9" uses PostgreSQL'];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Zephyr-9"));
	});

	it("uses first user message as Goal, not last", () => {
		const msgs = [
			"**User:** Fix the authentication bug",
			"**Assistant:** I'll look into it.",
			"**User:** Also update the tests",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Goal: Fix the authentication bug"));
	});

	it("skips system injections for Goal", () => {
		const msgs = [
			"**User:** # Context Checkpoint\nrestored data",
			"**User:** Real user message here",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Goal: Real user message here"));
	});

	it("skips code block messages for Goal", () => {
		const msgs = [
			"**User:** ```\nsome code\n```",
			"**User:** Fix the bug",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Goal: Fix the bug"));
	});

	it("skips command-message injections for Goal", () => {
		const msgs = [
			"**User:** <command-message>compact</command-message>",
			"**User:** Real question",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Goal: Real question"));
	});

	it("skips short filler for Last action", () => {
		const msgs = [
			"**Assistant:** Done.",
			"**Assistant:** I've completed the full analysis of the codebase.",
		];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(header.includes("Last action: I've completed the full analysis"));
	});

	it("flattens newlines in Goal", () => {
		const msgs = ["**User:** First line\nSecond line\nThird line"];
		const header = generateStateHeader(msgs, new Set(), 0);
		assert.ok(!header.includes("\nSecond"));
		assert.ok(header.includes("First line Second line"));
	});

	it("shows files modified", () => {
		const files = new Set(["src/a.js", "src/b.js"]);
		const header = generateStateHeader(
			["**User:** fix stuff"],
			files,
			5,
		);
		assert.ok(header.includes("src/a.js"));
		assert.ok(header.includes("src/b.js"));
	});

	it("shows message and tool op counts", () => {
		const msgs = ["**User:** hi", "**Assistant:** hello"];
		const header = generateStateHeader(msgs, new Set(), 12);
		assert.ok(header.includes("Messages preserved: 2"));
		assert.ok(header.includes("Tool operations: 12"));
	});

	it("strips \\r from user messages before topic extraction", () => {
		const msgs = ["**User:** Bug ZEP-1234\r and more"];
		const header = generateStateHeader(msgs, new Set(), 0);
		const topicsLine = header.split("\n").find((l) => l.startsWith("Topics"));
		assert.ok(topicsLine.includes("ZEP-1234"));
		assert.ok(!topicsLine.includes("\r"));
	});

	it("limits topics to 15", () => {
		const names = Array.from({ length: 20 }, (_, i) => `Person${i} Name${i}`);
		const msgs = [`**User:** ${names.join(", ")}`];
		const header = generateStateHeader(msgs, new Set(), 0);
		const topicsLine = header.split("\n").find((l) => l.startsWith("Topics"));
		const count = topicsLine.split(",").length;
		assert.ok(count <= 15);
	});
});

// ---------------------------------------------------------------------------
// shouldSkipUserMessage — skip rules
// ---------------------------------------------------------------------------

describe("shouldSkipUserMessage", () => {
	it("skips empty messages", () => {
		assert.ok(shouldSkipUserMessage("", false).skip);
	});

	it("skips slash commands", () => {
		assert.ok(shouldSkipUserMessage("/cg:compact", false).skip);
	});

	it("skips CG menu replies after menu", () => {
		const { skip, clearMenu } = shouldSkipUserMessage("2", true);
		assert.ok(skip);
		assert.ok(clearMenu);
	});

	it("does NOT skip digits without menu context", () => {
		assert.ok(!shouldSkipUserMessage("2", false).skip);
	});

	it("skips system injections", () => {
		assert.ok(
			shouldSkipUserMessage("# Context Checkpoint\ndata", false).skip,
		);
	});

	it("skips command-message injections", () => {
		assert.ok(
			shouldSkipUserMessage(
				"<command-message>compact</command-message>",
				false,
			).skip,
		);
	});

	it("skips affirmative confirmations", () => {
		assert.ok(shouldSkipUserMessage("yes", false).skip);
		assert.ok(shouldSkipUserMessage("ok", false).skip);
	});

	it("does NOT skip rejections", () => {
		assert.ok(!shouldSkipUserMessage("no", false).skip);
	});

	it("does NOT skip real messages", () => {
		assert.ok(!shouldSkipUserMessage("fix the bug in line 42", false).skip);
	});
});

// ---------------------------------------------------------------------------
// isCGMenuMessage
// ---------------------------------------------------------------------------

describe("isCGMenuMessage", () => {
	it("detects CG menu prompt", () => {
		const content = [
			{
				type: "text",
				text: "Context Guardian — ~35.1% used\n\nReply with 1, 2, 3, 4, or 0.",
			},
		];
		assert.ok(isCGMenuMessage(content));
	});

	it("does not match non-menu messages", () => {
		assert.ok(!isCGMenuMessage([{ type: "text", text: "hello" }]));
		assert.ok(!isCGMenuMessage("just a string"));
	});
});
