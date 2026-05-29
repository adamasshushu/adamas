// ── Adamas Skill System ──
//
// 从 ~/.adamas/skills/ 加载 markdown 技能模块
// 每个 .md 文件 = 一个 skill，支持 YAML frontmatter
//
// 格式:
//   ---
//   name: code-review
//   description: Review PRs and code quality
//   trigger: review|PR|code quality
//   ---
//   # Skill content (markdown)
//

import * as fs from "fs";
import * as path from "path";

export interface Skill {
  name: string;
  description: string;
  trigger?: string;     // regex for auto-activation
  content: string;       // markdown body
  path: string;          // file path
  loadedAt: number;      // timestamp
}

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;

  constructor(homeDir?: string) {
    this.skillsDir = path.resolve(homeDir || process.env.HOME || "/tmp", ".adamas", "skills");
    this.ensureDir();
  }

  private ensureDir() {
    try { fs.mkdirSync(this.skillsDir, { recursive: true }); } catch {}
  }

  /** 列出所有可用 skill */
  list(): { name: string; description: string; trigger?: string }[] {
    const result: { name: string; description: string; trigger?: string }[] = [];
    try {
      const files = fs.readdirSync(this.skillsDir);
      for (const file of files) {
        if (!file.endsWith(".md") && !file.endsWith(".skill.md")) continue;
        const name = file.replace(/\.(skill\.)?md$/, "");
        const skill = this.skills.get(name);
        if (skill) {
          result.push({ name: skill.name, description: skill.description, trigger: skill.trigger });
        } else {
          result.push({ name, description: "(not loaded)", trigger: undefined });
        }
      }
    } catch {}
    return result;
  }

  /** 加载一个 skill */
  load(name: string): Skill | null {
    // 先检查缓存
    if (this.skills.has(name)) return this.skills.get(name)!;

    const filePath = path.resolve(this.skillsDir, `${name}.md`);
    const altPath = path.resolve(this.skillsDir, `${name}.skill.md`);

    let content: string;
    let actualPath: string;

    try {
      actualPath = filePath;
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      try {
        actualPath = altPath;
        content = fs.readFileSync(altPath, "utf-8");
      } catch {
        return null; // not found
      }
    }

    const skill = this.parse(content, name, actualPath);
    this.skills.set(name, skill);
    return skill;
  }

  /** 卸载一个 skill */
  unload(name: string): boolean {
    return this.skills.delete(name);
  }

  /** 获取所有已加载的 skill */
  getLoaded(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** 创建新 skill */
  create(name: string, description: string, body: string, trigger?: string): string {
    const frontmatter = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      ...(trigger ? [`trigger: ${trigger}`] : []),
      "---",
    ].join("\n");

    const content = `${frontmatter}\n\n${body}`;
    const filePath = path.resolve(this.skillsDir, `${name}.md`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** 获取 skill 的上下文注入文本 */
  getContextPrompt(): string {
    const loaded = this.getLoaded();
    if (loaded.length === 0) return "";

    let prompt = "## Available Skills\n\n";
    for (const skill of loaded) {
      prompt += `### ${skill.name}\n${skill.description}\n`;
    }
    prompt += "\nWhen a task matches a skill, use its instructions. ";
    prompt += "Load a skill with: /skill <name>\n";
    return prompt;
  }

  /** 获取指定 skill 的完整内容作为 prompt 注入 */
  static getSkillPrompt(skill: Skill): string {
    return `\n## Skill: ${skill.name}\n\n${skill.content}\n\n(follow the skill instructions above)`;
  }

  /** 自动匹配 trigger */
  matchTrigger(input: string): Skill[] {
    const matches: Skill[] = [];
    for (const skill of this.getLoaded()) {
      if (skill.trigger) {
        try {
          const re = new RegExp(skill.trigger, "i");
          if (re.test(input)) matches.push(skill);
        } catch {}
      }
    }
    return matches;
  }

  private parse(raw: string, name: string, filePath: string): Skill {
    let description = name;
    let trigger: string | undefined;
    let body = raw;

    // Parse YAML frontmatter
    if (raw.startsWith("---")) {
      const end = raw.indexOf("---", 3);
      if (end !== -1) {
        const fm = raw.slice(3, end).trim();
        body = raw.slice(end + 3).trim();

        for (const line of fm.split("\n")) {
          const m = line.match(/^\s*(\w+):\s*(.+)/);
          if (!m) continue;
          const [, key, val] = m;
          switch (key) {
            case "description": description = val.trim(); break;
            case "trigger": trigger = val.trim(); break;
          }
        }
      }
    }

    return { name, description, trigger, content: body, path: filePath, loadedAt: Date.now() };
  }
}
