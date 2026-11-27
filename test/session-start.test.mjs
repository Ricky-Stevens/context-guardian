import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

// session-start.mjs is a hook script. We test it by spawning it with a
// temporary HOME so it never touches the real ~/.claude/settings.json.

const HOOK_PATH = path.resolve("hooks/session-start.mjs");
const PLUGIN_ROOT = path.resolve(".");
const CG_COMMAND = `node ${PLUGIN_ROOT}/lib/statusline.mjs`;
const FOREIGN = { type: "command", command: "ccstatusline" };

let home;
let dataDir;
let stateDir;
let settingsPath;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-session-start-"));
	dataDir = path.join(home, "data");
	stateDir = path.join(home, ".claude", "cg");
	settingsPath = path.join(home, ".claude", "settings.json");
	fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(settings) {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function readSettings() {
	return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function setMode(statusline) {
	fs.writeFileSync(
		path.join(dataDir, "config.json"),
		JSON.stringify({ statusline }),
	);
}

function runHook(pluginRoot = PLUGIN_ROOT) {
	return execFileSync("node", [HOOK_PATH], {
		encoding: "utf8",
		timeout: 10000,
		input: JSON.stringify({ session_id: "test-session", cwd: home }),
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CLAUDE_PLUGIN_DATA: dataDir,
			CLAUDE_PLUGIN_ROOT: pluginRoot,
			CG_STATE_DIR: stateDir,
		},
	});
}

describe("session-start statusline — managed mode (default)", () => {
	it("configures CG's statusline when none is set", () => {
		writeSettings({});
		runHook();
		assert.deepEqual(readSettings().statusLine, {
			type: "command",
			command: CG_COMMAND,
		});
	});

	it("reclaims a foreign statusline and tells the session", () => {
		writeSettings({ statusLine: FOREIGN });
		const stdout = runHook();
		assert.equal(readSettings().statusLine.command, CG_COMMAND);
		assert.match(stdout, /Statusline reclaimed/);
	});

	it("leaves a statusline that already runs CG alone", () => {
		const own = { type: "command", command: "node /x/statusline.mjs" };
		writeSettings({ statusLine: own });
		const stdout = runHook();
		assert.deepEqual(readSettings().statusLine, own);
		assert.equal(stdout, "");
	});

	it("treats an unknown mode value as managed", () => {
		setMode("off");
		writeSettings({ statusLine: FOREIGN });
		runHook();
		assert.equal(readSettings().statusLine.command, CG_COMMAND);
	});
});

describe("session-start statusline — external mode", () => {
	it("leaves a foreign statusline in place without a notice", () => {
		setMode("external");
		writeSettings({ statusLine: FOREIGN, other: 1 });
		const stdout = runHook();
		assert.deepEqual(readSettings(), { statusLine: FOREIGN, other: 1 });
		assert.equal(stdout, "");
	});

	it("does not add a statusline when none is set, and warns the session", () => {
		setMode("external");
		writeSettings({});
		const stdout = runHook();
		assert.equal(readSettings().statusLine, undefined);
		const notice = JSON.parse(stdout).hookSpecificOutput.additionalContext;
		assert.match(notice, /statusline is external, but no status line command/);
		assert.ok(notice.includes(path.join(stateDir, "statusline.mjs")), notice);
	});

	it("warns when settings.json does not exist at all", () => {
		setMode("external");
		const stdout = runHook();
		assert.match(stdout, /no status line command is set/);
	});
});

describe("session-start statusline launcher", () => {
	const launcher = () => path.join(stateDir, "statusline.mjs");

	it("writes a launcher that imports the current plugin's script", () => {
		writeSettings({});
		runHook();
		const content = fs.readFileSync(launcher(), "utf8");
		assert.match(content, /^\/\/ Written by Context Guardian/);
		const target = pathToFileURL(
			path.join(PLUGIN_ROOT, "lib", "statusline.mjs"),
		);
		assert.ok(content.includes(JSON.stringify(target.href)), content);
	});

	it("prints a hint instead of failing when the target is gone", () => {
		writeSettings({});
		runHook(path.join(home, "deleted-plugin-copy"));
		const out = execFileSync("node", [launcher()], {
			encoding: "utf8",
			timeout: 10000,
			input: "{}",
			env: { ...process.env, HOME: home, CG_STATE_DIR: stateDir },
		});
		assert.match(out, /launcher is out of date/);
	});

	it("renders the statusline and records session metadata when run", () => {
		setMode("external");
		writeSettings({});
		runHook();
		const out = execFileSync("node", [launcher()], {
			encoding: "utf8",
			timeout: 10000,
			input: JSON.stringify({
				session_id: "launcher-session",
				model: { id: "claude-test" },
				context_window: { used_percentage: 12, context_window_size: 1000000 },
			}),
			env: { ...process.env, HOME: home, CG_STATE_DIR: stateDir },
		});
		assert.match(out, /Context usage:.*12%/);
		const state = JSON.parse(
			fs.readFileSync(
				path.join(stateDir, "state-launcher-session.json"),
				"utf8",
			),
		);
		assert.equal(state.context_window_size, 1000000);
		assert.equal(state.cc_model_id, "claude-test");
	});

	it("rewrites the launcher only when the plugin root changes", () => {
		writeSettings({});
		runHook();
		const first = fs.statSync(launcher());
		runHook();
		assert.equal(fs.statSync(launcher()).ino, first.ino);

		const otherRoot = path.join(home, "cg", "9.9.9");
		runHook(otherRoot);
		assert.ok(
			fs
				.readFileSync(launcher(), "utf8")
				.includes("/cg/9.9.9/lib/statusline.mjs"),
		);
	});
});
