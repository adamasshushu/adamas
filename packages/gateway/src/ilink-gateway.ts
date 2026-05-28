#!/usr/bin/env npx tsx
/**
 * iLink 长轮询网关 — 持续拉取微信消息 → Agent 处理 → 回复
 * 用法: npx tsx packages/gateway/src/ilink-gateway.ts
 */

import * as fs from "fs";
import * as path from "path";
import { getUpdates, sendMessage, type ILinkCredentials } from "./ilink.js";

const CRED_PATH = path.join(process.env.HOME || "/home/cyborg", ".adamas/weixin/credentials.json");
const MAX_MSG_LEN = 2000;          // iLink 消息上限
const POLL_FAIL_LIMIT = 10;
const LOG_FILE = "/tmp/adamas-gateway.log";

// ── 单实例锁 ──
const LOCK_FILE = "/tmp/adamas-gateway.lock";
function acquireLock(): boolean {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }

// ── 凭据 ──
function loadCreds(): ILinkCredentials {
  if (!fs.existsSync(CRED_PATH)) throw new Error(`凭据不存在: ${CRED_PATH}`);
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
  return {
    accountId: raw.accountId, token: raw.token,
    baseUrl: raw.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: raw.userId || "",
  };
}

// ── 日志 ──
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

// ── 截断长消息 ──
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // 在 >>> 之前截断，保持语义完整
  const sep = text.lastIndexOf("\n", max);
  const cut = sep > max * 0.7 ? sep : max;
  return text.slice(0, cut) + "\n\n…(消息过长已截断)";
}

async function main() {
  // 单实例
  if (!acquireLock()) {
    console.error("[adamas] 已有网关进程在运行");
    process.exit(1);
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(); });

  const cred = loadCreds();
  log(`✅ 凭据: ${cred.accountId}`);

  // Agent
  let agent: any = null;
  try {
    const { AdamasAgent } = await import("@adamas/core");
    const { loadConfig } = await import("@adamas/cli/config");
    agent = new AdamasAgent(await loadConfig());
    log(`🤖 Agent 就绪`);
  } catch (err: any) {
    log(`⚠️ Agent 不可用: ${err.message}`);
  }

  log("🚀 长轮询开始");
  let syncBuf = "";
  let failCount = 0;
  let seenMsgs = new Set<string>();  // 去重

  while (true) {
    try {
      const { result, error } = await getUpdates(cred.token, syncBuf, cred.baseUrl);

      if (error) {
        // "timeout" 是长轮询正常超时，不算错误
        if (error.includes("timeout") || error.includes("aborted")) {
          continue;  // 静默重试
        }
        failCount++;
        log(`❌ 轮询错误 (${failCount}/${POLL_FAIL_LIMIT}): ${error}`);
        if (failCount >= POLL_FAIL_LIMIT) { log("连续失败过多，退出"); process.exit(1); }
        await sleep(3000);
        continue;
      }
      failCount = 0;

      if (!result) { await sleep(500); continue; }
      if (result.getUpdatesBuf) syncBuf = result.getUpdatesBuf;

      for (const msg of result.msgs) {
        const text = msg.itemList?.find((i: any) => i.type === 1)?.text_item?.text || msg.text || "";
        if (!text) continue;

        // 去重
        const msgKey = msg.messageId || `${msg.fromUserId}:${text}`;
        if (seenMsgs.has(msgKey)) continue;
        seenMsgs.add(msgKey);
        if (seenMsgs.size > 1000) seenMsgs = new Set([...seenMsgs].slice(-200));

        log(`📩 ${msg.fromUserId.slice(-15)}: ${text.slice(0, 80)}`);

        // Agent 回复
        let reply: string;
        try {
          reply = agent ? await agent.chat(text) : `[echo] ${text}`;
        } catch (err: any) {
          reply = `❌ ${err.message}`;
        }
        reply = truncate(reply, MAX_MSG_LEN);
        log(`📤 ${reply.slice(0, 80)}`);

        // 发送
        try {
          const sr = await sendMessage(cred.token, msg.fromUserId, reply, msg.contextToken, cred.accountId, cred.baseUrl);
          log(sr.ok ? `✅ 已发送` : `❌ 发送失败: errcode=${sr.errcode} errmsg=${sr.errmsg}`);
        } catch (err: any) {
          log(`❌ 发送异常: ${err.message}`);
        }
      }
    } catch (err: any) {
      failCount++;
      log(`⚠️ 异常 (${failCount}/${POLL_FAIL_LIMIT}): ${err.message}`);
      if (failCount >= POLL_FAIL_LIMIT) process.exit(1);
      await sleep(3000);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error("致命:", err); process.exit(1); });
