/**
 * Shared NDJSON / SSE token stream -> sentence-chunk accumulator for low-latency TTS.
 */
export async function consumeTokenStream(response, extractToken, onSentence = null) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';
  let sentBuf = '';
  let fullText = '';
  let sentIdx = 0;

  const flushSentences = (force = false) => {
    while (sentBuf) {
      const m = sentBuf.match(/^([\s\S]*?[.!?]+)(?:\s+|$)/);
      if (m && m[1].trim().length >= 16) {
        const piece = m[1].trim();
        sentBuf = sentBuf.slice(m[0].length);
        onSentence?.(piece, sentIdx++);
      } else if (force && sentBuf.trim()) {
        const piece = sentBuf.trim();
        sentBuf = '';
        onSentence?.(piece, sentIdx++);
      } else {
        break;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    let nl = lineBuf.indexOf('\n');
    while (nl >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      nl = lineBuf.indexOf('\n');
      if (!line) continue;
      const tok = extractToken(line);
      if (tok) {
        fullText += tok;
        sentBuf += tok;
        flushSentences(false);
      }
    }
  }
  const tail = lineBuf.trim();
  if (tail) {
    const tok = extractToken(tail);
    if (tok) {
      fullText += tok;
      sentBuf += tok;
    }
  }
  flushSentences(true);
  return fullText.trim();
}
