// ── Adamas File — 文件系统操作 ──
//
// Bun 原生文件 API（比 Node.js fs 快 2-3x）

export class AdamasFile {
  async read(path: string, offset = 1, limit = 500): Promise<string> {
    const content = await Bun.file(path).text();
    const lines = content.split("\n");
    const start = offset - 1;
    const end = Math.min(start + limit, lines.length);

    if (start >= lines.length) return "(file empty or offset beyond end)";

    const output = lines.slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(5)}|${line}`)
      .join("\n");

    return `${output}\n(total_lines: ${lines.length})`;
  }

  async write(path: string, content: string): Promise<string> {
    await Bun.write(path, content);
    return `Written ${content.length} bytes to ${path}`;
  }

  async search(pattern: string, dir = ".", fileGlob?: string): Promise<string> {
    const glob = new Bun.Glob(fileGlob || "**/*");
    const results: string[] = [];

    for await (const file of glob.scan(dir)) {
      try {
        const content = await Bun.file(file).text();
        const regex = new RegExp(pattern, "gm");
        let match;
        while ((match = regex.exec(content)) !== null) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          results.push(`${file}:${lineNum}: ${match[0]}`);
        }
      } catch { /* skip binary files */ }
    }

    return results.slice(0, 50).join("\n") || "No matches found";
  }
}
