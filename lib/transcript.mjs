import fs from 'fs';
import { flattenContent } from './content.mjs';

// ---------------------------------------------------------------------------
// Smart Compact — extract full conversation history, strip tool noise.
//
// Keeps:  user messages (first text block), assistant text blocks
// Strips: tool_use, tool_result, thinking blocks, system messages,
//         skill injections (long #-heading messages), menu replies (1-4),
//         previous compact markers
// Preserves: the most recent compact block as a preamble (prior history)
// ---------------------------------------------------------------------------
export function extractConversation(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '(no transcript available)';
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());

  // Find the last compact marker — everything before it is already summarised.
  let compactPreamble = '';
  let compactIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj  = JSON.parse(lines[i]);
      const text = flattenContent(obj.message?.content).trim();
      if (text.startsWith('[SMART COMPACT') || text.startsWith('[KEEP RECENT')) {
        compactPreamble = text;
        compactIdx = i;
        break;
      }
    } catch {}
  }

  const messages = [];
  for (let i = compactIdx + 1; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === 'user' && obj.message?.role === 'user') {
        const text = flattenContent(obj.message.content).trim();
        if (!text) continue;
        if (text.match(/^[1-4]$/)) continue;                          // menu reply
        if (text.startsWith('[SMART COMPACT') || text.startsWith('[KEEP RECENT')) continue;
        if (text.length > 500 && /^#{1,3} /.test(text)) continue;     // skill injection
        messages.push(`**User:** ${text}`);
      }
      if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const content = obj.message.content;
        const text = Array.isArray(content)
          ? content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
          : typeof content === 'string' ? content.trim() : '';
        if (text) messages.push(`**Assistant:** ${text}`);
      }
    } catch {}
  }

  const extracted = messages.join('\n\n---\n\n');
  return compactPreamble ? `${compactPreamble}\n\n---\n\n${extracted}` : extracted;
}

// ---------------------------------------------------------------------------
// Keep Recent — take the last N user/assistant messages.
// Simpler than Smart Compact: no preamble logic, just a sliding window.
// ---------------------------------------------------------------------------
export function extractRecent(transcriptPath, n) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '(no transcript available)';
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());

  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message?.role === 'user') {
        const text = flattenContent(obj.message.content).trim();
        if (!text || text.match(/^[1-4]$/)) continue;
        if (text.length > 500 && /^#{1,3} /.test(text)) continue;
        messages.push({ role: 'user', text });
      }
      if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const content = obj.message.content;
        const text = Array.isArray(content)
          ? content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
          : typeof content === 'string' ? content.trim() : '';
        if (text) messages.push({ role: 'assistant', text });
      }
    } catch {}
  }

  return messages
    .slice(-n)
    .map(m => `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${m.text}`)
    .join('\n\n---\n\n');
}
