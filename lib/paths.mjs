import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Plugin data directory — persistent storage that survives plugin updates.
// Falls back to ~/.claude/context-guardian/ for standalone / local testing.
// ---------------------------------------------------------------------------
export const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'context-guardian');

// ---------------------------------------------------------------------------
// Plugin root — where hook and lib scripts live.
// Falls back to the repo root (parent of lib/) for standalone use.
// ---------------------------------------------------------------------------
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  || path.resolve(new URL('.', import.meta.url).pathname, '..');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export const LOG_DIR  = path.join(os.homedir(), '.claude', 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'context-guardian.log');

// ---------------------------------------------------------------------------
// Persistent state files (plugin-scoped, survive /clear)
// ---------------------------------------------------------------------------
export const CONFIG_FILE     = path.join(DATA_DIR, 'config.json');
export const STATE_FILE      = path.join(DATA_DIR, 'state.json');
export const CHECKPOINTS_DIR = path.join(DATA_DIR, 'checkpoints');

// ---------------------------------------------------------------------------
// Project-scoped state files — keyed by a short hash of the project cwd so
// that simultaneous sessions in different projects don't interfere.
// Must live in DATA_DIR (not .claude/) so they survive /clear.
// ---------------------------------------------------------------------------
function cwdHash(cwd) {
  const dir = cwd || process.cwd();
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
}
export function projectStateFiles(cwd) {
  const h = cwdHash(cwd);
  return {
    reload:   path.join(DATA_DIR, `reload-${h}.json`),
    resume:   path.join(DATA_DIR, `resume-${h}.json`),
    cooldown: path.join(DATA_DIR, `cooldown-${h}.json`),
  };
}

// ---------------------------------------------------------------------------
// Session-scoped flags — stored in the project's .claude/ directory so they
// are isolated per project and cleared by SessionStart.
// ---------------------------------------------------------------------------
export function sessionFlags(cwd, sessionId) {
  const dir = path.join(cwd || process.cwd(), '.claude');
  return {
    dir,
    warned:      path.join(dir, `cg-warned-${sessionId}`),
    menu:        path.join(dir, `cg-menu-${sessionId}`),
    prompt:      path.join(dir, `cg-prompt-${sessionId}`),
    compactMenu: path.join(dir, `cg-compact-${sessionId}`),
  };
}

// ---------------------------------------------------------------------------
// Ensure the data directory exists on first use.
// ---------------------------------------------------------------------------
export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
