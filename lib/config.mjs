import fs from "node:fs";
import { CONFIG_FILE } from "./paths.mjs";

const DEFAULT_CONFIG = {
	threshold: 0.35,
	max_tokens: 200000,
};

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

let _cachedConfig = null;

export function loadConfig() {
	if (_cachedConfig) return _cachedConfig;
	try {
		_cachedConfig = {
			...DEFAULT_CONFIG,
			...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")),
		};
	} catch {
		_cachedConfig = { ...DEFAULT_CONFIG };
	}
	return _cachedConfig;
}

// ---------------------------------------------------------------------------
// Resolve max_tokens.
//   1. Explicit max_tokens in config (covers most cases)
//   2. Safe default (200K)
//
// The submit hook detects max_tokens from the model name in the transcript
// (getTokenUsage in tokens.mjs). This config value is the initial fallback
// before any assistant response provides real model info.
// ---------------------------------------------------------------------------
export function resolveMaxTokens() {
	const cfg = loadConfig();
	return cfg.max_tokens ?? 200000;
}
