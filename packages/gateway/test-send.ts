#!/usr/bin/env npx tsx
/**
 * iLink 纯发送测试 — 不启动轮询，只发一条测试消息
 * 
 * 用法: npx tsx test-send.ts "要发的消息"
 * 用于验证 sendMessage 在无 getUpdates 污染时是否能正常工作
 */

import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";
import * as path from "path";

const CRED_PATH = path.join(process.env.HOME || "/home/cyborg", ".adamas/weixin/credentials.json");
const ILINK_HOST = "ilinkai.weixin.qq.com";

function loadCreds(): any {
  return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
}

function randomUin(): string {
  return crypto.randomBytes(4).readUInt32BE(0).toString();
}

async function sendTest(toUserId: string, text: string, token: string) {
  const msg = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: crypto.randomUUID(),
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
  const payload = { base_info: { channel_version: "2.2.0" }, msg };
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, "utf-8");

  console.log(`发送 to=${toUserId.slice(-15)} text="${text}" bytes=${bytes}`);
  console.log(`body preview: ${body.slice(0, 300)}`);

  return new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: ILINK_HOST,
        path: "/ilink/bot/sendmessage",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(bytes),
          Authorization: `Bearer ${token}`,
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomUin(),
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "131584",
        },
        timeout: 15_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          console.log(`HTTP ${res.statusCode}`);
          try {
            const data = JSON.parse(raw);
            console.log(`响应: ${JSON.stringify(data, null, 2)}`);
            const ret = data.ret ?? 0;
            const errcode = data.errcode ?? 0;
            if ((ret === 0 || ret == null) && (errcode === 0 || errcode == null)) {
              console.log("✅ sendMessage API 返回成功");
            } else {
              console.log(`❌ sendMessage API 返回失败 ret=${ret} errcode=${errcode}`);
            }
          } catch {
            console.log(`原始响应: ${raw.slice(0, 500)}`);
          }
          resolve();
        });
      },
    );
    req.on("error", (err) => {
      console.error(`❌ 请求失败: ${err.message}`);
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      console.error("❌ 请求超时");
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const text = process.argv[2];
  if (!text) {
    console.error("用法: npx tsx test-send.ts <消息文本>");
    process.exit(1);
  }

  const cred = loadCreds();
  console.log(`账号: ${cred.accountId}`);
  console.log(`Token: ${cred.token.slice(0, 20)}...`);

  // 需要知道发给谁 - 先 getUpdates 一次获取最近的发消息用户
  console.log("\n先查询最近消息获取目标用户...");
  const pollBody = JSON.stringify({
    base_info: { channel_version: "2.2.0" },
    get_updates_buf: "",
  });
  const pollBytes = Buffer.byteLength(pollBody, "utf-8");

  const targetUser = await new Promise<string>((resolve) => {
    const req = https.request(
      {
        hostname: ILINK_HOST,
        path: "/ilink/bot/getupdates",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(pollBytes),
          Authorization: `Bearer ${cred.token}`,
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomUin(),
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "131584",
        },
        timeout: 10_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            const msgs = data.msgs || [];
            if (msgs.length > 0) {
              console.log(`找到 ${msgs.length} 条消息`);
              for (const m of msgs) {
                const uid = String(m.from_user_id || "");
                const txt = (m.item_list || []).find((i: any) => i.type === 1)?.text_item?.text || "";
                console.log(`  from=${uid.slice(-15)}: ${txt.slice(0, 60)}`);
              }
              resolve(String(msgs[msgs.length - 1].from_user_id || ""));
            } else {
              console.log("无历史消息，请用其他微信号给 bot 发一条消息后重试");
              resolve("");
            }
          } catch {
            resolve("");
          }
        });
      },
    );
    req.on("error", () => resolve(""));
    req.write(pollBody);
    req.end();
  });

  if (!targetUser) {
    console.log("❌ 无法获取目标用户。请先发一条消息给 bot");
    process.exit(1);
  }

  console.log(`\n目标: ${targetUser.slice(-15)}`);
  await sendTest(targetUser, text, cred.token);
  console.log("\n请检查另一个微信号是否收到消息");
}

main().catch((err) => {
  console.error("致命:", err);
  process.exit(1);
});
