#!/usr/bin/env node
import fs from 'fs';
import { log } from '../lib/logger.mjs';

// ---------------------------------------------------------------------------
// Stop hook — logs session end. Token state is written by the submit hook
// since context_window is not available in the Stop hook input.
// ---------------------------------------------------------------------------
let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  process.stderr.write(`context-guardian: failed to parse stdin: ${e.message}\n`);
  process.exit(0);
}

log(`STOP session=${input.session_id || 'unknown'}`);
