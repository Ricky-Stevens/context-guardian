import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentBytesOf, flattenContent } from "../lib/content.mjs";

describe("flattenContent", () => {
	it("returns empty string for null/undefined", () => {
		assert.equal(flattenContent(null), "");
		assert.equal(flattenContent(undefined), "");
		assert.equal(flattenContent(""), "");
	});

	it("returns string content as-is", () => {
		assert.equal(flattenContent("hello world"), "hello world");
	});

	it("extracts text blocks from array content", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "tool_use", id: "t1", name: "Read", input: {} },
			{ type: "text", text: "second" },
		];
		assert.equal(flattenContent(content), "first\nsecond");
	});

	it("returns empty string for array with no text blocks", () => {
		const content = [
			{ type: "tool_use", id: "t1", name: "Read", input: {} },
			{ type: "tool_result", tool_use_id: "t1", content: "result" },
		];
		assert.equal(flattenContent(content), "");
	});

	it("returns empty string for non-string non-array types", () => {
		assert.equal(flattenContent(42), "");
		assert.equal(flattenContent({}), "");
		assert.equal(flattenContent(true), "");
	});

	it("handles single text block in array", () => {
		assert.equal(flattenContent([{ type: "text", text: "only" }]), "only");
	});
});

describe("contentBytesOf", () => {
	it("returns 0 for null/undefined", () => {
		assert.equal(contentBytesOf(null), 0);
		assert.equal(contentBytesOf(undefined), 0);
	});

	it("counts bytes for string content", () => {
		assert.equal(contentBytesOf("hello"), 5);
		// Multi-byte: é is 2 bytes in UTF-8
		assert.equal(contentBytesOf("café"), 5);
	});

	it("counts text bytes from array blocks", () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		assert.equal(contentBytesOf(content), 10);
	});

	it("counts tool input bytes", () => {
		const content = [{ type: "tool_use", input: { key: "val" } }];
		const expected = Buffer.byteLength(JSON.stringify({ key: "val" }), "utf8");
		assert.equal(contentBytesOf(content), expected);
	});

	it("handles nested content recursively", () => {
		const content = [
			{ type: "tool_result", content: [{ type: "text", text: "nested" }] },
		];
		assert.equal(contentBytesOf(content), 6);
	});

	it("returns 0 for non-string non-array", () => {
		assert.equal(contentBytesOf(42), 0);
		assert.equal(contentBytesOf({}), 0);
	});

	it("skips blocks without text or input", () => {
		const content = [{ type: "thinking", thinking: "hmm" }];
		assert.equal(contentBytesOf(content), 0);
	});
});
