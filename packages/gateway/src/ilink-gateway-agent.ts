#!/usr/bin/env npx tsx
/**
 * iLink AI Agent 网关 V4
 *
 * 双 Agent 架构 + LLM 智能回复（ReAct 模式）
 *   - pollAgent:  独立的 HTTPS Agent，仅用于 getUpdates
 *   - sendAgent:  独立的 HTTPS Agent，仅用于 sendMessage
 *   - chatAgent:  每个用户独立的 AdamasAgent 实例（保持对话上下文）
 */

import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";
import * as path from "path";
import * as yaml from "yaml";
import { AdamasAgent, type AdamasConfig } from "@adamas/core";

const CRED_PATH = path.join(process.env.HOME || "/home/cyborg", ".adamas/weixin/credentials.json");
const ILINK_HOST = "ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.2.0";
const MAX_MSG_LEN = 2000;
const POLL_TIMEOUT_MS = 35_000;
const SEND_TIMEOUT_MS = 15_000;
const AGENT_TIMEOUT_MS = 120_000; // Agent 思考超时 2 分钟
const BACKOFF_MS = 30_000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 会话 30 分钟过期

const LOCK_FILE = "/tmp/adamas-gateway.lock";

// ── 两个独立的 HTTPS Agent ──
const pollAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const sendAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

function acquireLock(): boolean {
  try { const fd = fs.openSync(LOCK_FILE, "wx"); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
  catch { return false; }
}
function loadCreds(): any { return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8")); }
function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function randomUin(): string { return crypto.randomBytes(4).readUInt32BE(0).toString(); }

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

// ── HTTP ──
function httpsPost(
  ag: https.Agent, apiPath: string, headers: Record<string, string>,
  body: string, timeoutMs: number,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: ILINK_HOST, path: apiPath, method: "POST", headers, agent: ag, timeout: timeoutMs }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode || 0, data: {} }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body); req.end();
  });
}

// ── iLink API ──
async function doGetUpdates(token: string, syncBuf: string) {
  const body = JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, get_updates_buf: syncBuf });
  const headers = makeHeaders(token, Buffer.byteLength(body, "utf-8"));
  try {
    const { data } = await httpsPost(pollAgent, "/ilink/bot/getupdates", headers, body, POLL_TIMEOUT_MS);
    const ret = data.ret ?? 0; const errcode = data.errcode ?? 0;
    if ((ret !== 0 && ret != null) || (errcode !== 0 && errcode != null)) {
      log(`getUpdates err ret=${ret} errcode=${errcode}`);
      return { msgs: [], syncBuf, pollTimeoutMs: POLL_TIMEOUT_MS };
    }
    return { msgs: data.msgs || [], syncBuf: String(data.get_updates_buf || syncBuf), pollTimeoutMs: data.longpolling_timeout_ms || POLL_TIMEOUT_MS };
  } catch (err: any) {
    if (!err.message?.includes("timeout")) log(`getUpdates 异常: ${err.message}`);
    return { msgs: [], syncBuf, pollTimeoutMs: POLL_TIMEOUT_MS };
  }
}

async function doSendMessage(token: string, toUserId: string, text: string, contextToken?: string): Promise<boolean> {
  const msg: Record<string, unknown> = {
    from_user_id: "", to_user_id: toUserId, client_id: crypto.randomUUID(),
    message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }],
  };
  if (contextToken) msg.context_token = contextToken;
  const body = JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, msg });
  const headers = makeHeaders(token, Buffer.byteLength(body, "utf-8"));
  try {
    const { data } = await httpsPost(sendAgent, "/ilink/bot/sendmessage", headers, body, SEND_TIMEOUT_MS);
    const ret = data.ret ?? 0; const errcode = data.errcode ?? 0;
    if ((ret !== 0 && ret != null) || (errcode !== 0 && errcode != null)) {
      log(`sendMessage 失败 ret=${ret} errcode=${errcode}`);
      return false;
    }
    return true;
  } catch (err: any) { log(`sendMessage 异常: ${err.message}`); return false; }
}

// ── 分片发送长消息 ──
async function sendLongMessage(token: string, toUserId: string, text: string, ctxToken?: string) {
  if (text.length <= MAX_MSG_LEN) {
    return doSendMessage(token, toUserId, text, ctxToken);
  }
  // 按 2000 字符分片
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
    chunks.push(text.slice(i, i + MAX_MSG_LEN));
  }
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = i < chunks.length - 1 ? chunks[i] + "\n(continued...)" : chunks[i];
    if (!(await doSendMessage(token, toUserId, chunk, ctxToken))) ok = false;
    await sleep(500);
  }
  return ok;
}

// ── 配置加载 ──

/** 从 ~/.hermes/config.yaml 获取 API key */
function loadApiKey(): { apiKey: string; provider: string; model: string; baseUrl: string } {
  const result = { apiKey: "", provider: "deepseek", model: "deepseek-chat", baseUrl: "" };
  try {
    const hermesConfig = path.resolve(process.env.HOME || "/tmp", ".hermes", "config.yaml");
    if (!fs.existsSync(hermesConfig)) return result;
    const cfg = yaml.parse(fs.readFileSync(hermesConfig, "utf-8"));
    const m = cfg?.model;
    if (!m) return result;
    result.apiKey = m.api_key || "";
    result.provider = m.provider || "deepseek";
    result.model = m.default || "deepseek-chat";
    result.baseUrl = m.base_url || "";
  } catch { /* not installed */ }
  if (!result.apiKey) result.apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "";
  return result;
}

