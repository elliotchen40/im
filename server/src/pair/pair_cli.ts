#!/usr/bin/env node
/**
 * 扫码配对 CLI —— 在服务器上跑 `npm run pair`，终端出现二维码，手机 app 扫码即完成绑定。
 *
 * 做的事：
 *   1) 生成一次性配对码，写 data/pairing.json（只存 hash）
 *   2) 终端渲染二维码：im://pair?u=<公网地址>&c=<配对码>
 *   3) 轮询该文件的 usedAt，配对成功即打印结果并退出
 *
 * 公网地址来源（按优先级）：
 *   1) 环境变量 / .env 的 IM_PUBLIC_URL   ← 走 cloudflare 隧道时填 https://im.example.com
 *   2) 自动探测的局域网 IP + IM_HTTP_PORT ← 手机与服务器同网时可用
 *
 * 用法：
 *   npm run pair
 *   IM_PUBLIC_URL=https://im.example.com npm run pair
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import qrcode from "qrcode-terminal";
import {
  PAIRING_TTL_MS,
  buildPairingPayload,
  generateCode,
  hashCode,
  pairingFilePath,
  readPairing,
  writePairing,
} from "./pairing.js";

/** 读 .env（与 index.ts 的解析保持一致：去引号、忽略注释） */
function readEnvFile(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = val;
  }
  return out;
}

/** 取第一个非回环的 IPv4 地址（用于局域网配对） */
function detectLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

/** 轮询等待配对完成；返回 true = 成功，false = 超时 */
async function waitForPairing(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  while (Date.now() < deadline) {
    const rec = readPairing(file);
    if (rec && rec.usedAt !== null) return true;
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (!warned && left <= 60) {
      process.stdout.write("\n等待扫码…");
      warned = true;
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  return false;
}

/** 探测本机 daemon 是否在跑（配对成功后 app 要连它） */
async function daemonAlive(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/im/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const envPath = process.env.IM_ENV_FILE ?? ".env";
  const env: Record<string, string> = { ...readEnvFile(envPath), ...process.env } as Record<string, string>;

  const dbPath = env.IM_BOT_DB_PATH ?? env.WX_BOT_DB_PATH ?? "./data/im_bot.db";
  const dataDir = env.IM_DATA_DIR ?? path.join(path.dirname(dbPath) || ".", "im");
  const file = pairingFilePath(dataDir);
  const port = env.IM_HTTP_PORT ?? "8787";

  const token = (env.IM_APP_TOKEN ?? "").trim();
  if (!token) {
    console.error(
      "✗ IM_APP_TOKEN 未配置 —— 服务端会拒绝启动，配对也没有东西可发。\n" +
        `  请在 ${envPath} 里填 IM_APP_TOKEN（生成：openssl rand -hex 32）`,
    );
    process.exit(1);
  }

  // 公网地址
  let publicUrl = (env.IM_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!publicUrl) {
    publicUrl = `http://${detectLanIp()}:${port}`;
    console.log(
      "⚠️  未设置 IM_PUBLIC_URL，改用局域网地址。\n" +
        "   手机需与服务器在同一网络；走 Cloudflare 隧道时请设置：\n" +
        "     IM_PUBLIC_URL=https://im.example.com\n",
    );
  }

  const alive = await daemonAlive(port);
  if (!alive) {
    console.log(
      `⚠️  本机 ${port} 端口没有响应 —— 配对能成功，但 app 扫码后连不上。\n` +
        "   请先在另一个终端跑：npm run dev\n",
    );
  }

  const code = generateCode();
  const now = Date.now();
  writePairing(file, {
    codeHash: hashCode(code),
    expiresAt: now + PAIRING_TTL_MS,
    publicUrl,
    attempts: 0,
    usedAt: null,
    createdAt: now,
  });

  const payload = buildPairingPayload(publicUrl, code);

  console.log("─".repeat(58));
  console.log("  用 im app 的「扫码登录」扫下面的二维码");
  console.log("─".repeat(58));
  console.log();
  qrcode.generate(payload, { small: true });
  console.log();
  console.log(`  服务端地址：${publicUrl}`);
  console.log(`  配对码：    ${code}`);
  console.log(`  有效期：    ${PAIRING_TTL_MS / 60000} 分钟（一次性，用过即废）`);
  console.log("─".repeat(58));

  const ok = await waitForPairing(file, PAIRING_TTL_MS);
  if (ok) {
    const rec = readPairing(file);
    console.log(`\n✅ 配对成功${rec?.pairedFrom ? `（来自 ${rec.pairedFrom}）` : ""}！`);
    console.log("   app 已拿到地址与 token，应该会自动连接。");
  } else {
    console.log("\n⌛ 配对码已过期，未收到扫码。重新运行 `npm run pair` 生成新码。");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("配对失败:", err);
  process.exit(1);
});
