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
	let raw = {};
	try {
		raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
	} catch {}
	_cachedConfig = { ...DEFAULT_CONFIG, ...raw };
	// Track whether the user explicitly set a threshold via /cg:config.
	// If not, hooks and statusline use the adaptive threshold instead.
	_cachedConfig._thresholdExplicit = "threshold" in raw;
	return _cachedConfig;
}

// ---------------------------------------------------------------------------
// Resolve max_tokens.
//   1. Explicit max_tokens in config (covers most cases)
//   2. Safe default (200K)
//
// The statusline writes the authoritative context_window_size to the
// per-session state file. This config value is the fallback before the
// statusline has fired.
// ---------------------------------------------------------------------------
export function resolveMaxTokens() {
	const cfg = loadConfig();
	return cfg.max_tokens ?? 200000;
}

// ---------------------------------------------------------------------------
// Adaptive threshold — scales with context window size.
//
// Context rot research shows quality degrades measurably at 80-150K tokens
// regardless of window size. A 200K window needs a higher threshold (alert
// earlier as a %) because system overhead eats a large share. A 1M window
// needs a lower threshold so the alert fires before quality degrades.
//
//   200K → 55%  (alert at 110K tokens)
//   500K → 46%  (alert at 230K tokens)
//     1M → 30%  (alert at 300K tokens)
//
// If the user explicitly set a threshold via /cg:config, that wins.
// ---------------------------------------------------------------------------
export function adaptiveThreshold(maxTokens) {
	const cfg = loadConfig();
	if (cfg._thresholdExplicit) return cfg.threshold;
	return computeAdaptiveThreshold(maxTokens ?? cfg.max_tokens ?? 200000);
}

export function computeAdaptiveThreshold(maxTokens) {
	return Math.min(
		0.55,
		Math.max(0.25, 0.55 - ((maxTokens - 200000) * 0.25) / 800000),
	);
}
