// ── Adamas Memory System ──
//
// JSON 文件持久化记忆
// 存储路径: ~/.adamas/memory.json
//
// 格式:
//   [
//     { "key": "pref-language", "value": "zh", "tags": ["preference"], "createdAt": 1715000000 },
//     { "key": "project-path", "value": "/home/cyborg/adamas", "tags": ["env"], "createdAt": 1715000001 }
//   ]

import * as fs from "fs";
import * as path from "path";

export interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private filePath: string;

  constructor(homeDir?: string) {
    this.filePath = path.resolve(homeDir || process.env.HOME || "/tmp", ".adamas", "memory.json");
    this.load();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.entries = JSON.parse(raw);
      if (!Array.isArray(this.entries)) this.entries = [];
    } catch {
      this.entries = [];
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch (err) {
      console.error("[memory] save failed:", err);
    }
  }

  /** 添加或更新一条记忆 */
  upsert(key: string, value: string, tags: string[] = []): MemoryEntry {
    const existing = this.entries.find(e => e.key === key);
    const now = Math.floor(Date.now() / 1000);

    if (existing) {
      existing.value = value;
      existing.tags = tags;
      existing.updatedAt = now;
      this.save();
      return existing;
    }

    const entry: MemoryEntry = { key, value, tags, createdAt: now, updatedAt: now };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** 删除一条记忆 */
  remove(key: string): boolean {
    const idx = this.entries.findIndex(e => e.key === key);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.save();
    return true;
  }

  /** 获取一条记忆 */
  get(key: string): MemoryEntry | null {
    return this.entries.find(e => e.key === key) || null;
  }

  /** 获取所有记忆 */
  getAll(): MemoryEntry[] {
    return [...this.entries].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 搜索记忆（模糊匹配 key 和 value） */
  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter(e =>
      e.key.toLowerCase().includes(q) ||
      e.value.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q))
    ).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 按标签获取 */
  getByTag(tag: string): MemoryEntry[] {
    return this.entries.filter(e => e.tags.includes(tag));
  }

  /** 获取上下文注入文本 */
  getContextPrompt(maxEntries: number = 10): string {
    const all = this.getAll();
    if (all.length === 0) return "";

    const recent = all.slice(0, maxEntries);
    let prompt = "## Memory (persistent across sessions)\n\n";
    for (const e of recent) {
      const tags = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
      prompt += `- ${e.key}${tags}: ${e.value}\n`;
    }
    prompt += "\nUse /memory to manage memories.\n";
    return prompt;
  }

  /** 清空所有记忆 */
  clear(): number {
    const count = this.entries.length;
    this.entries = [];
    this.save();
    return count;
  }
}

// 单例
let _instance: MemoryStore | null = null;
export function getMemoryStore(): MemoryStore {
  if (!_instance) _instance = new MemoryStore();
  return _instance;
}
