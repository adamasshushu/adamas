#!/usr/bin/env npx tsx
/**
 * iLink 长轮询网关 — 持续拉取微信消息 → Agent 处理 → 回复
 * 用法: npx tsx packages/gateway/src/ilink-gateway.ts
 */

import * as fs from "fs";
import * as path from "path";
import { getUpdates, sendMessage, type ILinkCredentials } from "./ilink.js";

const CRED_PATH = path.join(
  process.env.HOME || "/home/cyborg",
  ".adamas/weixin/credentials.json"
);

function loadCreds(): ILinkCredentials {
  if (!fs.existsSync(CRED_PATH)) {
    throw new Error(`凭据文件不存在: ${CRED_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
  return {
    accountId: raw.accountId,
    token: raw.token,
    baseUrl: raw.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: raw.userId || "",
  };
}

async function main() {
  const cred = loadCreds();
  console.log(`[adamas] ✅ 已加载凭据: ${cred.accountId}`);

  // 初始化 Agent
  let agent: any = null;
  let agentModel = "unknown";
  try {
    const { AdamasAgent } = await import("@adamas/core");
    const { loadConfig } = await import("@adamas/cli/config");
    const config = await loadConfig();
    agentModel = config.model.model;
    agent = new AdamasAgent(config);
    console.log(`[adamas] 🤖 Agent 就绪: ${agentModel}`);
  } catch (err: any) {
    console.warn(`[adamas] ⚠️ Agent 初始化失败: ${err.message}`);
    console.warn(`[adamas] 将使用简单回显模式`);
  }

  console.log(`[adamas] 🚀 开始长轮询...`);

  let syncBuf = "";
  let failures = 0;

  while (true) {
    try {
      const { result, error } = await getUpdates(cred.token, syncBuf, cred.baseUrl);

      if (error) {
        failures++;
        console.error(`[adamas] 轮询错误 (${failures}/10): ${error}`);
        if (failures > 10) {
          process.exit(1);
        }
        await sleep(3000);
        continue;
      }

      failures = 0;

      if (!result) {
        await sleep(1000);
        continue;
      }

      if (result.getUpdatesBuf) {
        syncBuf = result.getUpdatesBuf;
      }

      for (const msg of result.msgs) {
        const text = msg.itemList?.find(i => i.type === 1)?.text_item?.text || msg.text || "";
        const fromUser = msg.fromUserId;

        if (!text) continue;

        const label = msg.roomId ? `群聊(${fromUser})` : `私聊(${fromUser})`;
        console.log(`\n📩 ${label}: ${text}`);

        // 生成回复
        let reply: string;
        try {
          reply = agent
            ? await agent.chat(text)
            : `[adamas echo] ${text}`;
        } catch (err: any) {
          reply = `出错: ${err.message}`;
        }

        console.log(`📤 回复: ${reply.slice(0, 120)}`);

        // 发回微信
        let sendResult: any;
        try {
          console.log(`[adamas] 📡 发送中... to=${fromUser.slice(0,20)}`);
          sendResult = await sendMessage(
            cred.token,
            fromUser,            // toUserId
            reply,               // text
            msg.contextToken,    // contextToken
            cred.accountId,      // clientId
            cred.baseUrl,        // baseUrl
          );
          console.log(`[adamas] 📡 发送结果: ${JSON.stringify(sendResult)}`);
        } catch (sendErr: any) {
          console.error(`[adamas] ❌ 发送异常: ${sendErr.message}`);
          continue;  // 跳过这条，继续处理其他消息
        }

        if (sendResult?.ok) {
          console.log(`[adamas] ✅ 发送成功`);
        } else {
          console.error(`[adamas] ❌ 发送失败: ${JSON.stringify(sendResult)}`);
        }
      }
    } catch (err: any) {
      failures++;
      console.error(`[adamas] 异常 (${failures}/10): ${err.message}`);
      if (failures > 10) process.exit(1);
      await sleep(3000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[adamas] 致命:", err);
  process.exit(1);
});
