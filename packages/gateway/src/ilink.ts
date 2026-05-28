// ── iLink Bot Client ──
// 腾讯官方 WeChat Bot API（不是 WeChaty）
// 协议逆向自 hermes-agent/gateway/platforms/weixin.py
//
// 流程:
//   1. qrLogin()     → GET get_bot_qrcode → 轮询状态 → confirmed → 获取 token
//   2. startPoll()   → POST getupdates 长轮询收消息
//   3. sendMessage() → POST sendmessage 发消息

import * as crypto from "crypto";

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0; // 131584
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;

// ── 工具函数 ──

function randomWechatUin(): string {
  const v = crypto.randomInt(0, 0xffffffff);
  return Buffer.from(String(v)).toString("base64");
}

function makeHeaders(token?: string, bodyLen?: number): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (bodyLen) h["Content-Length"] = String(bodyLen);
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

// ── HTTP 封装 ──

async function apiGet(endpoint: string): Promise<any> {
  const url = `${ILINK_BASE_URL}/${endpoint}`;
  const resp = await fetch(url, {
    headers: {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    },
    signal: AbortSignal.timeout(QR_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`iLink GET ${endpoint} HTTP ${resp.status}`);
  return resp.json();
}

async function apiPost(
  token: string,
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<any> {
  const body: Record<string, unknown> = { ...payload, base_info: baseInfo() };
  const bodyStr = JSON.stringify(body);
  const url = `${ILINK_BASE_URL}/${endpoint}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: makeHeaders(token, bodyStr.length),
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`iLink POST ${endpoint} HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// ── QR 登录 ──

export interface ILinkCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
  userId: string;
}

export interface QRCodeResult {
  qrcode: string;       // hex token for polling
  qrcodeUrl: string;    // full liteapp URL to encode as QR
}

export interface QRStatusResult {
  status: "wait" | "scaned" | "scaned_but_redirect" | "confirmed" | "expired";
  ilinkBotId?: string;
  botToken?: string;
  baseurl?: string;
  ilinkUserId?: string;
  redirectHost?: string;
}

/** 获取扫码二维码 */
export async function getQRCode(): Promise<QRCodeResult> {
  const resp = await apiGet("ilink/bot/get_bot_qrcode?bot_type=3");
  const qrcode = String(resp.qrcode || "");
  const qrcodeUrl = String(resp.qrcode_img_content || "");
  if (!qrcode) throw new Error("QR response missing qrcode");
  return { qrcode, qrcodeUrl };
}

/** 轮询扫码状态 */
export async function pollQRStatus(qrcode: string): Promise<QRStatusResult> {
  const resp = await apiGet(`ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
  return {
    status: String(resp.status || "wait") as any,
    ilinkBotId: resp.ilink_bot_id ? String(resp.ilink_bot_id) : undefined,
    botToken: resp.bot_token ? String(resp.bot_token) : undefined,
    baseurl: resp.baseurl ? String(resp.baseurl) : undefined,
    ilinkUserId: resp.ilink_user_id ? String(resp.ilink_user_id) : undefined,
    redirectHost: resp.redirect_host ? String(resp.redirect_host) : undefined,
  };
}

/** 完整 QR 登录流程（直到 confirmed 或超时） */
export async function qrLogin(
  timeoutSeconds: number = 480,
  onQR?: (qr: QRCodeResult) => void,
  onStatus?: (status: string) => void,
): Promise<ILinkCredentials | null> {
  let qr = await getQRCode();
  onQR?.(qr);

  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const status = await pollQRStatus(qr.qrcode);

      if (status.status === "wait") {
        onStatus?.("wait");
        await sleep(2000);
      } else if (status.status === "scaned") {
        onStatus?.("scaned");
        await sleep(1000);
      } else if (status.status === "scaned_but_redirect") {
        onStatus?.("redirect");
        await sleep(1000);
      } else if (status.status === "expired") {
        onStatus?.("expired");
        qr = await getQRCode();
        onQR?.(qr);
      } else if (status.status === "confirmed") {
        onStatus?.("confirmed");
        if (!status.ilinkBotId || !status.botToken) {
          throw new Error("QR confirmed but credential payload incomplete");
        }
        return {
          accountId: status.ilinkBotId,
          token: status.botToken,
          baseUrl: status.baseurl || ILINK_BASE_URL,
          userId: status.ilinkUserId || "",
        };
      }
    } catch (err) {
      onStatus?.(`error:${err}`);
      await sleep(1000);
    }
  }

  return null; // 超时
}

// ── 消息收发 ──

export interface WeixinMessage {
  messageId: string;
  fromUserId: string;
  toUserId: string;
  contextToken: string;
  roomId?: string;
  text: string;
  itemList: Array<{ type: number; text_item?: { text: string } }>;
}

export interface GetUpdatesResponse {
  msgs: WeixinMessage[];
  getUpdatesBuf: string;
  longpollingTimeoutMs: number;
}

/** 长轮询获取消息 */
export async function getUpdates(
  token: string,
  syncBuf: string,
  baseUrl: string = ILINK_BASE_URL,
): Promise<{ result: GetUpdatesResponse | null; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      ...baseInfo(),
      get_updates_buf: syncBuf,
    };
    const bodyStr = JSON.stringify(body);
    const url = `${baseUrl}/ilink/bot/getupdates`;

    const resp = await fetch(url, {
      method: "POST",
      headers: makeHeaders(token, bodyStr.length),
      body: bodyStr,
      signal: AbortSignal.timeout(LONG_POLL_TIMEOUT_MS + 5000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { result: null, error: `HTTP ${resp.status}: ${err.slice(0, 200)}` };
    }

    const data = await resp.json();
    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;

    if (ret !== 0 && ret != null || errcode !== 0 && errcode != null) {
      return { result: null, error: `ret=${ret} errcode=${errcode} errmsg=${data.errmsg || ""}` };
    }

    return {
      result: {
        msgs: (data.msgs || []).map((m: any) => ({
          messageId: String(m.message_id || ""),
          fromUserId: String(m.from_user_id || ""),
          toUserId: String(m.to_user_id || ""),
          contextToken: String(m.context_token || ""),
          roomId: m.room_id || m.chat_room_id || undefined,
          text: extractText(m.item_list || []),
          itemList: m.item_list || [],
        })),
        getUpdatesBuf: String(data.get_updates_buf || syncBuf),
        longpollingTimeoutMs: data.longpolling_timeout_ms || LONG_POLL_TIMEOUT_MS,
      },
    };
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { result: { msgs: [], getUpdatesBuf: syncBuf, longpollingTimeoutMs: LONG_POLL_TIMEOUT_MS } };
    }
    return { result: null, error: String(err) };
  }
}

/** 发送文本消息 */
export async function sendMessage(
  token: string,
  toUserId: string,
  text: string,
  contextToken?: string,
  clientId?: string,
  baseUrl: string = ILINK_BASE_URL,
): Promise<{ ok: boolean; errcode?: number; errmsg?: string }> {
  if (!text.trim()) throw new Error("text must not be empty");

  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: clientId || crypto.randomUUID(),
    message_type: 2,    // MSG_TYPE_BOT
    message_state: 2,    // MSG_STATE_FINISH
    item_list: [{ type: 1, text_item: { text } }],
  };
  if (contextToken) msg.context_token = contextToken;

  const body: Record<string, unknown> = { ...baseInfo(), msg };
  const bodyStr = JSON.stringify(body);
  const url = `${baseUrl}/ilink/bot/sendmessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: makeHeaders(token, bodyStr.length),
    body: bodyStr,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { ok: false, errmsg: `HTTP ${resp.status}: ${err.slice(0, 200)}` };
  }

  const data = await resp.json();
  return { ok: data.ret === 0 || data.ret == null, errcode: data.errcode, errmsg: data.errmsg };
}

// ── 工具 ──

function extractText(itemList: any[]): string {
  for (const item of itemList || []) {
    if (item.type === 1 && item.text_item?.text) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 凭据持久化 ──

import * as fs from "fs";
import * as path from "path";

function credPath(): string {
  const dir = path.resolve(process.env.HOME || "/tmp", ".adamas", "weixin");
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir, "credentials.json");
}

export function saveCredentials(cred: ILinkCredentials): void {
  fs.writeFileSync(credPath(), JSON.stringify({ ...cred, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function loadCredentials(): ILinkCredentials | null {
  try {
    const raw = fs.readFileSync(credPath(), "utf-8");
    return JSON.parse(raw) as ILinkCredentials;
  } catch {
    return null;
  }
}
