// ── Adamas Chat — Rich 交互式 CLI ──
//
// 功能:
//  - Rich 皮肤（彩色面板、旋转提示器）
//  - Readline 输入（历史记录、自动补全）
//  - 斜杠命令（/help /skill /memory /debug /clear ...）
//  - Skill 自动加载 & 手动加载
//  - Memory 跨会话存储
//  - 工具调用实时展示

import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import chalk from "chalk";
import ora, { Ora } from "ora";
import boxen from "boxen";
import { AdamasAgent, SkillManager, MemoryStore, getMemoryStore } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";
import { loadConfig, loadSoul } from "./config";

const ADAMAS_HOME = path.resolve(process.env.HOME || "/tmp", ".adamas");

// ── 斜杠命令定义 ──
const COMMANDS: { name: string; aliases: string[]; desc: string; usage: string }[] = [
  { name: "help",    aliases: ["h", "?"],     desc: "Show this help",                usage: "/help" },
  { name: "exit",    aliases: ["quit", "q"],   desc: "Exit chat",                     usage: "/exit" },
  { name: "clear",   aliases: ["c"],           desc: "Clear conversation history",    usage: "/clear" },
  { name: "state",   aliases: ["s"],           desc: "Show agent state",              usage: "/state" },
  { name: "skill",   aliases: ["load"],        desc: "Load a skill",                   usage: "/skill <name>" },
  { name: "skills",  aliases: ["ls"],          desc: "List available skills",          usage: "/skills" },
  { name: "memory",  aliases: ["mem", "m"],    desc: "Memory management",              usage: "/memory [add|search|list|del]" },
  { name: "model",   aliases: ["mdl"],         desc: "Show current model",             usage: "/model" },
  { name: "tools",   aliases: ["t"],           desc: "List registered tools",          usage: "/tools" },
  { name: "debug",   aliases: ["d"],           desc: "Toggle debug mode",              usage: "/debug" },
  { name: "save",    aliases: ["sv"],          desc: "Save last response to file",     usage: "/save <path>" },
];

const HELP_TEXT = boxen(
  chalk.cyan.bold("╔═══ Adamas Commands ═══╗\n") +
  COMMANDS.map(c =>
    `  ${chalk.yellow(`/${c.name.padEnd(6)}`)} ${c.aliases.map(a => chalk.dim(`/${a}`)).join(" ").padEnd(14)} ${chalk.white(c.desc)}`
  ).join("\n") +
  chalk.cyan.bold("\n╚════════════════════════╝"),
  { padding: 1, borderColor: "cyan", borderStyle: "round" }
);

const WELCOME = boxen(
  chalk.bold.cyan("╔════════════════════════════════════╗\n") +
  chalk.bold.cyan("║      ") + chalk.white.bold("Adamas Agent") + chalk.cyan("  🤖                 ║\n") +
  chalk.bold.cyan("║  ") + chalk.dim("TypeScript + Rust Hybrid") + chalk.cyan("        ║\n") +
  chalk.bold.cyan("║  ") + chalk.dim("Model: LLM-powered") + chalk.cyan("               ║\n") +
  chalk.bold.cyan("║  ") + chalk.dim("Type /help for commands") + chalk.cyan("          ║\n") +
  chalk.bold.cyan("╚════════════════════════════════════╝"),
  { padding: { left: 1, right: 1, top: 0, bottom: 0 }, borderColor: "cyan", borderStyle: "bold" }
);

let lastResponse = "";

