// ── Adamas File — 文件系统操作（Node.js fs） ──

import * as fs from "fs";
import * as path from "path";

export class AdamasFile {
  async read(filepath: string, offset = 1, limit = 500): Promise<string> {
    const content = fs.readFileSync(filepath, "utf-8");
    const lines = content.split("\n");
    const start = offset - 1;
    const end = Math.min(start + limit, lines.length);

    if (start >= lines.length) return "(file empty or offset beyond end)";

    const output = lines.slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(5)}|${line}`)
      .join("\n");

    return `${output}\n(total_lines: ${lines.length})`;
  }

  async write(filepath: string, content: string): Promise<string> {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, content);
    return `Written ${content.length} bytes to ${filepath}`;
  }

  async search(pattern: string, dir = ".", fileGlob?: string): Promise<string> {
    const results: string[] = [];
    const regex = new RegExp(pattern, "gm");

    const walkDir = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            let match;
            while ((match = regex.exec(content)) !== null) {
              const lineNum = content.substring(0, match.index).split("\n").length;
              results.push(`${fullPath}:${lineNum}: ${match[0]}`);
            }
          } catch { /* skip binary */ }
        }
      }
    };

    walkDir(dir);
    return results.slice(0, 50).join("\n") || "No matches found";
  }
}
