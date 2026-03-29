#!/usr/bin/env node
/**
 * CLI entry point for /cg:resume skill.
 *
 * Usage:
 *   node resume-cli.mjs list [all]         → JSON { files: [...], menu: "..." }
 *   node resume-cli.mjs load <filepath>    → JSON { success, content, type }
 */

import fs from "node:fs";
import path from "node:path";
import { formatRestoreMenu, listRestoreFiles } from "./handoff.mjs";

const [action, ...args] = process.argv.slice(2);

function out(obj) {
	process.stdout.write(JSON.stringify(obj));
}

if (action === "list") {
	const includeCheckpoints = args.includes("all");
	const projectDir = process.cwd();
	const files = listRestoreFiles(projectDir, { includeCheckpoints });
	const menu = formatRestoreMenu(files, { showType: includeCheckpoints });
	out({ success: true, files, menu });
} else if (action === "load") {
	const filePath = args[0];
	// Validate the path is within .context-guardian/ to prevent path traversal
	const cgDir = path.resolve(process.cwd(), ".context-guardian");
	if (
		!filePath ||
		!path.resolve(filePath).startsWith(cgDir) ||
		!fs.existsSync(filePath)
	) {
		out({ success: false, error: "File not found." });
		process.exit(0);
	}

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const filename = filePath.split("/").pop();
		const type = filename.startsWith("cg-handoff-") ? "handoff" : "checkpoint";
		out({ success: true, content, type });
	} catch (e) {
		out({ success: false, error: e.message });
	}
} else {
	out({
		success: false,
		error: "Usage: resume-cli.mjs list [all] | load <path>",
	});
}