export async function startChat(opts: any) {
  // ── 初始化 ──
  const config = await loadConfig(opts);
  const tools = await ToolRegistry.createDefault();
  const skillManager = new SkillManager();
  const memoryStore = getMemoryStore();

  // 自动加载所有 .md skill
  const availableSkills = skillManager.list();
  for (const s of availableSkills) {
    skillManager.load(s.name);
  }

  // 创建 agent
  const agent = new AdamasAgent(config);
  agent.setSkillManager(skillManager);
  agent.setMemoryStore(memoryStore);

  for (const tool of tools.getAll()) {
    agent.register(tool);
  }

  // 设置 SOUL（系统提示词）
  const soul = await loadSoul();
  agent.setSystemPrompt(soul);
  agent.refreshContext();

  // ── UI 显示 ──
  console.clear();
  console.log(WELCOME);
  console.log(chalk.dim(`  Memory: ${memoryStore.getAll().length} entries | Skills: ${skillManager.getLoaded().length} loaded`));
  console.log(chalk.dim(`  Model: ${config.model.provider}/${config.model.model}`));
  console.log("");

  // ── Readline 设置 ──
  const historyFile = path.resolve(ADAMAS_HOME, "history");
  const history: string[] = [];
  try {
    if (fs.existsSync(historyFile)) {
      history.push(...fs.readFileSync(historyFile, "utf-8").split("\n").filter(Boolean).slice(-200));
    }
  } catch {}

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green.bold("adamas") + chalk.dim("> "),
    completer: (line: string) => {
      const hits = COMMANDS.filter(c =>
        c.name.startsWith(line.replace("/", "")) ||
        c.aliases.some(a => a.startsWith(line.replace("/", "")))
      );
      const flat = hits.flatMap(c => [c.name, ...c.aliases].map(a => `/${a}`));
      return [flat.length ? flat : COMMANDS.map(c => `/${c.name}`), line];
    },
    historySize: 200,
  });

  rl.prompt();

  // ── 主循环 ──
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }

    // 保存历史
    history.push(input);
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(historyFile, history.slice(-200).join("\n"), "utf-8");
    } catch {}

    // 斜杠命令
    if (input.startsWith("/")) {
      const handled = await handleCommand(input, { agent, skillManager, memoryStore, rl, config });
      if (handled === "exit") break;
      if (handled) { rl.prompt(); continue; }
    }

    // 普通消息 → AI
    await handleChat(input, agent, skillManager, rl);
    rl.prompt();
  }

  rl.close();
  console.log(chalk.dim("\n👋 Goodbye!\n"));
}

