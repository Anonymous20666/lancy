/**
 * Web browsing and research capability for Lancy AI Assistant.
 * Provides live search, Wikipedia summaries, and page content extraction.
 */

function cleanHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class WebBrowser {
  constructor({ userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', timeoutMs = 8000 } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Search DuckDuckGo HTML for web results.
   */
  async search(query, { maxResults = 5 } = {}) {
    const results = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const text = await res.text();
        // Extract results from DDG HTML: class="result__snippet" and class="result__url"
        const resultBlocks = text.split(/class="result\s+results_links/g).slice(1);
        for (const block of resultBlocks) {
          if (results.length >= maxResults) break;
          const titleMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
            || block.match(/<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
          const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
          const linkMatch = block.match(/<a[^>]+class="result__url"[^>]+href="([^"]+)"/i);

          const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : '';
          const title = titleMatch ? cleanHtml(titleMatch[1]) : '';
          const url = linkMatch ? linkMatch[1] : '';

          if (snippet || title) {
            results.push({
              title: title.slice(0, 100),
              snippet: snippet.slice(0, 300),
              url
            });
          }
        }
      }
    } catch {
      // Fallback below
    }

    // Also check Wikipedia summary for rich character / anime lore if few results
    if (results.length < 2) {
      try {
        const wikiRes = await this.getWikipediaSummary(query);
        if (wikiRes) {
          results.unshift(wikiRes);
        }
      } catch {}
    }

    return results.slice(0, maxResults);
  }

  /**
   * Fetch a clean text summary from Wikipedia REST API.
   */
  async getWikipediaSummary(topic) {
    try {
      const cleanTopic = topic.replace(/sticker(s)?|aesthetic|pack|anime|wallpaper/gi, '').trim();
      if (!cleanTopic) return null;
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTopic)}`, {
        headers: { 'User-Agent': 'LancyBot/2.0 (contact@lancy.studio)' },
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.extract) {
        return {
          title: data.title ?? cleanTopic,
          snippet: data.extract.slice(0, 400),
          url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanTopic)}`
        };
      }
    } catch {}
    return null;
  }

  /**
   * Fetch a webpage and return a clean excerpt.
   */
  async fetchPageExcerpt(url, { maxChars = 1000 } = {}) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent },
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      if (!res.ok) return null;
      const html = await res.text();
      const text = cleanHtml(html);
      return text.slice(0, maxChars);
    } catch {
      return null;
    }
  }

  /**
   * High-level research summary for prompt injection.
   */
  async research(query) {
    const hits = await this.search(query, { maxResults: 3 });
    if (!hits.length) return null;
    return hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.snippet}`).join('\n');
  }
}
