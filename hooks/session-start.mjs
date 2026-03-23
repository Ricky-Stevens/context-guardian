#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RESUME_FILE, COOLDOWN_FILE } from '../lib/paths.mjs';
import { log } from '../lib/logger.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));

// Clean up session-scoped flags in the project's .claude/ directory.
const flagsDir = path.join(input.cwd || process.cwd(), '.claude');
if (fs.existsSync(flagsDir)) {
  try {
    for (const f of fs.readdirSync(flagsDir).filter(f => f.startsWith('cg-'))) {
      try { fs.unlinkSync(path.join(flagsDir, f)); } catch {}
    }
  } catch {}
}

// Clear stale resume prompt and cooldown from previous sessions.
// Note: the reload handler in submit.mjs re-creates RESUME_FILE AFTER
// SessionStart fires, so this only clears leftovers from old sessions.
try { fs.unlinkSync(RESUME_FILE); } catch {}
try { fs.unlinkSync(COOLDOWN_FILE); } catch {}

// Clean up legacy /tmp state file if present.
if (input.session_id) {
  try { fs.unlinkSync(path.join(os.tmpdir(), `cg-state-${input.session_id}.json`)); } catch {}
}

log(`session-start session=${input.session_id || 'unknown'} cwd=${input.cwd || 'unknown'}`);
