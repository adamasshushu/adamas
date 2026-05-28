// ── Adamas Browser — Camoufox 原生集成 ──
//
// 关键优势：TypeScript 重构后，不再是 HTTP 调用
// 直接 import camoufox-js，进程内操作浏览器 → 零网络延迟

export class AdamasBrowser {
  private camoufox: any = null;
  private activeTab: string | null = null;

  async init(url = "http://localhost:9377"): Promise<void> {
    try {
      // 原生 import — 不走 HTTP
      this.camoufox = await import("camoufox-js");
      await this.camoufox.connect(url);
      console.log(`[adamas] Camoufox connected: ${url}`);
    } catch {
      // 降级到 HTTP REST API
      console.warn("[adamas] Camoufox native import failed, using REST fallback");
    }
  }

  async navigate(url: string): Promise<string> {
    if (this.camoufox) {
      const tab = await this.camoufox.open(url);
      this.activeTab = tab.id;
      return `Navigated to ${url}\nTitle: ${tab.title}`;
    }
    return this.restPost("/navigate", { url });
  }

  async snapshot(full = false): Promise<string> {
    if (this.camoufox && this.activeTab) {
      const snap = await this.camoufox.snapshot(this.activeTab, { full });
      const elements = snap.elements?.map((e: any) =>
        `  [${e.refId}] ${e.tag} "${e.text}"`
      ).join("\n") || "";
      return `URL: ${snap.url}\nTitle: ${snap.title}\n\nInteractive elements:\n${elements}`;
    }
    return this.restGet(`/snapshot?full=${full}`);
  }

  async click(refId: string): Promise<string> {
    if (this.camoufox && this.activeTab) {
      await this.camoufox.click(this.activeTab, refId);
      return `Clicked ${refId}`;
    }
    return this.restPost("/click", { ref: refId });
  }

  async screenshot(annotate = false): Promise<string> {
    if (this.camoufox && this.activeTab) {
      const shot = await this.camoufox.screenshot(this.activeTab, { annotate });
      return `Screenshot: MEDIA:${shot.path}\nSize: ${shot.width}x${shot.height}`;
    }
    return this.restGet(`/screenshot?annotate=${annotate}`);
  }

  async health(): Promise<boolean> {
    try {
      if (this.camoufox) return true;
      const resp = await fetch("http://localhost:9377/health");
      const json = await resp.json();
      return json.ok === true;
    } catch {
      return false;
    }
  }

  // ── REST 降级 ──
  private async restPost(path: string, body: unknown): Promise<string> {
    const resp = await fetch(`http://localhost:9377${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return JSON.stringify(await resp.json());
  }

  private async restGet(path: string): Promise<string> {
    const resp = await fetch(`http://localhost:9377${path}`);
    return JSON.stringify(await resp.json());
  }
}
