#!/usr/bin/env npx tsx
/**
 * iLink 短轮询网关 V2 — 使用原生 https 替代 fetch 避免连接池共享
 * 根因假设：Node.js fetch 的全局连接池导致 getupdates 和 sendmessage 共享连接
 */

import * as fs from "fs";
import * as https from "https";
import * as path from "path";

const CRED_PATH = path.join(process.env.HOME || "/home/cyborg", ".adamas/weixin/credentials.json");
const ILINK_HOST = "ilinkai.weixin.qq.com";
const MAX_MSG_LEN = 2000;

const LOCK_FILE = "/tmp/adamas-gateway.lock";
function acquireLock(): boolean {
  try { const fd = fs.openSync(LOCK_FILE, "wx"); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
  catch { return false; }
}

function loadCreds(): any {
  return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
}

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

// ── 原生 HTTPS 请求（每次新连接，不共享池） ──
function httpsPost(path: string, headers: Record<string,string>, body: string): Promise<{status: number, data: any}> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ILINK_HOST,
      path: path,
      method: "POST",
      headers: { ...headers, "Connection": "close" },
      agent: new https.Agent({ keepAlive: false }),  // 禁用连接池！
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, data: {} }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function makeHeaders(token: string, cl: number): Record<string,string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(cl),
    "Authorization": "Bearer " + token,
    "AuthorizationType": "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "131584",
  };
}

async function main() {
  if (!acquireLock()) { console.error("已有网关运行"); process.exit(1); }

  const cred = loadCreds();
  log(`✅ ${cred.accountId}`);

  log("🚀 开始轮询 (原生https)");
  let syncBuf = "";
  let seenMsgs = new Set<string>();

  while (true) {
    // 1. getupdates
    let messages: any[] = [];
    try {
      const body = JSON.stringify({ base_info: { channel_version: "2.2.0" }, get_updates_buf: syncBuf });
      const h = { ...makeHeaders(cred.token, Buffer.byteLength(body, "utf-8")), "X-WECHAT-UIN": "test" };
      const { data } = await httpsPost("/ilink/bot/getupdates", h, body);
      if (data.get_updates_buf) syncBuf = data.get_updates_buf;
      messages = data.msgs || [];
    } catch (err: any) {
      if (!err.message.includes("timeout")) log(`轮询异常: ${err.message}`);
    }

    // 2. 处理消息
    for (const msg of messages) {
      const text = msg.itemList?.find((i: any) => i.type === 1)?.text_item?.text || msg.text || "";
      if (!text) continue;
      const msgKey = msg.messageId || `${msg.fromUserId}:${text}`;
      if (seenMsgs.has(msgKey)) continue;
      seenMsgs.add(msgKey);
      if (seenMsgs.size > 500) seenMsgs = new Set([...seenMsgs].slice(-100));

      log(`📩 ${msg.fromUserId.slice(-15)}: ${text.slice(0,80)}`);

      // 回复
      const reply = `[adamas] ${text}`.slice(0, MAX_MSG_LEN);
      log(`📤 ${reply.slice(0,80)}`);

      // 3. sendmessage（独立连接）
      try {
        const sBody = JSON.stringify({
          base_info: { channel_version: "2.2.0" },
          msg: { from_user_id: "", to_user_id: msg.fromUserId, client_id: cred.accountId, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: reply } }] }
        });
        const sH = makeHeaders(cred.token, Buffer.byteLength(sBody, "utf-8"));
        const { data: sData } = await httpsPost("/ilink/bot/sendmessage", sH, sBody);
        log(`✅ 已发送: ${JSON.stringify(sData)}`);
      } catch (err: any) {
        log(`❌ 发送失败: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(err => { console.error("致命:", err); process.exit(1); });
