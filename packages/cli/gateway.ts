// ── adamas serve — 启动消息网关 ──
import { GatewayServer } from "@adamas/gateway";
import { startWechatyBot } from "@adamas/gateway/wechaty-bot";
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";
import { loadConfig, loadSoul } from "./config";

export async function startGateway(port: number, useWechaty?: boolean) {
  console.log("[adamas] Starting gateway...");

  const config = await loadConfig();
  const tools = await ToolRegistry.createDefault();

  const agent = new AdamasAgent(config);
  for (const tool of tools.getAll()) {
    agent.register(tool);
  }

  const soul = await loadSoul();
  agent.setSystemPrompt(soul);

  // ── WeChaty 扫码模式 ──
  if (useWechaty) {
    console.log("[adamas] 🤖 启动 WeChaty 扫码登录模式...");
    const bot = await startWechatyBot(agent, tools);

    process.on("SIGINT", async () => {
      console.log("\n[adamas] 正在停止 WeChaty...");
      await bot.stop();
    });
    process.on("SIGTERM", async () => {
      await bot.stop();
    });
    return;
  }

  // ── HTTP 网关模式 ──
  const wechatToken = process.env.WEIXIN_TOKEN || "";

  const gateway = new GatewayServer(agent, { port, wechatToken });

  if (wechatToken) {
    console.log(`[adamas] WeChat enabled (account: ${process.env.WEIXIN_ACCOUNT_ID || "unknown"})`);
  } else {
    console.log("[adamas] WeChat not configured — set WEIXIN_TOKEN env var");
    console.log("[adamas] Generic webhook available at POST /webhook");
  }

  await gateway.start();

  process.on("SIGINT", async () => {
    console.log("\n[adamas] Shutting down...");
    await gateway.stop();
  });
  process.on("SIGTERM", async () => {
    await gateway.stop();
  });
}
