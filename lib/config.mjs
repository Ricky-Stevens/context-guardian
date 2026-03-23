import fs from 'fs';
import { CONFIG_FILE, ensureDataDir } from './paths.mjs';

export const DEFAULT_CONFIG = {
  threshold:  0.35,
  max_tokens: 200000,
};

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadConfig() {
  try {
    return fs.existsSync(CONFIG_FILE)
      ? { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
      : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// Resolve max_tokens.
//   1. Explicit max_tokens in config (covers most cases)
//   2. Safe default (200K)
//
// The Stop hook writes real max_tokens from the API after every response,
// so this fallback only matters for the very first message of a session.
// ---------------------------------------------------------------------------
export function resolveMaxTokens() {
  const cfg = loadConfig();
  return cfg.max_tokens || 200000;
}
