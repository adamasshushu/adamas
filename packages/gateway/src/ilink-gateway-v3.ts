#!/usr/bin/env npx tsx
/**
 * iLink 网关 V3 — 双 Agent 架构（仿 hermes-agent weixin.py）
 *
 * 核心设计：
 *   - pollAgent:  独立的 HTTPS Agent，仅用于 getUpdates
 *   - sendAgent:  独立的 HTTPS Agent，仅用于 sendMessage
 *   - 所有请求都带随机 X-WECHAT-UIN
 *   - keepAlive 复用连接但不跨路径污染
 */

import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";
import * as path from "path";

const CRED_PATH = path.join(process.env.HOME || "/home/cyborg", ".adamas/weixin/credentials.json");
const ILINK_HOST = "ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.2.0";
const MAX_MSG_LEN = 2000;
const POLL_TIMEOUT_MS = 35_000;
const SEND_TIMEOUT_MS = 15_000;
const BACKOFF_MS = 30_000;

const LOCK_FILE = "/tmp/adamas-gateway.lock";

// ── 两个独立的 HTTPS Agent（核心！） ──
const pollAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const sendAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

function acquireLock(): boolean {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function loadCreds(): any {
  return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function randomUin(): string {
  return crypto.randomBytes(4).readUInt32BE(0).toString();
}

function makeHeaders(token: string, bodyBytes: number): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(bodyBytes),
    "Authorization": `Bearer ${token}`,
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "131584",
  };
}

// ── HTTP 请求（接受 agent 参数） ──
function httpsPost(
  ag: https.Agent,
  apiPath: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ILINK_HOST,
        path: apiPath,
        method: "POST",
        headers,
        agent: ag,             // ★ 使用指定的 Agent
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: {} });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

// ── API 方法 ──

async function doGetUpdates(
  token: string,
  syncBuf: string,
): Promise<{ msgs: any[]; syncBuf: string; pollTimeoutMs: number }> {
  const payload = {
    base_info: { channel_version: CHANNEL_VERSION },
    get_updates_buf: syncBuf,
  };
  const body = JSON.stringify(payload);
  const headers = makeHeaders(token, Buffer.byteLength(body, "utf-8"));

  try {
    const { data } = await httpsPost(pollAgent, "/ilink/bot/getupdates", headers, body, POLL_TIMEOUT_MS);

    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;
    if ((ret !== 0 && ret != null) || (errcode !== 0 && errcode != null)) {
      log(`getUpdates 错误 ret=${ret} errcode=${errcode} errmsg=${data.errmsg || ""}`);
      return { msgs: [], syncBuf, pollTimeoutMs: POLL_TIMEOUT_MS };
    }

    return {
      msgs: data.msgs || [],
      syncBuf: String(data.get_updates_buf || syncBuf),
      pollTimeoutMs: data.longpolling_timeout_ms || POLL_TIMEOUT_MS,
    };
  } catch (err: any) {
    if (!err.message?.includes("timeout")) {
      log(`getUpdates 异常: ${err.message}`);
    }
    return { msgs: [], syncBuf, pollTimeoutMs: POLL_TIMEOUT_MS };
  }
}

async function doSendMessage(
  token: string,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<boolean> {
  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: crypto.randomUUID(),
    message_type: 2, // MSG_TYPE_BOT
    message_state: 2, // MSG_STATE_FINISH
    item_list: [{ type: 1, text_item: { text } }],
  };
  if (contextToken) msg.context_token = contextToken;

  const payload = { base_info: { channel_version: CHANNEL_VERSION }, msg };
  const body = JSON.stringify(payload);
  const headers = makeHeaders(token, Buffer.byteLength(body, "utf-8"));

  try {
    const { data } = await httpsPost(sendAgent, "/ilink/bot/sendmessage", headers, body, SEND_TIMEOUT_MS);
    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;
    if ((ret !== 0 && ret != null) || (errcode !== 0 && errcode != null)) {
      log(`sendMessage 失败 ret=${ret} errcode=${errcode} errmsg=${data.errmsg || ""}`);
      return false;
    }
    log(`✅ sendMessage OK → ${toUserId.slice(-15)}`);
    return true;
  } catch (err: any) {
    log(`sendMessage 异常: ${err.message}`);
    return false;
  }
}

// ── 主循环 ──

async function main() {
  if (!acquireLock()) {
    console.error("已有网关运行中");
    process.exit(1);
  }

  const cred = loadCreds();
  log(`✅ 账号: ${cred.accountId}`);
  log("🔌 pollAgent + sendAgent 分离架构");

  let syncBuf = "";
  let seenMsgs = new Set<string>();
  let contextTokens = new Map<string, string>(); // userId → contextToken
  let failCount = 0;

  while (true) {
    // ── 1. 轮询消息（pollAgent） ──
    const { msgs, syncBuf: newSyncBuf } = await doGetUpdates(cred.token, syncBuf);
    syncBuf = newSyncBuf;

    if (msgs.length > 0) {
      failCount = 0;
    }

    // ── 2. 处理消息 + 回复（sendAgent） ──
    for (const raw of msgs) {
      const fromUserId = String(raw.from_user_id || "");
      const contextToken = String(raw.context_token || "");
      const messageId = String(raw.message_id || "");

      // 提取文本
      let text = "";
      for (const item of raw.item_list || []) {
        if (item.type === 1 && item.text_item?.text) {
          text = String(item.text_item.text);
          break;
        }
      }
      if (!text || !fromUserId) continue;

      // 去重
      const dedupKey = messageId || `${fromUserId}:${text}`;
      if (seenMsgs.has(dedupKey)) continue;
      seenMsgs.add(dedupKey);
      if (seenMsgs.size > 500) seenMsgs = new Set([...seenMsgs].slice(-100));

      // 保存 context token
      if (contextToken) contextTokens.set(fromUserId, contextToken);

      log(`📩 ${fromUserId.slice(-15)}: ${text.slice(0, 80)}`);

      // ── 回复（sendAgent） ──
      const reply = `[adamas] ${text}`.slice(0, MAX_MSG_LEN);
      await doSendMessage(cred.token, fromUserId, reply, contextTokens.get(fromUserId));
    }

    // ── 3. 错误退避 ──
    if (msgs.length === 0) {
      failCount++;
    }
    if (failCount >= 3) {
      log(`连续 ${failCount} 次无消息，退避 ${BACKOFF_MS / 1000}s`);
      await sleep(BACKOFF_MS);
      failCount = 0;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("致命:", err);
  process.exit(1);
});
