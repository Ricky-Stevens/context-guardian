import { Buffer } from 'node:buffer';

/**
 * Calculate compaction stats and format a display block.
 *
 * @param {number} preTokens  — token count before compaction
 * @param {number} maxTokens  — context window limit
 * @param {string} checkpointContent — the exported checkpoint text
 * @returns {{ stats: object, block: string }}
 */
export function formatCompactionStats(preTokens, maxTokens, checkpointContent) {
  const postTokens = Math.round(Buffer.byteLength(checkpointContent, 'utf8') / 4);
  const saved      = preTokens - postTokens;
  const savedPct   = preTokens > 0 ? ((saved / preTokens) * 100).toFixed(1) : '0.0';
  const prePct     = ((preTokens / maxTokens) * 100).toFixed(1);
  const postPct    = ((postTokens / maxTokens) * 100).toFixed(1);

  const stats = {
    preTokens, postTokens, maxTokens, saved,
    savedPct: parseFloat(savedPct),
    prePct:   parseFloat(prePct),
    postPct:  parseFloat(postPct),
  };

  const block = [
    `┌──────────────────────────────────────────────────────────────────────────────────────────────────`,
    `│  Compaction Stats`,
    `│`,
    `│  Before:  ${preTokens.toLocaleString()} tokens (~${prePct}% of context)`,
    `│  After:   ~${postTokens.toLocaleString()} tokens (~${postPct}% of context)`,
    `│  Saved:   ~${saved.toLocaleString()} tokens (${savedPct}% reduction)`,
    `├──────────────────────────────────────────────────────────────────────────────────────────────────`,
    `│`,
    `│  Checkpoint saved — NOT applied yet.`,
    `│`,
    `│  Next steps:`,
    `│  1. Type /clear to apply the compaction`,
    `│  2. Type resume to pick up where you left off`,
    `│     (your previous prompt replays automatically)`,
    `│`,
    `└──────────────────────────────────────────────────────────────────────────────────────────────────`,
  ].join('\n');

  return { stats, block };
}
