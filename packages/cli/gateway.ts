// ── adamas serve — 启动消息网关 ──
import { GatewayServer } from "@adamas/gateway";
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";
import { loadConfig, loadSoul } from "./config";

export async function startGateway(port: number) {
  console.log("[adamas] Starting gateway...");

  const config = await loadConfig();
  const tools = await ToolRegistry.createDefault();

  const agent = new AdamasAgent(config);
  for (const tool of tools.getAll()) {
    agent.register(tool);
  }

  const soul = await loadSoul();
  agent.setSystemPrompt(soul);

  // 从环境变量读取微信配置（也自动从 hermes .env 继承）
  const wechatToken = process.env.WEIXIN_TOKEN || "";

  const gateway = new GatewayServer(agent, { port, wechatToken });

  if (wechatToken) {
    console.log(`[adamas] WeChat enabled (account: ${process.env.WEIXIN_ACCOUNT_ID || "unknown"})`);
  } else {
    console.log("[adamas] WeChat not configured — set WEIXIN_TOKEN env var");
    console.log("[adamas] Generic webhook available at POST /webhook");
  }

  await gateway.start();

  // 优雅退出
  process.on("SIGINT", async () => {
    console.log("\n[adamas] Shutting down...");
    await gateway.stop();
  });
  process.on("SIGTERM", async () => {
    await gateway.stop();
  });
}
