import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addSectionHeaders,
	generateConversationIndex,
} from "../lib/extract-helpers.mjs";

// Helper: build alternating user/assistant exchanges.
// generateConversationIndex skips exchanges with no extractable facts or tool work,
// so we support richUser (entity-laden text) and withTools (edit tool lines) options.
function buildExchanges(count, opts = {}) {
	const messages = [];
	for (let i = 1; i <= count; i++) {
		if (opts.richUser) {
			messages.push(`**User:** Fix ZEP-${1000 + i} which costs $${10000 + i}`);
		} else {
			messages.push(`**User:** User message ${i}`);
		}
		messages.push(`**Assistant:** Assistant response ${i}`);
		if (opts.withTools) {
			messages.push(`\u2192 Edit \`file${i}.js\``);
			messages.push(`\u2190 success`);
		}
	}
	return messages;
}

describe("generateConversationIndex", () => {
	it("returns empty string for fewer than 10 messages", () => {
		const messages = buildExchanges(2, { withTools: true }); // 8 messages
		const result = generateConversationIndex(messages);
		assert.equal(result, "");
	});

	it("returns empty string for exactly 9 messages", () => {
		const messages = buildExchanges(2, { withTools: true }); // 8 messages
		messages.push("**User:** One more question");
		assert.equal(messages.length, 9);
		const result = generateConversationIndex(messages);
		assert.equal(result, "");
	});

	it("returns empty string when no exchanges produce facts or work", () => {
		// 20 messages but all generic — no entities, no tool lines
		const messages = buildExchanges(10);
		const result = generateConversationIndex(messages);
		assert.equal(
			result,
			"",
			"Generic user/assistant pairs without entities or tools should produce empty index",
		);
	});

	it("generates index entries for exchanges with tool work", () => {
		const messages = buildExchanges(6, { withTools: true }); // 24 messages
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		assert.ok(
			result.includes("## Conversation Index"),
			"Should have index header",
		);
		assert.ok(
			result.includes("Compact reference"),
			"Should have description line",
		);
		assert.ok(result.includes("[1]"), "Should have first exchange entry");
		assert.ok(result.includes("[6]"), "Should have last exchange entry");
	});

	it("generates index entries for entity-rich user messages without tools", () => {
		const messages = buildExchanges(6, { richUser: true }); // 12 messages, entities in user text
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		assert.ok(result.includes("## Conversation Index"));
		assert.ok(
			result.includes("ZEP-"),
			"Should include ticket IDs from user messages",
		);
		assert.ok(result.includes("$"), "Should include money references");
	});

	it("includes decisions section when user messages contain decision patterns", () => {
		const messages = [
			"**User:** I chose to use PostgreSQL instead of MySQL",
			"**Assistant:** Great choice.",
			"\u2192 Edit `db.js`",
			"\u2190 success",
			"**User:** I rejected the caching approach",
			"**Assistant:** Understood.",
			"\u2192 Edit `cache.js`",
			"\u2190 success",
			"**User:** I decided to go with REST over GraphQL",
			"**Assistant:** REST it is.",
			"\u2192 Edit `api.js`",
			"\u2190 success",
		];
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		assert.ok(
			result.includes("**Decisions:**"),
			"Should have decisions section",
		);
		assert.ok(result.includes("chose"), "Should include 'chose' decision");
		assert.ok(
			result.includes("rejected"),
			"Should include 'rejected' decision",
		);
		assert.ok(result.includes("decided"), "Should include 'decided' decision");
	});

	it("includes error-resolution pairs", () => {
		const messages = [
			"**User:** Run the build",
			"**Assistant:** Running the build now.",
			"\u2192 Bash `npm run build`",
			"\u2190 Error: Module not found lodash",
			"**User:** Fix the missing dependency",
			"**Assistant:** I'll install lodash.",
			"\u2192 Bash `npm install lodash`",
			"\u2190 added 1 package",
			"**User:** Try the build again",
			"**Assistant:** Running build again.",
			"\u2192 Bash `npm run build`",
			"\u2190 Build successful",
		];
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		assert.ok(
			result.includes("**Errors resolved:**"),
			"Should have error resolution section",
		);
		assert.ok(
			result.includes("Module not found"),
			"Should include the error text",
		);
		assert.ok(result.includes("\u2192"), "Should include resolution arrow");
	});

	it("truncates long facts to 250 chars and appends entity tags", () => {
		const longText = "A".repeat(300);
		const messages = [
			`**User:** ${longText} and also reference ZEP-4471 and $184,000`,
			"**Assistant:** Understood.",
			"\u2192 Edit `big.js`",
			"\u2190 success",
			"**User:** Continue with port 5433 configuration",
			"**Assistant:** Configuring.",
			"\u2192 Edit `port.js`",
			"\u2190 success",
			"**User:** Update for March 29th deadline",
			"**Assistant:** Noted.",
			"\u2192 Edit `deadline.js`",
			"\u2190 success",
		];
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		// The long user message should be truncated: 250 chars + "..." + entity tags
		const lines = result.split("\n");
		const longLine = lines.find((l) => l.includes("AAA"));
		assert.ok(longLine, "Should have a line with the truncated A's");
		assert.ok(
			longLine.includes("..."),
			"Truncated line should end with ellipsis",
		);
		// Entity tags should be appended in braces
		assert.ok(longLine.includes("{"), "Should have entity tag block");
		assert.ok(longLine.includes("ZEP-4471"), "Should tag ZEP-4471 entity");
		assert.ok(longLine.includes("$184,000"), "Should tag $184,000 entity");
		// The full 300-char string should NOT appear (truncated at 250)
		assert.ok(
			!longLine.includes("A".repeat(300)),
			"Should not contain full 300-char string",
		);
	});

	it("entity extraction pulls IDs, money, dates, and ports into index entries", () => {
		const messages = [
			"**User:** Fix ZEP-4471 which involves $184,000 payment on March 29th using port 5433",
			"**Assistant:** I'll handle it.",
			"\u2192 Edit `payment.js`",
			"\u2190 success",
			"**User:** Also check PROJ-9999 for $50,000 budget",
			"**Assistant:** Looking into it.",
			"\u2192 Edit `budget.js`",
			"\u2190 success",
			"**User:** Deploy on port 8080 by January 15th",
			"**Assistant:** Will target that.",
			"\u2192 Edit `deploy.js`",
			"\u2190 success",
		];
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		// Entities should appear directly in the facts (short enough to not be truncated)
		assert.ok(result.includes("ZEP-4471"), "Should include ticket ID ZEP-4471");
		assert.ok(
			result.includes("$184,000"),
			"Should include money amount $184,000",
		);
		assert.ok(result.includes("port 5433"), "Should include port reference");
		assert.ok(
			result.includes("PROJ-9999"),
			"Should include ticket ID PROJ-9999",
		);
	});

	it("handles mixed content with tools, decisions, errors, and entities", () => {
		const messages = [
			"**User:** Implement auth for PROJ-2000 with budget $10,000",
			"**Assistant:** Starting auth implementation.",
			"\u2192 Edit `auth.js`",
			"\u2190 success",
			"**User:** I chose JWT over session tokens",
			"**Assistant:** Using JWT approach.",
			"\u2192 Edit `jwt.js`",
			"\u2190 success",
			"**User:** Run tests on port 3000",
			"**Assistant:** Running tests.",
			"\u2192 Bash `npm test`",
			"\u2190 Error: Connection refused on port 3000",
			"**User:** Fix the connection issue",
			"**Assistant:** Fixing the port configuration.",
			"\u2192 Edit `config.js`",
			"\u2190 success",
			"**User:** I rejected using OAuth for now",
			"**Assistant:** Skipping OAuth.",
			"**User:** Deploy by April 1st deadline",
			"**Assistant:** Targeting April 1st.",
		];
		const result = generateConversationIndex(messages);
		assert.notEqual(result, "");
		assert.ok(
			result.includes("## Conversation Index"),
			"Should have index header",
		);
		assert.ok(
			result.includes("**Decisions:**"),
			"Should have decisions section",
		);
		assert.ok(
			result.includes("**Errors resolved:**"),
			"Should have error resolution section",
		);
		assert.ok(
			result.includes("PROJ-2000"),
			"Should include entity from first exchange",
		);
	});
});

