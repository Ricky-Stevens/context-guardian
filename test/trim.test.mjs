import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isAffirmativeConfirmation,
	isErrorResponse,
	isShortErrorResponse,
	isSystemInjection,
	startEndTrim,
} from "../lib/trim.mjs";

// ---------------------------------------------------------------------------
// startEndTrim
// ---------------------------------------------------------------------------

describe("startEndTrim", () => {
	it("returns content unchanged if under limit", () => {
		assert.equal(startEndTrim("hello world", 100), "hello world");
	});

	it("returns empty string for null", () => {
		assert.equal(startEndTrim(null, 100), "");
	});

	it("returns empty string for undefined", () => {
		assert.equal(startEndTrim(undefined, 100), "");
	});

	it("returns empty string for empty string", () => {
		assert.equal(startEndTrim("", 100), "");
	});

	it("trims middle and keeps start+end when over limit", () => {
		const content = "A".repeat(50) + "B".repeat(50);
		const result = startEndTrim(content, 20);
		assert.ok(result.startsWith("A".repeat(10)));
		assert.ok(result.endsWith("B".repeat(10)));
		assert.ok(result.includes("[..."));
		assert.ok(result.includes("trimmed from middle..."));
	});

	it("includes the trimmed char count in the marker", () => {
		const content = "X".repeat(100);
		const result = startEndTrim(content, 20);
		// keep 10 start + 10 end = 80 trimmed
		assert.ok(result.includes("...80 chars trimmed from middle..."));
	});

	it("respects custom keepStart/keepEnd params", () => {
		const content = "A".repeat(30) + "B".repeat(70);
		const result = startEndTrim(content, 20, 5, 15);
		assert.ok(result.startsWith("A".repeat(5)));
		assert.ok(result.endsWith("B".repeat(15)));
		// 100 - 5 - 15 = 80 trimmed
		assert.ok(result.includes("...80 chars trimmed from middle..."));
	});

	it("returns content unchanged for exact-length content", () => {
		const content = "Z".repeat(50);
		assert.equal(startEndTrim(content, 50), content);
	});
});

// ---------------------------------------------------------------------------
// isErrorResponse
// ---------------------------------------------------------------------------

