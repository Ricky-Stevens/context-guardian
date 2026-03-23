#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR, STATE_FILE, RELOAD_FILE, RESUME_FILE, CHECKPOINTS_DIR, COOLDOWN_FILE,
  sessionFlags, ensureDataDir,
} from '../lib/paths.mjs';
import { log }                            from '../lib/logger.mjs';
import { loadConfig, resolveMaxTokens }   from '../lib/config.mjs';
import { getTokenUsage, estimateTokens } from '../lib/tokens.mjs';
import { extractConversation, extractRecent } from '../lib/transcript.mjs';
import { formatCompactionStats }          from '../lib/stats.mjs';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const raw   = fs.readFileSync(0, 'utf8');
const input = JSON.parse(raw);
const { session_id, prompt, transcript_path } = input;

const flags = sessionFlags(input.cwd, session_id);

function output(obj) { process.stdout.write(JSON.stringify(obj)); }

// ---------------------------------------------------------------------------
// Handle manual compact menu (from /context-guardian:compact skill)
// ---------------------------------------------------------------------------
if (fs.existsSync(flags.compactMenu)) {
  const compactChoice = (prompt || '').trim();
  if (['1', '2'].includes(compactChoice)) {
    fs.unlinkSync(flags.compactMenu);

    ensureDataDir();
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    const cStamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cExportFile = path.join(CHECKPOINTS_DIR, `session-${cStamp}.md`);

    const cMode  = compactChoice === '1' ? 'smart' : 'recent';
    const cLabel = compactChoice === '1' ? 'Smart Compact' : 'Keep Recent 20';

    log(`manual-compact choice=${compactChoice} mode=${cMode} session=${session_id}`);

    const cContent = cMode === 'smart'
      ? extractConversation(transcript_path)
      : extractRecent(transcript_path, 20);

    fs.writeFileSync(cExportFile,
      `# Context Checkpoint (${cLabel})\n> Created: ${new Date().toISOString()}\n\n${cContent}`
    );

    // Get current token counts for stats
    const cUsage     = getTokenUsage(transcript_path);
    const cPreTokens = cUsage ? cUsage.current_tokens : estimateTokens(transcript_path);
    const cPreMax    = cUsage?.max_tokens || resolveMaxTokens();
    const cFull      = fs.readFileSync(cExportFile, 'utf8');
    const { stats: cStats, block: cStatsBlock } = formatCompactionStats(cPreTokens, cPreMax, cFull);

    // Write reload flag (no original_prompt — manual compact, not blocking a message)
    fs.writeFileSync(RELOAD_FILE, JSON.stringify({
      checkpoint_path: cExportFile, original_prompt: '', ts: Date.now(), stats: cStats,
    }));

    log(`manual-compact-saved mode=${cMode} file=${cExportFile} pre=${cPreTokens} post=${cStats.postTokens} saved=${cStats.saved}`);

    output({
      decision: 'block',
      reason: cStatsBlock,
    });

    // Cooldown — prevent re-trigger for 2 minutes after compaction
    try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ ts: Date.now() })); } catch {}
  } else {
    // Invalid choice — re-show compact menu
    log(`compact-menu-invalid choice="${compactChoice}" session=${session_id}`);
    output({
      decision: 'block',
      reason: `"${compactChoice}" is not a valid option. Please reply with 1 or 2.\n\n  1  Smart Compact     full history, strip tool noise\n  2  Keep Recent       last 20 messages only`,
    });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Handle warning menu response (user replied 1/2/3/4)
// ---------------------------------------------------------------------------
if (fs.existsSync(flags.menu)) {
  const choice = (prompt || '').trim();
  if (['1', '2', '3', '4'].includes(choice)) {
    fs.unlinkSync(flags.menu);
    let originalPrompt = '';
    try { originalPrompt = fs.readFileSync(flags.prompt, 'utf8'); } catch {}
    try { fs.unlinkSync(flags.prompt); } catch {}

    ensureDataDir();
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    const stamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFile = path.join(CHECKPOINTS_DIR, `session-${stamp}.md`);

    log(`menu-reply choice=${choice} session=${session_id}`);

    if (choice === '1') {
      // Clear warned flag so it can re-trigger as context grows.
      // Use cooldown to prevent immediate re-trigger.
      try { fs.unlinkSync(flags.warned); } catch {}
      try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ ts: Date.now() })); } catch {}
      output({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            `The user chose to continue normally. Their original message (before the context warning) was:\n\n${originalPrompt}\n\nRespond to that message now.`,
        },
      });

    } else if (choice === '2') {
      const exportContent = extractConversation(transcript_path);
      fs.writeFileSync(exportFile,
        `# Context Checkpoint (Smart Compact)\n> Created: ${new Date().toISOString()}\n\n${exportContent}`
      );
      let preStats = {};
      try { preStats = JSON.parse(fs.readFileSync(flags.warned, 'utf8')); } catch {}
      const preTokens = preStats.currentTokens || 0;
      const preMax    = preStats.maxTokens || resolveMaxTokens();
      const fullCheckpoint = fs.readFileSync(exportFile, 'utf8');
      const { stats, block: statsBlock } = formatCompactionStats(preTokens, preMax, fullCheckpoint);
      fs.writeFileSync(RELOAD_FILE, JSON.stringify({
        checkpoint_path: exportFile, original_prompt: originalPrompt, ts: Date.now(), stats,
      }));
      try { fs.unlinkSync(flags.warned); } catch {}
      log(`checkpoint-saved choice=2 file=${exportFile} pre=${preTokens} post=${stats.postTokens} saved=${stats.saved}`);
      output({
        decision: 'block',
        reason: statsBlock,
      });

    } else if (choice === '3') {
      const recentContent = extractRecent(transcript_path, 20);
      fs.writeFileSync(exportFile,
        `# Context Checkpoint (Keep Recent 20)\n> Created: ${new Date().toISOString()}\n\n${recentContent}`
      );
      let preStats3 = {};
      try { preStats3 = JSON.parse(fs.readFileSync(flags.warned, 'utf8')); } catch {}
      const preTokens3 = preStats3.currentTokens || 0;
      const preMax3    = preStats3.maxTokens || resolveMaxTokens();
      const fullCheckpoint3 = fs.readFileSync(exportFile, 'utf8');
      const { stats: stats3, block: statsBlock3 } = formatCompactionStats(preTokens3, preMax3, fullCheckpoint3);
      fs.writeFileSync(RELOAD_FILE, JSON.stringify({
        checkpoint_path: exportFile, original_prompt: originalPrompt, ts: Date.now(), stats: stats3,
      }));
      try { fs.unlinkSync(flags.warned); } catch {}
      log(`checkpoint-saved choice=3 file=${exportFile} pre=${preTokens3} post=${stats3.postTokens} saved=${stats3.saved}`);
      output({
        decision: 'block',
        reason: statsBlock3,
      });

    } else if (choice === '4') {
      try { fs.unlinkSync(flags.warned); } catch {}
      output({
        decision: 'block',
        reason: `Context cleared. Type /clear to wipe context and start fresh. No checkpoint was saved.`,
      });
    }

    // Cooldown — prevent re-trigger for 2 minutes after any compaction
    if (['2', '3', '4'].includes(choice)) {
      try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ ts: Date.now() })); } catch {}
    }

  } else {
    // Invalid choice — re-show the menu
    log(`menu-invalid choice="${choice}" session=${session_id}`);
    output({
      decision: 'block',
      reason: `"${choice}" is not a valid option. Please reply with 1, 2, 3, or 4.\n\n  1  Continue\n  2  Smart Compact\n  3  Keep Recent\n  4  Clear`,
    });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Resume detection — replay original prompt after /clear + checkpoint restore
// ---------------------------------------------------------------------------
if (fs.existsSync(RESUME_FILE)) {
  const resumeInput = (prompt || '').trim().toLowerCase();
  if (resumeInput === 'resume') {
    try {
      const resumeData = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
      fs.unlinkSync(RESUME_FILE);
      if (resumeData.original_prompt && Date.now() - resumeData.ts < 10 * 60 * 1000) {
        log(`resume-replay session=${session_id} prompt="${resumeData.original_prompt.slice(0, 50)}"`);
        output({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `The user typed "resume" to continue from where they left off before context compaction. Their original message was:\n\n${resumeData.original_prompt}\n\nRespond to that message now as if it were their current request.`,
          },
        });
        process.exit(0);
      }
    } catch (e) { log(`resume-error: ${e.message}`); }
    try { fs.unlinkSync(RESUME_FILE); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Bypass slash commands
// ---------------------------------------------------------------------------
const trimmed = (prompt || '').trim().toLowerCase();
if (trimmed.startsWith('/')) process.exit(0);

// ---------------------------------------------------------------------------
// Reload detection — inject checkpoint after /clear
// ---------------------------------------------------------------------------
if (fs.existsSync(RELOAD_FILE)) {
  try {
    const reload = JSON.parse(fs.readFileSync(RELOAD_FILE, 'utf8'));
    if (Date.now() - reload.ts < 10 * 60 * 1000) {
      const checkpoint = fs.readFileSync(reload.checkpoint_path, 'utf8');
      fs.unlinkSync(RELOAD_FILE);
      try { fs.unlinkSync(COOLDOWN_FILE); } catch {}
      let reloadStatsLine = '';
      if (reload.stats) {
        const s = reload.stats;
        reloadStatsLine = `\n\nCompaction Stats\n` +
          `   Before:  ${s.preTokens.toLocaleString()} tokens (~${s.prePct}% of context)\n` +
          `   After:   ~${s.postTokens.toLocaleString()} tokens (~${s.postPct}% of context)\n` +
          `   Saved:   ~${s.saved.toLocaleString()} tokens (${s.savedPct}% reduction)`;
      }

      // If user typed "resume" as their first message after /clear, replay
      // the original prompt immediately — no need for a second "resume".
      const isResumeNow = (prompt || '').trim().toLowerCase() === 'resume';
      const hasOriginal = !!reload.original_prompt;

      if (isResumeNow && hasOriginal) {
        log(`reload-resume-immediate session=${session_id} prompt="${reload.original_prompt.slice(0, 50)}"`);
        output({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `[RESTORED CONTEXT — previous session checkpoint]\n\n${checkpoint}\n\n---${reloadStatsLine}\n\n` +
              `The user typed "resume" after /clear. Context has been restored. Their original message (before compaction) was:\n\n${reload.original_prompt}\n\nRespond to that message now.`,
          },
        });
      } else {
        // Not "resume" — inject checkpoint and tell them about resume
        if (hasOriginal) {
          ensureDataDir();
          fs.writeFileSync(RESUME_FILE, JSON.stringify({
            original_prompt: reload.original_prompt, ts: Date.now(),
          }));
        }
        const resumeHint = hasOriginal
          ? `\n\nTell the user: "Type **resume** to continue where you left off — your previous prompt will be replayed automatically."`
          : '';
        log(`reload-inject session=${session_id} checkpoint=${reload.checkpoint_path}`);
        output({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `[RESTORED CONTEXT — previous session checkpoint]\n\n${checkpoint}\n\n---${reloadStatsLine}\n\nThe user cleared context and this checkpoint was auto-restored. Show the compaction stats above so they can see the savings.${resumeHint}`,
          },
        });
      }
      process.exit(0);
    } else {
      fs.unlinkSync(RELOAD_FILE);
      log(`reload-expired session=${session_id}`);
    }
  } catch (e) { try { fs.unlinkSync(RELOAD_FILE); } catch {} log(`reload-error: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Token usage check
// ---------------------------------------------------------------------------
if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

const cfg       = loadConfig();
const threshold = cfg.threshold ?? 0.35;

const realUsage     = getTokenUsage(transcript_path);
const currentTokens = realUsage ? realUsage.current_tokens : estimateTokens(transcript_path);
const maxTokens     = realUsage?.max_tokens || resolveMaxTokens();
const pct           = currentTokens / maxTokens;
const source        = realUsage ? 'real' : 'estimated';

log(`check session=${session_id} tokens=${currentTokens}/${maxTokens} pct=${(pct*100).toFixed(1)}% threshold=${(threshold*100).toFixed(0)}% source=${source} warned=${fs.existsSync(flags.warned)}`);

// Write state so /context-guardian:status can read it
try {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    current_tokens: currentTokens, max_tokens: maxTokens, pct,
    source, model: realUsage?.model || 'unknown',
    session_id, transcript_path, ts: Date.now(),
  }));
} catch {}

// Below threshold: reset warned flag so it can re-fire if context grows back
if (pct < threshold) {
  try { fs.unlinkSync(flags.warned); } catch {}
  process.exit(0);
}

// Cooldown after compaction — don't re-trigger for 2 minutes
if (fs.existsSync(COOLDOWN_FILE)) {
  try {
    const cd = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    if (Date.now() - cd.ts < 2 * 60 * 1000) {
      log(`cooldown active — skipping threshold (${Math.round((Date.now() - cd.ts) / 1000)}s since compaction)`);
      process.exit(0);
    }
    fs.unlinkSync(COOLDOWN_FILE);
  } catch {}
}

// Already warned this session
if (fs.existsSync(flags.warned)) process.exit(0);

// ---------------------------------------------------------------------------
// Show menu
// ---------------------------------------------------------------------------
fs.mkdirSync(flags.dir, { recursive: true });
fs.writeFileSync(flags.warned, JSON.stringify({ pct, currentTokens, maxTokens, ts: Date.now() }));
fs.writeFileSync(flags.menu,   '1');
fs.writeFileSync(flags.prompt, prompt || '');

log(`BLOCKED session=${session_id} pct=${(pct*100).toFixed(1)}% source=${source}`);

output({
  decision: 'block',
  reason: [
    `Context Guardian — ~${(pct*100).toFixed(1)}% used (~${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens)`,
    ``,
    `  1  Continue          proceed with your request (it's saved, don't retype it)`,
    `  2  Smart Compact     keep full history, strip tool calls & internal noise`,
    `  3  Keep Recent       drop oldest, keep last 20 messages`,
    `  4  Clear             wipe everything`,
    ``,
    `Reply with 1, 2, 3, or 4.`,
  ].join('\n'),
});

process.exit(0);
