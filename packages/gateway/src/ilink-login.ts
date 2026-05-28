#!/usr/bin/env npx tsx
/**
 * iLink 持续登录脚本
 * 后台运行，自动刷新过期二维码，保存为 /tmp/adamas-ilink-qr.png
 * 用法: npx tsx packages/gateway/src/ilink-login.ts
 */

import { getQRCode, pollQRStatus, saveCredentials } from "./ilink.js";
import QRCode from "qrcode";
import * as fs from "fs";
import * as path from "path";

const QR_IMAGE_PATH = "/tmp/adamas-ilink-qr.png";
const STATUS_PATH = "/tmp/adamas-ilink-status.txt";
const CRED_PATH = path.join(
  process.env.HOME || "/home/cyborg",
  ".adamas/weixin/credentials.json"
);

function writeStatus(msg: string) {
  fs.writeFileSync(STATUS_PATH, msg + "\n");
  console.log(msg);
}

async function saveQRImage(qr: { qrcodeUrl?: string; qrcode: string }) {
  const data = qr.qrcodeUrl || qr.qrcode;
  // 先输出 URL 文本
  console.log(`QR_URL: ${data}`);
  // 生成 PNG 图片
  await QRCode.toFile(QR_IMAGE_PATH, data, {
    type: "png",
    width: 400,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  console.log(`QR_SAVED: ${QR_IMAGE_PATH}`);
}

async function main() {
  writeStatus("启动 iLink 扫码登录...");

  let qr = await getQRCode();
  await saveQRImage(qr);
  writeStatus("请扫描二维码");

  const deadline = Date.now() + 480 * 1000; // 8 分钟
  let refreshCount = 0;

  while (Date.now() < deadline) {
    try {
      const status = await pollQRStatus(qr.qrcode);

      if (status.status === "wait") {
        // 静默等待
      } else if (status.status === "scaned") {
        writeStatus("已扫码，请在微信确认...");
      } else if (status.status === "scaned_but_redirect") {
        writeStatus("重定向中...");
      } else if (status.status === "expired") {
        refreshCount++;
        if (refreshCount > 5) {
          writeStatus("二维码多次过期，放弃");
          process.exit(1);
        }
        writeStatus(`二维码已过期，刷新中... (${refreshCount}/5)`);
        qr = await getQRCode();
        await saveQRImage(qr);
        writeStatus("新二维码已生成，请扫描");
      } else if (status.status === "confirmed") {
        if (!status.ilinkBotId || !status.botToken) {
          writeStatus("登录确认但凭据不完整");
          process.exit(1);
        }
        const cred = {
          accountId: status.ilinkBotId,
          token: status.botToken,
          baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
          userId: status.ilinkUserId || "",
        };
        fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true });
        saveCredentials(cred);
        writeStatus(`✅ 登录成功！账号: ${cred.accountId}`);
        writeStatus(`DONE: ${cred.accountId}`);
        process.exit(0);
      }
    } catch (err: any) {
      console.error(`轮询错误: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  writeStatus("登录超时");
  process.exit(1);
}

main().catch((err) => {
  console.error("致命错误:", err);
  process.exit(1);
});