/** 加载 SOUL.md */
function loadSoul(): string {
  try {
    return fs.readFileSync(path.resolve(process.env.HOME || "/tmp", ".adamas", "SOUL.md"), "utf-8");
  } catch {
    return "你是 Adamas，一个智能 AI 助手。请用中文回复，简洁友好。";
  }
}

// ── Agent 管理 ──

interface UserSession {
  agent: AdamasAgent;
  lastActive: number;
}

const sessions = new Map<string, UserSession>();
let defaultSoul: string = "";

function getOrCreateAgent(userId: string): AdamasAgent {
  const now = Date.now();
  // 清理过期会话
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
      log(`🧹 会话过期: ${id.slice(-10)}`);
    }
  }

  const existing = sessions.get(userId);
  if (existing) {
    existing.lastActive = now;
    return existing.agent;
  }

  // 创建新 Agent
  const apiKey = loadApiKey();
  if (!apiKey.apiKey) {
    log("❌ 无 API Key！请设置 DEEPSEEK_API_KEY 或配置 ~/.hermes/config.yaml");
    throw new Error("No API key configured");
  }

  const config: AdamasConfig = {
    model: {
      provider: apiKey.provider as any,
      model: apiKey.model,
      apiKey: apiKey.apiKey,
      temperature: 0.7,
      maxTokens: 4096,
    },
    terminal: { rtkEnabled: false, timeout: 60 },
    browser: { backend: "camoufox", url: "http://localhost:9377" },
    agents: { maxIterations: 15, maxToolCallsPerTurn: 5 },
  };

  const agent = new AdamasAgent(config);
  agent.setSystemPrompt(defaultSoul);
  sessions.set(userId, { agent, lastActive: now });
  log(`🆕 新会话: ${userId.slice(-10)}`);
  return agent;
}

async function agentReply(userId: string, userMessage: string): Promise<string> {
  try {
    const agent = getOrCreateAgent(userId);

    // 带超时的 Agent 调用
    const result = await Promise.race([
      agent.chat(userMessage),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Agent timeout")), AGENT_TIMEOUT_MS)),
    ]);

    return result;
  } catch (err: any) {
    log(`Agent 错误: ${err.message}`);
    // 如果是超时或 API 错误，清理会话让下次重试
    if (err.message?.includes("timeout") || err.message?.includes("API") || err.message?.includes("429")) {
      sessions.delete(userId);
    }
    return `抱歉，AI 服务暂时不可用：${err.message.slice(0, 100)}`;
  }
}

// ── 主循环 ──

async function main() {
  if (!acquireLock()) { console.error("已有网关运行中"); process.exit(1); }

  const cred = loadCreds();
  defaultSoul = loadSoul();
  log(`✅ 账号: ${cred.accountId}`);
  log(`🧠 AI Agent 模式 | 模型: ${loadApiKey().model || "?"}`);
  log("🔌 pollAgent + sendAgent 分离架构");

  let syncBuf = "";
  let seenMsgs = new Set<string>();
  let contextTokens = new Map<string, string>();
  let failCount = 0;

  while (true) {
    const { msgs, syncBuf: newSyncBuf } = await doGetUpdates(cred.token, syncBuf);
    syncBuf = newSyncBuf;
    if (msgs.length > 0) failCount = 0;

    for (const raw of msgs) {
      const fromUserId = String(raw.from_user_id || "");
      const contextToken = String(raw.context_token || "");
      const messageId = String(raw.message_id || "");

      let text = "";
      for (const item of raw.item_list || []) {
        if (item.type === 1 && item.text_item?.text) { text = String(item.text_item.text); break; }
      }
      if (!text || !fromUserId) continue;

      const dedupKey = messageId || `${fromUserId}:${text}`;
      if (seenMsgs.has(dedupKey)) continue;
      seenMsgs.add(dedupKey);
      if (seenMsgs.size > 500) seenMsgs = new Set([...seenMsgs].slice(-100));
      if (contextToken) contextTokens.set(fromUserId, contextToken);

      log(`📩 ${fromUserId.slice(-15)}: ${text.slice(0, 80)}`);

      // ── AI Agent 回复 ──
      const ctxTok = contextTokens.get(fromUserId);
      try {
        const reply = await agentReply(fromUserId, text);
        log(`🤖 ${reply.slice(0, 80)}`);
        await sendLongMessage(cred.token, fromUserId, reply, ctxTok);
        log(`✅ 已回复`);
      } catch (err: any) {
        log(`❌ 回复失败: ${err.message}`);
      }
    }

    if (msgs.length === 0) {
      failCount++;
      if (failCount >= 3) {
        log(`连续 ${failCount} 次无消息，退避 ${BACKOFF_MS / 1000}s`);
        await sleep(BACKOFF_MS);
        failCount = 0;
      }
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => { console.error("致命:", err); process.exit(1); });
