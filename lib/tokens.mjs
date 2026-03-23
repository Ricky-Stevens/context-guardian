import fs from 'fs';
import { flattenContent, contentBytesOf } from './content.mjs';

// ---------------------------------------------------------------------------
// Get real token usage from the transcript JSONL.
//
// Every assistant message includes `message.usage` with:
//   input_tokens, cache_creation_input_tokens, cache_read_input_tokens
//
// Total context used = input_tokens + cache_creation + cache_read
//
// Reads backwards from the end of the file for efficiency.
// Returns { current_tokens, output_tokens } or null if no usage data found.
// ---------------------------------------------------------------------------
export function getTokenUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  // Read the last ~512KB — enough to find the most recent assistant message
  const stat = fs.statSync(transcriptPath);
  const readSize = Math.min(stat.size, 512 * 1024);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      const usage = obj.message?.usage;
      if (usage && typeof usage.input_tokens === 'number') {
        const inputTokens = usage.input_tokens || 0;
        const cacheCreate = usage.cache_creation_input_tokens || 0;
        const cacheRead   = usage.cache_read_input_tokens || 0;
        const output      = usage.output_tokens || 0;

        // Detect max_tokens from model name in the same message.
        // Only Opus 4.6+ has 1M tokens. Format: "claude-opus-4-6"
        const model = (obj.message?.model || '').toLowerCase();
        let max_tokens = 200000; // default for all Sonnet/Haiku/older Opus
        const opusMatch = model.match(/opus[- ]?(\d+)[- .]?(\d+)?/);
        if (opusMatch) {
          const major = parseInt(opusMatch[1], 10);
          const minor = parseInt(opusMatch[2] || '0', 10);
          if (major > 4 || (major === 4 && minor >= 6)) {
            max_tokens = 1000000;
          }
        }

        return {
          current_tokens: inputTokens + cacheCreate + cacheRead,
          output_tokens: output,
          max_tokens,
          model: obj.message?.model || 'unknown',
        };
      }
    } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Byte-based token estimation — fallback when no usage data is available
// (e.g., very first message before any assistant response).
// Counts content bytes after the last compact marker, divides by 4.
// ---------------------------------------------------------------------------
export function estimateTokens(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;

  // Read the last ~1MB — enough to cover content since the last compact marker.
  const stat = fs.statSync(transcriptPath);
  const readSize = Math.min(stat.size, 1024 * 1024);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
  } finally {
    fs.closeSync(fd);
  }

  const lines = buf.toString('utf8').split('\n').filter(l => l.trim());

  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj  = JSON.parse(lines[i]);
      const text = flattenContent(obj.message?.content);
      if (text.startsWith('[SMART COMPACT') || text.startsWith('[KEEP RECENT')) {
        startIdx = i;
        break;
      }
    } catch {}
  }

  let bytes = 0;
  for (let i = startIdx; i < lines.length; i++) {
    try { bytes += contentBytesOf(JSON.parse(lines[i]).message?.content); } catch {}
  }
  return Math.round(bytes / 4);
}
