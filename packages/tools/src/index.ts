// ── Adamas 工具系统 ──
//
// 注册表 + 所有内置工具
// Camoufox 浏览器工具是原生集成（import，不走 HTTP）

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@adamas/core";
import { AdamasTerminal } from "./terminal";
import { AdamasBrowser } from "./browser";
import { AdamasFile } from "./file";
import { AdamasWebSearch } from "./web-search";

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /** 注册工具 */
  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 获取所有工具 */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 按平台过滤 */
  getFor(platform: string): ToolDefinition[] {
    return this.getAll().filter(t =>
      platform === "cli" || t.toolset !== "system"
    );
  }

  /** 创建默认工具集 */
  static async createDefault(): Promise<ToolRegistry> {
    const registry = new ToolRegistry();

    // 终端工具（Rust 原生 addon）
    const terminal = new AdamasTerminal();
    registry.register({
      name: "terminal",
      description: "Execute shell commands on Linux",
      toolset: "terminal",
      schema: z.object({
        command: z.string().describe("The shell command to execute"),
        workdir: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in seconds"),
      }),
      execute: async (args, ctx) => terminal.exec(args.command, args.workdir, args.timeout),
    });

    // 浏览器工具（Camoufox 原生）
    const browser = new AdamasBrowser();
    registry.register({
      name: "browser_navigate",
      description: "Navigate to a URL in stealth browser",
      toolset: "browser",
      schema: z.object({ url: z.string().describe("URL to navigate to") }),
      execute: async (args) => browser.navigate(args.url),
    });
    registry.register({
      name: "browser_snapshot",
      description: "Get accessibility tree snapshot of current page",
      toolset: "browser",
      schema: z.object({ full: z.boolean().optional().describe("Full page content") }),
      execute: async (args) => browser.snapshot(args.full ?? false),
    });
    registry.register({
      name: "browser_click",
      description: "Click element by ref ID",
      toolset: "browser",
      schema: z.object({ ref: z.string().describe("Element reference ID") }),
      execute: async (args) => browser.click(args.ref),
    });
    registry.register({
      name: "browser_screenshot",
      description: "Take screenshot of current page",
      toolset: "browser",
      schema: z.object({ annotate: z.boolean().optional() }),
      execute: async (args) => browser.screenshot(args.annotate ?? false),
    });

    // 文件工具
    const file = new AdamasFile();
    registry.register({
      name: "read_file",
      description: "Read a text file with line numbers",
      toolset: "file",
      schema: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
      execute: async (args) => file.read(args.path, args.offset ?? 1, args.limit ?? 500),
    });
    registry.register({
      name: "write_file",
      description: "Write content to a file",
      toolset: "file",
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: async (args) => file.write(args.path, args.content),
    });

    // Web 工具
    const web = new AdamasWebSearch();
    registry.register({
      name: "web_search",
      description: "Search the web using DuckDuckGo. Returns titles and URLs.",
      toolset: "web",
      schema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 5)"),
      }),
      execute: async (args) => web.search(args.query, args.limit ?? 5),
    });
    registry.register({
      name: "web_fetch",
      description: "Fetch and extract text content from a URL",
      toolset: "web",
      schema: z.object({ url: z.string().describe("URL to fetch") }),
      execute: async (args) => web.extractText(args.url),
    });

    return registry;
  }
}
