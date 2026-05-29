#!/usr/bin/env node
// ── Adamas CLI ──
//
// 安装: npm link (全局 adamas 命令)
// 使用:
//   adamas chat       交互式对话 (Rich 皮肤)
//   adamas run "..."   单次执行
//   adamas serve       启动网关
//   adamas ilink       微信扫码登录
//   adamas skill list  管理 skills
//   adamas memory      管理 memory
//   adamas config      配置管理
//   adamas setup       初始化设置

import { Command } from "commander";

const program = new Command();

program
  .name("adamas")
  .description("Adamas — Hybrid AI Agent (TypeScript + Rust)")
  .version("0.2.0");

// ── chat ──
program
  .command("chat")
  .description("Start interactive chat session with Rich UI")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --provider <provider>", "Provider (openai/anthropic/deepseek)")
  .option("-d, --debug", "Start with debug mode on")
  .action(async (opts) => {
    const { startChat } = await import("./chat");
    await startChat(opts);
  });

// ── run ──
program
  .command("run")
  .description("Run a single prompt and exit")
  .argument("<prompt>", "The prompt to execute")
  .option("-m, --model <model>", "Model override")
  .option("-p, --provider <provider>", "Provider override")
  .action(async (prompt, opts) => {
    const { runOneshot } = await import("./run");
    await runOneshot(prompt, opts);
  });

// ── serve ──
program
  .command("serve")
  .description("Start gateway server for messaging platforms")
  .option("-p, --port <port>", "Port number", "4000")
  .option("-w, --wechaty", "Start WeChaty bot (QR code login)")
  .action(async (opts) => {
    const { startGateway } = await import("./gateway");
    await startGateway(parseInt(opts.port), opts.wechaty);
  });

// ── ilink ──
program
  .command("ilink")
  .description("WeChat QR login via iLink Bot API")
  .action(async () => {
    const { qrLogin, saveCredentials } = await import("@adamas/gateway/ilink");
    const QRCode = await import("qrcode");

    console.log("[adamas] 🔑 iLink 微信扫码登录\n");

    const cred = await qrLogin(480, 
      (qr) => {
        const data = qr.qrcodeUrl || qr.qrcode;
        console.log("请用微信扫描以下二维码：");
        console.log(data);
        QRCode.toString(data, { type: "terminal", small: true }).then((s: string) => console.log(s));
      },
      (status) => {
        if (status === "wait") process.stdout.write(".");
        else if (status === "scaned") console.log("\n已扫码，请在微信确认...");
        else if (status === "confirmed") console.log("\n✅ 登录成功！");
        else if (status === "expired") console.log("\n码已过期，刷新中...");
        else if (status === "redirect") console.log("\n重定向...");
      }
    );

    if (!cred) {
      console.log("\n❌ 登录超时或失败");
      return;
    }

    saveCredentials(cred);
    console.log(`\n账号: ${cred.accountId}`);
    console.log(`Token: ${cred.token.slice(0, 12)}...`);
    console.log(`凭据已保存至 ~/.adamas/weixin/credentials.json`);
  });

// ── skill ──
const skillCmd = program
  .command("skill <action>")
  .description("Manage skills (list, load, create)");

skillCmd
  .command("list")
  .description("List available skills")
  .action(async () => {
    const { SkillManager } = await import("@adamas/core");
    const sm = new SkillManager();
    const skills = sm.list();
    if (skills.length === 0) {
      console.log("No skills found. Create .md files in ~/.adamas/skills/");
    } else {
      for (const s of skills) {
        console.log(`  ▸ ${s.name}${s.trigger ? ` [trigger: ${s.trigger}]` : ""}`);
        console.log(`    ${s.description}`);
      }
    }
  });

skillCmd
  .command("create <name>")
  .description("Create a new skill from a markdown file")
  .argument("<file>", "Markdown file to import as skill")
  .action(async (name, file) => {
    const { SkillManager } = await import("@adamas/core");
    const sm = new SkillManager();
    const fs = await import("fs");
    try {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      let desc = name;
      // Extract first heading as description
      for (const l of lines) {
        const m = l.match(/^#+\s*(.+)/);
        if (m) { desc = m[1]; break; }
      }
      const path = sm.create(name, desc, content);
      console.log(`✓ Skill created: ${name}`);
      console.log(`  Path: ${path}`);
    } catch (err: any) {
      console.error(`✗ Failed: ${err.message}`);
    }
  });

// ── memory ──
const memCmd = program
  .command("memory <action>")
  .description("Manage persistent memories");

memCmd
  .command("list")
  .description("List all saved memories")
  .action(async () => {
    const { getMemoryStore } = await import("@adamas/core");
    const ms = getMemoryStore();
    const all = ms.getAll();
    if (all.length === 0) {
      console.log("No saved memories.");
    } else {
      for (const e of all) {
        const tags = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
        console.log(`  ${e.key}${tags}: ${e.value}`);
      }
    }
  });

memCmd
  .command("add <key> <value>")
  .description("Add or update a memory entry")
  .action(async (key, value) => {
    const { getMemoryStore } = await import("@adamas/core");
    const ms = getMemoryStore();
    ms.upsert(key, value);
    console.log(`✓ Saved: ${key} = ${value}`);
  });

memCmd
  .command("del <key>")
  .description("Delete a memory entry")
  .action(async (key) => {
    const { getMemoryStore } = await import("@adamas/core");
    const ms = getMemoryStore();
    const ok = ms.remove(key);
    console.log(ok ? `✓ Deleted: ${key}` : `✗ Not found: ${key}`);
  });

memCmd
  .command("search <query>")
  .description("Search memories")
  .action(async (query) => {
    const { getMemoryStore } = await import("@adamas/core");
    const ms = getMemoryStore();
    const results = ms.search(query);
    if (results.length === 0) {
      console.log("No results.");
    } else {
      for (const e of results) {
        console.log(`  ${e.key}: ${e.value}`);
      }
    }
  });

// ── config ──
program
  .command("config")
  .description("Manage adamas configuration")
  .option("-s, --show", "Show current config")
  .option("--path", "Show config file path")
  .action(async (opts) => {
    const home = process.env.HOME || "/tmp";
    const configPath = `${home}/.adamas/config.yaml`;
    console.log(`Config: ${configPath}`);
    try {
      const fs = await import("fs");
      const content = fs.readFileSync(configPath, "utf-8");
      if (opts.show !== false) console.log(content);
    } catch {
      console.log("(no config file — using defaults & hermes config)");
    }
  });

// ── setup ──
program
  .command("setup")
  .description("Initialize adamas environment")
  .action(async () => {
    const { runSetup } = await import("./setup");
    await runSetup();
  });

program.parse();
