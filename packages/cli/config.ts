// ── Config loader ──
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "yaml";
import type { AdamasConfig, ModelConfig } from "@adamas/core";

// 获取当前文件目录（兼容 ESM __dirname 不可用的情况）
const __currentDir = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

// 手动加载 .env（不依赖 dotenv 包）
function loadEnvFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* file not found */ }
}
// 按优先级加载: 项目根 .env（packages/cli → ../..） → ~/.adamas/.env
loadEnvFile(path.resolve(__currentDir, "../..", ".env"));
loadEnvFile(path.resolve(process.env.HOME || "/tmp", ".adamas", ".env"));

const DEFAULT_CONFIG: AdamasConfig = {
  model: {
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "",
    temperature: 0.7,
    maxTokens: 8192,
  },
  terminal: { rtkEnabled: true, timeout: 180 },
  browser: { backend: "camoufox", url: "http://localhost:9377" },
  agents: { maxIterations: 30, maxToolCallsPerTurn: 5 },
};

export async function loadConfig(opts?: any): Promise<AdamasConfig> {
  const config: AdamasConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 读取 ~/.adamas/config.yaml
  const home = process.env.HOME || "/tmp";
  const configPath = `${home}/.adamas/config.yaml`;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const user = yaml.parse(raw) as Partial<AdamasConfig>;
    if (user.model) Object.assign(config.model, user.model);
    if (user.terminal) Object.assign(config.terminal, user.terminal);
    if (user.browser) Object.assign(config.browser, user.browser);
    if (user.agents) Object.assign(config.agents, user.agents);
  } catch { /* use defaults */ }

  // CLI overrides
  if (opts?.provider) config.model.provider = opts.provider;
  if (opts?.model) config.model.model = opts.model;

  return config;
}

export async function loadSoul(): Promise<string> {
  const home = process.env.HOME || "/tmp";
  try {
    return fs.readFileSync(`${home}/.adamas/SOUL.md`, "utf-8");
  } catch {
    return "You are Adamas, an AI assistant.";
  }
}
