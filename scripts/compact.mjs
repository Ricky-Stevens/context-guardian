#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Manual compaction script — invoked by the /context-guardian:compact skill.
//
// Usage:
//   node compact.mjs smart    — full history, strip noise
//   node compact.mjs recent   — keep last 20 messages
//
// Reads state.json for transcript_path and token counts.
// Writes checkpoint + reload flag, outputs stats JSON to stdout.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STATE_FILE, RELOAD_FILE, CHECKPOINTS_DIR, ensureDataDir } from '../lib/paths.mjs';
import { log }                  from '../lib/logger.mjs';
import { loadConfig, resolveMaxTokens } from '../lib/config.mjs';
import { getTokenUsage, estimateTokens } from '../lib/tokens.mjs';
import { extractConversation, extractRecent } from '../lib/transcript.mjs';
import { formatCompactionStats } from '../lib/stats.mjs';

const rawMode = (process.argv[2] || '').toLowerCase();
const MODE_MAP = { '1': 'smart', '2': 'recent', smart: 'smart', recent: 'recent' };
const mode = MODE_MAP[rawMode];

if (!mode) {
  console.error(JSON.stringify({
    error: true,
    message: 'Usage: node compact.mjs <smart|recent|1|2>',
  }));
  process.exit(1);
}

// Read token state from the Stop hook
let state = null;
if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
}

if (!state || !state.transcript_path) {
  console.error(JSON.stringify({
    error: true,
    message: 'No token state available. Send at least one message first so the submit hook can capture your session data.',
  }));
  process.exit(1);
}

const { transcript_path } = state;
// Get fresh token counts from the transcript
const realUsage     = getTokenUsage(transcript_path);
const current_tokens = realUsage ? realUsage.current_tokens : estimateTokens(transcript_path);
const max_tokens     = state.max_tokens || resolveMaxTokens();

if (!fs.existsSync(transcript_path)) {
  console.error(JSON.stringify({
    error: true,
    message: `Transcript not found at ${transcript_path}`,
  }));
  process.exit(1);
}

// Run extraction
const content = mode === 'smart'
  ? extractConversation(transcript_path)
  : extractRecent(transcript_path, 20);

const label = mode === 'smart' ? 'Smart Compact' : 'Keep Recent 20';

// Write checkpoint
ensureDataDir();
fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
const stamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const exportFile = path.join(CHECKPOINTS_DIR, `session-${stamp}.md`);

fs.writeFileSync(exportFile,
  `# Context Checkpoint (${label})\n> Created: ${new Date().toISOString()}\n\n${content}`
);

// Calculate stats
const preTokens = current_tokens || 0;
const preMax    = max_tokens || resolveMaxTokens();
const fullCheckpoint = fs.readFileSync(exportFile, 'utf8');
const { stats, block } = formatCompactionStats(preTokens, preMax, fullCheckpoint);

// Write reload flag (no original_prompt — this is a manual compact)
fs.writeFileSync(RELOAD_FILE, JSON.stringify({
  checkpoint_path: exportFile,
  original_prompt: '',
  ts: Date.now(),
  stats,
}));

log(`manual-compact mode=${mode} file=${exportFile} pre=${preTokens} post=${stats.postTokens} saved=${stats.saved}`);

// Output for the skill to display
console.log(JSON.stringify({
  error: false,
  mode,
  label,
  checkpoint: exportFile,
  stats,
  block,
}));
