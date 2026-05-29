// ── Web Search Tool ──
//
// 使用 curl 发起 HTTP 请求
// 支持: GET/POST, headers, body, 状态码检查

import { execSync } from "child_process";

export class AdamasWebSearch {
  /** HTTP GET */
  async fetch(url: string, headers?: Record<string, string>): Promise<string> {
    const headerArgs = headers
      ? Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")
      : "";

    const cmd = `curl -sL --max-time 15 ${headerArgs} '${url}'`;
    return this.exec(cmd);
  }

  /** 搜索（多后端 fallback） */
  async search(query: string, limit: number = 5): Promise<string> {
    const encoded = encodeURIComponent(query);

    // 尝试 Bing
    let html = await this.fetch(`https://www.bing.com/search?q=${encoded}`, {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    });
    if (html.includes("Bing") && html.length > 500) {
      return this.parseBing(html, query, limit);
    }

    // Fallback: DuckDuckGo Lite
    html = await this.fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    });
    if (html.length > 100) {
      return this.parseDDGLite(html, query, limit);
    }

    // Last resort: DuckDuckGo HTML
    html = await this.fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    });
    if (html.length > 100) {
      return this.parseDDG(html, query, limit);
    }

    return `Web search temporarily unavailable. Try again later, or use web_fetch to directly access URLs.\n\nTip: Try searching on your own and share the URL, or use "web_fetch" with a known URL.`;
  }

  private parseBing(html: string, query: string, limit: number): string {
    const results: string[] = [];
    const re = /<h2><a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a><\/h2>/gi;
    let match, i = 0;
    while ((match = re.exec(html)) !== null && i < limit) {
      results.push(`${i + 1}. ${match[2].replace(/<[^>]+>/g, "")}\n   ${match[1]}`);
      i++;
    }
    if (results.length === 0) results.push("(Bing returned results in unexpected format — visit directly)");
    return `Search results for "${query}":\n\n${results.join("\n\n")}`;
  }

  private parseDDGLite(html: string, query: string, limit: number): string {
    return this.parseDDG(html, query, limit);
  }

  private parseDDG(html: string, query: string, limit: number): string {

    // 简单 HTML 抽取
    const results: string[] = [];
    const snippetRe = /<a[^>]*class="result__a"[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>/gi;
    let match;
    let i = 0;

    // 更简单的正则：只取标题和链接
    const titleRe = /<a[^>]*class="result__a"[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
    while ((match = titleRe.exec(html)) !== null && i < limit) {
      const url = decodeURIComponent(match[1]);
      const title = match[2].replace(/<[^>]+>/g, "");
      results.push(`${i + 1}. ${title}\n   ${url}`);
      i++;
    }

    if (results.length === 0) {
      return `No results found for "${query}". Try different keywords.`;
    }

    return `Search results for "${query}":\n\n${results.join("\n\n")}`;
  }

  /** 读取网页文本（lynx/elinks style） */
  async extractText(url: string): Promise<string> {
    const html = await this.fetch(url);

    // 简单 HTML → text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);

    return text || "(empty or failed to extract)";
  }

  private exec(cmd: string): string {
    try {
      return execSync(cmd, {
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "en_US.UTF-8" },
      }).trim();
    } catch (err: any) {
      return `Error: ${err.message || err}`;
    }
  }
}
