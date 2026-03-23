/**
 * Extract the first text string from a Claude message content field.
 * Handles string, array-of-blocks, and null/undefined.
 */
export function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

/**
 * Count the byte size of message content (text + tool input).
 * Used for token estimation when real counts are unavailable.
 */
export function contentBytesOf(content) {
  if (!content) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (Array.isArray(content)) {
    let sum = 0;
    for (const b of content) {
      if (b.text)    sum += Buffer.byteLength(b.text, 'utf8');
      if (b.input)   sum += Buffer.byteLength(JSON.stringify(b.input), 'utf8');
      if (b.content) sum += contentBytesOf(b.content);
    }
    return sum;
  }
  return 0;
}
