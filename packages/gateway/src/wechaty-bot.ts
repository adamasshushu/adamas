// ── WeChaty Bot — 扫码登录个人微信 ──
//
// 启动后输出二维码链接，扫码即可登录
// 登录后自动处理私聊和群聊消息，调用 AdamasAgent 回复

import { WechatyBuilder, ScanStatus, log } from "wechaty";
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";

// 降低 wechaty 日志噪音
log.level("info");

export async function startWechatyBot(agent: AdamasAgent, tools: ToolRegistry) {
  const bot = WechatyBuilder.build({
    name: "adamas",
    puppet: "wechaty-puppet-wechat4u",
    puppetOptions: {
      uos: true,  // UOS 协议
    },
  });

  // ── 扫码事件：输出二维码 ──
  bot.on("scan", (qrcode: string, status: ScanStatus) => {
    // 生成可扫描的二维码链接
    const qrUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
    console.log("\n" + "=".repeat(50));
    console.log(`[adamas] 二维码状态: ${ScanStatus[status]} (${status})`);
    console.log(`[adamas] 请用微信扫码登录：`);
    console.log(`[adamas] 在线二维码: ${qrUrl}`);
    console.log(`[adamas] Raw: ${qrcode.slice(0, 50)}...`);
    console.log("=".repeat(50) + "\n");

    // status: 0=Unknown, 1=Cancel, 2=Waiting, 3=Scanned, 4=Confirmed, 5=Timeout
    if (status === ScanStatus.Waiting || status === ScanStatus.Scanned) {
      console.log("[adamas] ⏳ 等待扫码确认...");
    }
  });

  // ── 登录成功 ──
  bot.on("login", (user: any) => {
    console.log(`\n[adamas] ✅ 登录成功！`);
    console.log(`[adamas] 用户: ${user.name()} (${user.id})`);
    console.log(`[adamas] 等待消息中...\n`);
  });

  // ── 登出 ──
  bot.on("logout", (user: any) => {
    console.log(`[adamas] ❌ 已登出: ${user.name()}`);
  });

  // ── 收到消息 ──
  bot.on("message", async (message: any) => {
    // 忽略非文本消息和自己发的
    if (message.self()) return;
    if (message.type() !== bot.Message.Type.Text) return;

    const text = message.text().trim();
    if (!text) return;

    const room = message.room();
    const talker = message.talker();
    const senderName = talker.name();

    // 群聊：只响应 @adamas 或被 @ 的消息
    if (room) {
      const mentioned = await message.mentionList();
      const selfMentioned = mentioned.some((m: any) => m.self());
      if (!selfMentioned) return;  // 没被 @，忽略
      console.log(`[adamas] 群聊(${await room.topic()}): ${senderName}: ${text}`);
    } else {
      console.log(`[adamas] 私聊: ${senderName}: ${text}`);
    }

    try {
      // 显示"正在输入..."
      if (!room) message.talker()?.say && console.log("[adamas] 处理中...");

      // 调用 Agent
      const reply = await agent.chat(text);

      // 回复
      if (room) {
        await room.say(`@${senderName} ${reply}`);
      } else {
        await talker.say(reply);
      }

      console.log(`[adamas] 回复: ${reply.slice(0, 100)}...`);
    } catch (err) {
      console.error("[adamas] 消息处理失败:", err);
      const fallback = "抱歉，处理出错了，请稍后再试。";
      if (room) {
        await room.say(`@${senderName} ${fallback}`);
      } else {
        await talker.say(fallback);
      }
    }
  });

  // ── 错误 ──
  bot.on("error", (err: Error) => {
    console.error("[adamas] WeChaty 错误:", err.message);
  });

  // ── 启动！ ──
  console.log("[adamas] 🚀 启动 WeChaty 机器人...");
  await bot.start();

  return bot;
}
