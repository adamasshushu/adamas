#!/usr/bin/env bun
// ── Adamas CLI ──
//
// 安装: bun link (全局 adamas 命令)
// 使用:
//   adamas chat       交互式对话
//   adamas run "提示"  单次执行
//   adamas serve       启动网关
//   adamas cron list   定时任务管理
//   adamas config      配置管理
//   adamas setup       初始化设置

import { Command } from "commander";

const program = new Command();

program
  .name("adamas")
  .description("Adamas — Hybrid AI Agent (TypeScript + Rust)")
  .version("0.1.0");

// ── chat ──
program
  .command("chat")
  .description("Start interactive chat session")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --provider <provider>", "Provider (openai/anthropic/deepseek)")
  .action(async (opts) => {
    console.log(`
╔═══════════════════════════════════╗
║        Adamas Agent 🤖           ║
║  TypeScript + Rust Hybrid        ║
║  Model: ${opts.model || "default"}                ║
╚═══════════════════════════════════╝

Type /help for commands, /exit to quit.
`);
    const { startChat } = await import("./chat");
    await startChat(opts);
  });

// ── run ──
program
  .command("run")
  .description("Run a single prompt and exit")
  .argument("<prompt>", "The prompt to execute")
  .option("-m, --model <model>", "Model override")
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
        // ASCII 二维码
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

// ── cron ──
program
  .command("cron <action>")
  .description("Manage scheduled tasks")
  .action(async (action) => {
    console.log(`Cron ${action}: coming soon`);
  });

// ── config ──
program
  .command("config")
  .description("Manage adamas configuration")
  .action(async () => {
    const home = process.env.HOME || "/tmp";
    const configPath = `${home}/.adamas/config.yaml`;
    console.log(`Config file: ${configPath}`);
    try {
      const fs = await import("fs");
      const content = fs.readFileSync(configPath, "utf-8");
      console.log(content);
    } catch {
      console.log("(no config file — using defaults)");
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
