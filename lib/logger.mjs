import fs from 'fs';
import { LOG_DIR, LOG_FILE } from './paths.mjs';

/**
 * Append a timestamped line to the shared log file.
 * Silently swallows errors — logging must never break the hook.
 */
let logDirReady = false;

export function log(msg) {
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
