#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import { projectStateFiles } from '../lib/paths.mjs';
import { log } from '../lib/logger.mjs';

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  process.stderr.write(`context-guardian: failed to parse stdin: ${e.message}\n`);
  process.exit(0);
}

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
// Note: the reload handler in submit.mjs re-creates resume AFTER
// SessionStart fires, so this only clears leftovers from old sessions.
const pState = projectStateFiles(input.cwd);
try { fs.unlinkSync(pState.resume); } catch {}
try { fs.unlinkSync(pState.cooldown); } catch {}

log(`session-start session=${input.session_id || 'unknown'} cwd=${input.cwd || 'unknown'}`);