// ── 处理斜杠命令，返回 "exit" | true (handled) | false (passthrough) ──
async function handleCommand(
  input: string,
  ctx: { agent: AdamasAgent; skillManager: SkillManager; memoryStore: MemoryStore; rl: readline.Interface; config: any }
): Promise<string | boolean> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  // 别名解析
  const command = COMMANDS.find(c => c.name === cmd || c.aliases.includes(cmd));

  if (!command) {
    console.log(chalk.red(`  Unknown command: /${cmd}. Type /help for available commands.`));
    return true;
  }

  switch (command.name) {
    case "exit":
      return "exit";

    case "help":
      console.log("");
      console.log(HELP_TEXT);
      console.log("");
      return true;

    case "clear":
      ctx.agent.clearHistory();
      console.log(chalk.green("  ✓ Conversation cleared."));
      return true;

    case "state": {
      const state = ctx.agent.getState();
      const msgCount = ctx.agent.getMessageCount();
      console.log("");
      console.log(boxen(
        chalk.dim(`Phase:     `) + chalk.yellow(state.phase) + "\n" +
        (state.phase === "thinking" ? chalk.dim("Thought:   ") + chalk.cyan(`"${state.thought}"`) + "\n" : "") +
        (state.phase === "acting" ? chalk.dim("Tool:      ") + chalk.magenta(`"${state.tool}"`) + "\n" : "") +
        chalk.dim(`Messages:  `) + chalk.white(`${msgCount}`) + "\n" +
        chalk.dim(`Debug:     `) + (ctx.agent.debug ? chalk.green("ON") : chalk.dim("OFF")),
        { padding: 1, borderColor: "yellow", borderStyle: "round", title: "Agent State", titleAlignment: "center" }
      ));
      console.log("");
      return true;
    }

    case "model":
      console.log("");
      console.log(boxen(
        chalk.dim("Provider:  ") + chalk.cyan(ctx.config.model.provider) + "\n" +
        chalk.dim("Model:     ") + chalk.cyan(ctx.config.model.model) + "\n" +
        chalk.dim("Max Tokens:") + chalk.white(`${ctx.config.model.maxTokens}`),
        { padding: 1, borderColor: "blue", borderStyle: "round", title: "Model Config", titleAlignment: "center" }
      ));
      console.log("");
      return true;

    case "tools": {
      const toolNames = ctx.agent.getToolNames();
      if (toolNames.length === 0) {
        console.log(chalk.dim("  No tools registered."));
      } else {
        console.log("");
        console.log(boxen(
          chalk.dim("Available tools:\n") +
          toolNames.map(t => `  ${chalk.cyan("●")} ${chalk.white(t)}`).join("\n"),
          { padding: 1, borderColor: "magenta", borderStyle: "round", title: "Tools", titleAlignment: "center" }
        ));
        console.log("");
      }
      return true;
    }

    case "skills": {
      const skills = ctx.skillManager.list();
      if (skills.length === 0) {
        console.log(chalk.dim("  No skills available. Create skills in ~/.adamas/skills/ as .md files."));
      } else {
        console.log("");
        console.log(boxen(
          skills.map(s =>
            `  ${chalk.green("▸")} ${chalk.white.bold(s.name)}${s.trigger ? chalk.dim(` [trigger: ${s.trigger}]`) : ""}\n` +
            `    ${chalk.dim(s.description)}`
          ).join("\n"),
          { padding: 1, borderColor: "green", borderStyle: "round", title: "Skills", titleAlignment: "center" }
        ));
        console.log("");
      }
      return true;
    }

    case "skill": {
      if (args.length === 0) {
        console.log(chalk.yellow("  Usage: /skill <name>  — load a skill"));
        console.log(chalk.dim("  Use /skills to see available skills."));
        return true;
      }
      const name = args[0];
      const skill = ctx.skillManager.load(name);
      if (!skill) {
        console.log(chalk.red(`  Skill not found: "${name}"`));
        console.log(chalk.dim("  Create it: touch ~/.adamas/skills/" + name + ".md"));
        return true;
      }
      // 注入到系统提示
      const skillPrompt = SkillManager.getSkillPrompt(skill);
      const currentSoul = ctx.agent.getMessages().find(m => m.role === "system")?.content || "";
      ctx.agent.setSystemPrompt(currentSoul + "\n" + skillPrompt);
      ctx.agent.refreshContext();
      console.log(chalk.green(`  ✓ Skill loaded: ${skill.name} — ${skill.description}`));
      return true;
    }

    case "memory": {
      const sub = args[0]?.toLowerCase();
      switch (sub) {
        case "add":
        case "set": {
          if (args.length < 3) {
            console.log(chalk.yellow("  Usage: /memory add <key> <value>"));
            return true;
          }
          const key = args[1];
          const value = args.slice(2).join(" ");
          ctx.memoryStore.upsert(key, value);
          console.log(chalk.green(`  ✓ Saved: ${key} = ${value}`));
          ctx.agent.refreshContext();
          return true;
        }
        case "del":
        case "rm":
        case "delete": {
          if (args.length < 2) {
            console.log(chalk.yellow("  Usage: /memory del <key>"));
            return true;
          }
          const removed = ctx.memoryStore.remove(args[1]);
          console.log(removed ? chalk.green(`  ✓ Deleted: ${args[1]}`) : chalk.yellow(`  Not found: ${args[1]}`));
          ctx.agent.refreshContext();
          return true;
        }
        case "search":
        case "find": {
          if (args.length < 2) {
            console.log(chalk.yellow("  Usage: /memory search <query>"));
            return true;
          }
          const results = ctx.memoryStore.search(args.slice(1).join(" "));
          if (results.length === 0) {
            console.log(chalk.dim("  No results."));
          } else {
            console.log("");
            console.log(boxen(
              results.map(r =>
                `  ${chalk.cyan("▸")} ${chalk.white.bold(r.key)}${r.tags.length ? chalk.dim(` [${r.tags.join(", ")}]`) : ""}\n` +
                `    ${chalk.white(r.value)}`
              ).join("\n"),
              { padding: 1, borderColor: "blue", borderStyle: "round", title: "Memory Search", titleAlignment: "center" }
            ));
            console.log("");
          }
          return true;
        }
        case "list":
        case undefined: {
          const all = ctx.memoryStore.getAll();
          if (all.length === 0) {
            console.log(chalk.dim("  No saved memories. Use /memory add <key> <value> to create one."));
          } else {
            console.log("");
            console.log(boxen(
              all.map(r =>
                `  ${chalk.cyan("▸")} ${chalk.white.bold(r.key)}${r.tags.length ? chalk.dim(` [${r.tags.join(", ")}]`) : ""}\n` +
                `    ${chalk.white(r.value)}`
              ).join("\n"),
              { padding: 1, borderColor: "blue", borderStyle: "round", title: `Memories (${all.length})`, titleAlignment: "center" }
            ));
            console.log("");
          }
          return true;
        }
        default:
          console.log(chalk.yellow(`  Unknown: /memory ${sub}`));
          console.log(chalk.dim("  Available: add, del, search, list"));
          return true;
      }
    }

    case "debug":
      ctx.agent.setDebug(!ctx.agent.debug);
      console.log(chalk.yellow(`  Debug mode: ${ctx.agent.debug ? chalk.green("ON") : chalk.dim("OFF")}`));
      return true;

    case "save": {
      if (args.length === 0) {
        console.log(chalk.yellow("  Usage: /save <path>  — save last response to file"));
        return true;
      }
      if (!lastResponse) {
        console.log(chalk.dim("  No response to save."));
        return true;
      }
      const filePath = args[0].startsWith("/") ? args[0] : path.resolve(process.cwd(), args[0]);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, lastResponse, "utf-8");
        console.log(chalk.green(`  ✓ Saved to ${filePath}`));
      } catch (err) {
        console.log(chalk.red(`  ✗ Failed: ${err}`));
      }
      return true;
    }

    default:
      return false; // passthrough to AI
  }
}

