import fs from 'fs';
import { LOG_DIR, LOG_FILE } from './paths.mjs';

/**
 * Append a timestamped line to the shared log file.
 * Silently swallows errors — logging must never break the hook.
 */
export function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
