// ── Gateway server ──
// 轻量级 HTTP 网关，处理微信 / Telegram 等消息平台
// 零外部依赖，纯 Node.js http 模块

import * as http from "http";
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";

export interface GatewayConfig {
  port: number;
  wechatToken?: string;   // 微信 Bot token，用于签名验证
}

export class GatewayServer {
  private agent: AdamasAgent;
  private config: GatewayConfig;
  private server: http.Server | null = null;

  constructor(agent: AdamasAgent, config: GatewayConfig) {
    this.agent = agent;
    this.config = config;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[adamas] Gateway listening on :${this.config.port}`);
        console.log(`[adamas] Webhook: POST http://0.0.0.0:${this.config.port}/wechat`);
        console.log(`[adamas] Health:  GET  http://0.0.0.0:${this.config.port}/health`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || "/";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 路由
    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agent: this.agent.getState() }));
      return;
    }

    if (url === "/wechat" && req.method === "GET") {
      // 微信服务器验证（首次配置时）
      this.handleWechatVerify(req, res);
      return;
    }

    if (url === "/wechat" && req.method === "POST") {
      await this.handleWechatMessage(req, res);
      return;
    }

    if (url === "/webhook" && req.method === "POST") {
      await this.handleGenericWebhook(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  /** 微信 URL 验证（GET 请求） */
  private handleWechatVerify(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const signature = url.searchParams.get("signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");
    const echostr = url.searchParams.get("echostr");

    // 简单模式：有 token 就验证，没有则直接回显
    if (this.config.wechatToken && signature) {
      const crypto = require("crypto");
      const tmp = [this.config.wechatToken, timestamp, nonce].sort().join("");
      const sha1 = crypto.createHash("sha1").update(tmp).digest("hex");
      if (sha1 !== signature) {
        res.writeHead(403);
        res.end("invalid signature");
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(echostr || "ok");
  }

  /** 接收微信消息（POST） */
  private async handleWechatMessage(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = await this.readBody(req);
      console.log("[adamas] WeChat message:", body.slice(0, 200));

      // 解析微信 XML/JSON 消息
      const msg = this.parseWechatMessage(body);
      if (!msg) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "empty message" }));
        return;
      }

      console.log(`[adamas] User(${msg.from}): ${msg.content}`);

      // 调用 Agent
      const reply = await this.agent.chat(msg.content);

      // 构建微信回复
      const response = this.buildWechatReply(msg, reply);
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(response);
    } catch (err) {
      console.error("[adamas] WeChat error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  /** 通用 webhook（JSON POST） */
  private async handleGenericWebhook(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = await this.readBody(req);
      const data = JSON.parse(body);
      const message = data.message || data.text || data.content || "";

      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no message field" }));
        return;
      }

      console.log(`[adamas] Webhook: ${message.slice(0, 200)}`);
      const reply = await this.agent.chat(message);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply, state: this.agent.getState() }));
    } catch (err) {
      console.error("[adamas] Webhook error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  // ── 微信消息解析 ──

  private parseWechatMessage(body: string): WechatMessage | null {
    // 尝试 JSON
    try {
      const json = JSON.parse(body);
      if (json.MsgType === "text" || json.Content) {
        return {
          from: json.FromUserName || "unknown",
          to: json.ToUserName || "",
          content: json.Content || "",
          type: "text",
          msgId: json.MsgId || "",
        };
      }
    } catch { /* not JSON, try XML */ }

    // 尝试 XML
    const content = this.xmlTag(body, "Content");
    if (content) {
      return {
        from: this.xmlTag(body, "FromUserName") || "unknown",
        to: this.xmlTag(body, "ToUserName") || "",
        content,
        type: this.xmlTag(body, "MsgType") || "text",
        msgId: this.xmlTag(body, "MsgId") || "",
      };
    }

    return null;
  }

  private xmlTag(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
    if (m) return m[1];
    const m2 = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return m2 ? m2[1] : "";
  }

  private buildWechatReply(msg: WechatMessage, reply: string): string {
    return [
      "<xml>",
      `<ToUserName><![CDATA[${msg.from}]]></ToUserName>`,
      `<FromUserName><![CDATA[${msg.to}]]></FromUserName>`,
      `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
      `<MsgType><![CDATA[text]]></MsgType>`,
      `<Content><![CDATA[${reply}]]></Content>`,
      "</xml>",
    ].join("\n");
  }

  // ── 工具 ──

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }
}

interface WechatMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  msgId: string;
}