describe("addSectionHeaders", () => {
	it("returns unchanged array for fewer than 20 messages", () => {
		const messages = buildExchanges(5); // 10 messages
		const result = addSectionHeaders(messages);
		assert.deepEqual(result, messages);
	});

	it("returns unchanged array for exactly 19 messages", () => {
		const messages = buildExchanges(9); // 18 messages
		messages.push("**User:** One more");
		assert.equal(messages.length, 19);
		const result = addSectionHeaders(messages);
		assert.deepEqual(result, messages);
	});

	it("inserts section headers every 10 exchanges for 25+ exchange sessions", () => {
		const messages = buildExchanges(25); // 50 messages
		const result = addSectionHeaders(messages, 10);
		assert.ok(
			result.length > messages.length,
			"Should have added header elements",
		);
		// Find all section headers
		const headers = result.filter((m) => m.startsWith("### Exchanges"));
		assert.ok(
			headers.length >= 2,
			`Should have at least 2 section headers, got ${headers.length}`,
		);
		// Check header format
		for (const header of headers) {
			assert.match(
				header,
				/^### Exchanges \d+-\d+$/,
				`Header should match format, got: ${header}`,
			);
		}
	});

	it("first header starts at exchange 1", () => {
		const messages = buildExchanges(25);
		const result = addSectionHeaders(messages, 10);
		const headers = result.filter((m) => m.startsWith("### Exchanges"));
		assert.ok(headers.length > 0, "Should have headers");
		assert.ok(
			headers[0].startsWith("### Exchanges 1-"),
			`First header should start at 1, got: ${headers[0]}`,
		);
	});

	it("uses default groupSize when not specified", () => {
		const messages = buildExchanges(25); // 50 messages
		const result = addSectionHeaders(messages);
		const headers = result.filter((m) => m.startsWith("### Exchanges"));
		assert.ok(
			headers.length >= 1,
			"Should insert headers with default groupSize",
		);
	});

	it("handles messages with tool lines between exchanges", () => {
		const messages = buildExchanges(12, { withTools: true }); // 48 messages
		const result = addSectionHeaders(messages, 5);
		const headers = result.filter((m) => m.startsWith("### Exchanges"));
		assert.ok(
			headers.length >= 1,
			`Should have section headers, got ${headers.length}`,
		);
		// All original messages should still be present
		for (const msg of messages) {
			assert.ok(
				result.includes(msg),
				`Original message should be preserved: ${msg.substring(0, 50)}`,
			);
		}
	});

	it("preserves message order after inserting headers", () => {
		const messages = buildExchanges(15); // 30 messages
		const result = addSectionHeaders(messages, 5);
		// Filter out headers and verify original order is preserved
		const withoutHeaders = result.filter((m) => !m.startsWith("### Exchanges"));
		assert.deepEqual(withoutHeaders, messages);
	});
});
