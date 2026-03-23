#!/usr/bin/env node
import fs from 'fs';
import { log } from '../lib/logger.mjs';

// ---------------------------------------------------------------------------
// Stop hook — logs session end. Token state is written by the submit hook
// since context_window is not available in the Stop hook input.
// ---------------------------------------------------------------------------
const input = JSON.parse(fs.readFileSync(0, 'utf8'));

if (input.stop_hook_active) process.exit(0);

log(`STOP session=${input.session_id || 'unknown'}`);
