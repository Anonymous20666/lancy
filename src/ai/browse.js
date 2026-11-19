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
   * Search Wikipedia + DuckDuckGo HTML concurrently for reliable real-time web knowledge.
   */
  async search(query, { maxResults = 5 } = {}) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return [];

    const ddgPromise = (async () => {
      const out = [];
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          signal: controller.signal
        }).finally(() => clearTimeout(timer));

        if (res.ok) {
          const text = await res.text();
          const resultBlocks = text.split(/class="result\s+results_links/g).slice(1);
          for (const block of resultBlocks) {
            if (out.length >= maxResults) break;
            const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i)
              || block.match(/<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
            const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
            const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/i)
              || block.match(/<a[^>]+class="result__url"[^>]+href="([^"]+)"/i);

            const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : '';
            const title = titleMatch ? cleanHtml(titleMatch[1]) : '';
            const url = linkMatch ? linkMatch[1] : '';
            if (snippet || title) {
              out.push({ title: title.slice(0, 120), snippet: snippet.slice(0, 360), url });
            }
          }
        }
      } catch {}
      return out;
    })();

    const wikiPromise = this.searchWikipedia(cleanQuery, { maxResults: 3 }).catch(() => []);
    const [ddgHits, wikiHits] = await Promise.all([ddgPromise, wikiPromise]);

    const merged = [...ddgHits];
    for (const w of wikiHits) {
      if (!merged.some((m) => m.title?.toLowerCase() === w.title?.toLowerCase())) {
        merged.push(w);
      }
    }
    if (!merged.length) {
      const exact = await this.getWikipediaSummary(cleanQuery).catch(() => null);
      if (exact) merged.push(exact);
    }
    return merged.slice(0, maxResults);
  }

  /**
   * Search Wikipedia via MediaWiki search + extracts API (fast, rich plot & fact coverage).
   */
  async searchWikipedia(query, { maxResults = 3, extractChars = 600 } = {}) {
    const cleanTopic = String(query || '').replace(/\b(?:plot\s+summary|story\s+summary|summary|what\s+is|tell\s+me\s+about)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (!cleanTopic) return [];
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanTopic)}&format=json&srlimit=${maxResults}&origin=*`;
      const sRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'LancyBot/2.0 (contact@lancy.studio)' },
        signal: AbortSignal.timeout(4000)
      });
      if (!sRes.ok) return [];
      const sData = await sRes.json();
      const hits = sData?.query?.search || [];
      if (!hits.length) return [];

      const titles = hits.slice(0, maxResults).map((h) => h.title).join('|');
      const extUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=false&explaintext=true&exchars=${extractChars}&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
      const eRes = await fetch(extUrl, {
        headers: { 'User-Agent': 'LancyBot/2.0 (contact@lancy.studio)' },
        signal: AbortSignal.timeout(4000)
      }).catch(() => null);
      const eData = eRes?.ok ? await eRes.json().catch(() => null) : null;
      const pages = Object.values(eData?.query?.pages || {});

      return hits.slice(0, maxResults).map((h) => {
        const page = pages.find((p) => p.title === h.title);
        const snippet = page?.extract ? cleanHtml(page.extract).slice(0, extractChars) : cleanHtml(h.snippet || '');
        return {
          title: h.title,
          snippet,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/\s+/g, '_'))}`
        };
      });
    } catch {
      return [];
    }
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
   * Structured research payload for tool execution (results + top excerpt).
   */
  async researchStructured(query, { maxResults = 4 } = {}) {
    const hits = await this.search(query, { maxResults });
    if (!hits.length) return { results: [], topExcerpt: null };
    return {
      results: hits,
      topExcerpt: hits[0]?.snippet || null
    };
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