// ── 处理普通消息 ──
async function handleChat(
  input: string,
  agent: AdamasAgent,
  skillManager: SkillManager,
  rl: readline.Interface
) {
  // 自动匹配 skill trigger
  const matched = skillManager.matchTrigger(input);
  for (const skill of matched) {
    console.log(chalk.dim(`  ⚡ Auto-loaded skill: ${chalk.green(skill.name)}`));
    const skillPrompt = SkillManager.getSkillPrompt(skill);
    const currentSoul = agent.getMessages().find(m => m.role === "system")?.content || "";
    agent.setSystemPrompt(currentSoul + "\n" + skillPrompt);
    agent.refreshContext();
  }

  // 创建 spinner
  let spinner: Ora = ora({
    text: chalk.dim("Thinking..."),
    spinner: "dots",
    color: "cyan",
  });
  spinner.start();

  // 监控 agent 状态更新 spinner
  const stateInterval = setInterval(() => {
    const state = agent.getState();
    if (spinner) {
      switch (state.phase) {
        case "thinking":
          spinner.text = chalk.dim("🤔 Thinking...");
          break;
        case "acting":
          spinner.text = chalk.magenta(`🔧 Calling ${state.tool}...`);
          break;
        case "observing":
          spinner.text = chalk.cyan("👁️  Observing...");
          break;
        case "done":
          spinner.succeed(chalk.dim("Done"));
          spinner = null as any;
          break;
      }
    }
  }, 100);

  try {
    const response = await agent.chat(input);
    clearInterval(stateInterval);

    if (spinner) {
      const state = agent.getState();
      if (state.phase === "done") {
        spinner.succeed();
      } else {
        spinner.stop();
      }
    }

    lastResponse = response;

    // 格式化输出
    console.log("");

    // Debug: 显示工具调用和消息数
    if (agent.debug) {
      const messages = agent.getMessages();
      const toolMsgs = messages.filter(m => m.role === "tool" || m.toolCalls);
      console.log(chalk.dim(`  [debug] ${messages.length} messages, ${toolMsgs.length} tool interactions, iterations: ${agent.getState().phase === "done" ? "done" : "?"}`));
    }

    // 用 box 包裹回复
    const MAX_WIDTH = Math.min(process.stdout.columns - 4, 100);
    const lines = response.split("\n");
    const wrapped = lines.map(l => {
      if (l.length <= MAX_WIDTH) return l;
      // 简单换行
      const result: string[] = [];
      let remaining = l;
      while (remaining.length > MAX_WIDTH) {
        result.push(remaining.slice(0, MAX_WIDTH));
        remaining = remaining.slice(MAX_WIDTH);
      }
      if (remaining) result.push(remaining);
      return result.join("\n");
    }).join("\n");

    console.log(
      boxen(wrapped, {
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        margin: { left: 2 },
        borderColor: "cyan",
        borderStyle: "round",
      })
    );

    // 长文本省略提示
    if (response.length > 2000) {
      console.log(chalk.dim(`  (${response.length} chars — use /save to export)`));
    }

    console.log("");

  } catch (err: any) {
    clearInterval(stateInterval);
    if (spinner) spinner.fail(chalk.red("Error"));
    console.log(chalk.red(`\n  ✗ ${err.message || err}`));
    if (agent.debug) console.log(chalk.dim(`  [debug] ${err.stack}`));
    console.log("");
  }
}

// 兼容旧接口
export { handleCommand, handleChat };