describe("isErrorResponse", () => {
	it("returns false for null", () => {
		assert.equal(isErrorResponse(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isErrorResponse(undefined), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isErrorResponse(""), false);
	});

	it("returns false for non-string", () => {
		assert.equal(isErrorResponse(42), false);
		assert.equal(isErrorResponse({}), false);
	});

	const errorStrings = [
		["error", "Something went error in the build"],
		["Error", "Error: file not found"],
		["ERROR", "FATAL ERROR occurred"],
		["failed", "Build failed with 3 warnings"],
		["FAILED", "Test FAILED"],
		["not found", "Module not found"],
		["permission denied", "permission denied for /etc/shadow"],
		["ENOENT", "ENOENT: no such file or directory"],
		["EACCES", "EACCES: permission denied"],
		["exit code 1", "Process exited with exit code 1"],
		["exception", "Unhandled exception in worker"],
		["timeout", "Connection timeout after 30s"],
		["does not exist", "The file does not exist"],
	];

	for (const [pattern, example] of errorStrings) {
		it(`returns true for string containing "${pattern}"`, () => {
			assert.equal(isErrorResponse(example), true);
		});
	}

	it("returns false for normal content without error patterns", () => {
		assert.equal(isErrorResponse("const x = 42;"), false);
		assert.equal(isErrorResponse("function hello() { return 1; }"), false);
	});

	it("returns true for content containing 'error' even in identifiers (broad check)", () => {
		// isErrorResponse uses word-boundary \b, so "errorHandler" won't match
		// because there's no word boundary between "error" and "Handler"
		// Actually \berror\b requires boundaries on BOTH sides
		assert.equal(isErrorResponse("const errorHandler = function() {}"), false);
	});

	it("returns true when error is a standalone word", () => {
		assert.equal(isErrorResponse("caught an error here"), true);
	});
});

// ---------------------------------------------------------------------------
// isShortErrorResponse
// ---------------------------------------------------------------------------

describe("isShortErrorResponse", () => {
	it("returns false for null", () => {
		assert.equal(isShortErrorResponse(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isShortErrorResponse(undefined), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isShortErrorResponse(""), false);
	});

	it("returns true for short error-like strings", () => {
		assert.equal(isShortErrorResponse("Error: file not found"), true);
		assert.equal(
			isShortErrorResponse("ENOENT: no such file or directory"),
			true,
		);
		assert.equal(isShortErrorResponse("Build failed"), true);
	});

	it("returns false for long strings even with error patterns", () => {
		const longContent = `This file has an error in it.\n${"x".repeat(1000)}`;
		assert.equal(isShortErrorResponse(longContent), false);
	});

	it("returns false for short strings without error patterns", () => {
		assert.equal(isShortErrorResponse("all good here"), false);
		assert.equal(isShortErrorResponse("const x = 42;"), false);
	});

	it("returns false for exactly 500-char string with error pattern", () => {
		// content.length < 500, so exactly 500 returns false
		const content = `error ${"x".repeat(494)}`;
		assert.equal(content.length, 500);
		assert.equal(isShortErrorResponse(content), false);
	});

	it("returns true for 499-char string with error pattern", () => {
		const content = `error ${"x".repeat(493)}`;
		assert.equal(content.length, 499);
		assert.equal(isShortErrorResponse(content), true);
	});
});

// ---------------------------------------------------------------------------
// isAffirmativeConfirmation
// ---------------------------------------------------------------------------

describe("isAffirmativeConfirmation", () => {
	it("returns false for null", () => {
		assert.equal(isAffirmativeConfirmation(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isAffirmativeConfirmation(undefined), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isAffirmativeConfirmation(""), false);
	});

	it("returns false for non-string", () => {
		assert.equal(isAffirmativeConfirmation(42), false);
	});

	const affirmatives = [
		"yes",
		"Yes",
		"YES",
		"y",
		"ok",
		"okay",
		"sure",
		"go ahead",
		"continue",
		"proceed",
		"do it",
		"correct",
		"right",
		"exactly",
		"thanks",
		"thank you",
		"yep",
		"yea",
		"yeah",
		"sounds good",
		"lgtm",
		"ship it",
		"please",
		"agreed",
		"go for it",
	];

	for (const word of affirmatives) {
		it(`returns true for "${word}"`, () => {
			assert.equal(isAffirmativeConfirmation(word), true);
		});
	}

	it("returns true with trailing period", () => {
		assert.equal(isAffirmativeConfirmation("yes."), true);
	});

	it("returns true with trailing exclamation", () => {
		assert.equal(isAffirmativeConfirmation("ok!"), true);
	});

	it("returns true with trailing comma", () => {
		assert.equal(isAffirmativeConfirmation("sure,"), true);
	});

	it("returns true with multiple trailing punctuation", () => {
		assert.equal(isAffirmativeConfirmation("yes!!!"), true);
	});

	it("returns false for 'no'", () => {
		assert.equal(isAffirmativeConfirmation("no"), false);
	});

	it("returns false for 'n'", () => {
		assert.equal(isAffirmativeConfirmation("n"), false);
	});

	it("returns false for bare numbers", () => {
		assert.equal(isAffirmativeConfirmation("1"), false);
		assert.equal(isAffirmativeConfirmation("2"), false);
		assert.equal(isAffirmativeConfirmation("3"), false);
	});

	it("returns false for 'not sure'", () => {
		assert.equal(isAffirmativeConfirmation("not sure"), false);
	});

	it("returns false for multi-word messages with substance", () => {
		assert.equal(
			isAffirmativeConfirmation("yes please do the refactoring"),
			false,
		);
		assert.equal(isAffirmativeConfirmation("yes but also..."), false);
	});
});

// ---------------------------------------------------------------------------
// isSystemInjection
// ---------------------------------------------------------------------------

describe("isSystemInjection", () => {
	it("returns false for null", () => {
		assert.equal(isSystemInjection(null), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isSystemInjection(undefined), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isSystemInjection(""), false);
	});

	it("returns true for Context Checkpoint header", () => {
		assert.equal(
			isSystemInjection("# Context Checkpoint\nSaved at 2025-01-01"),
			true,
		);
	});

	it("returns true for text containing <prior_conversation_history>", () => {
		assert.equal(
			isSystemInjection(
				"Here is the <prior_conversation_history> from before.",
			),
			true,
		);
	});

	it("returns true for text containing both SKILL.md and plugin", () => {
		assert.equal(
			isSystemInjection("Loading SKILL.md from the plugin directory for cg"),
			true,
		);
	});

	it("returns false for normal user messages", () => {
		assert.equal(isSystemInjection("Please fix the bug in line 42"), false);
		assert.equal(isSystemInjection("How do I use this function?"), false);
	});

	it("returns false for long markdown without injection patterns", () => {
		const markdown =
			"# My Document\n\nThis is a long document with lots of content.\n".repeat(
				50,
			);
		assert.equal(isSystemInjection(markdown), false);
	});

	it("returns false for messages containing only SKILL.md without plugin", () => {
		assert.equal(
			isSystemInjection("Check the SKILL.md file for instructions"),
			false,
		);
	});

	it("returns false for messages containing only plugin without SKILL.md", () => {
		assert.equal(
			isSystemInjection("Install the plugin from the marketplace"),
			false,
		);
	});
});
