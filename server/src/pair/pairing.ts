/**
 * 扫码配对 —— 一次性「扫码换 token」机制，取代手填地址 + token。
 *
 * ## 流程
 * ```
 * 服务器                                   手机 app
 * ───────────────────────────────────────  ──────────────────────
 * npm run pair
 *   ├─ 生成一次性配对码（8 位，去易混字符）
 *   ├─ 写 data/pairing.json（只存 sha256(code)，不存明文）
 *   └─ 终端渲染二维码 im://pair?u=<url>&c=<code>
 *                                            扫码 → 解析出 url + code
 *                                             POST {url}/im/pair { code }
 *   ◀──────────────────────────────────────
 *   ├─ 校验：存在 / 未过期 / 未使用 / 失败次数未超限
 *   ├─ 标记 usedAt
 *   └─ 返回 { baseUrl, token, userId }
 *                                            保存到 preferences → 开始长轮询
 * ```
 *
 * ## 为什么不是把 token 直接塞进二维码
 * 二维码可能被旁人看到、被截图、被发到群里。用**一次性 + 短时效（默认 5 分钟）**的配对码，
 * 泄露窗口小得多，而且配对成功后码立即作废、再扫无效。
 *
 * ## 文件即 IPC
 * CLI（`npm run pair`）与 daemon 是**两个进程**，用 `data/pairing.json` 作为共享状态：
 * CLI 写码、daemon 校验并标记 used、CLI 轮询到 used 就退出。同机同目录，无需额外鉴权通道。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 配对码有效期：5 分钟（够扫码，又足够短） */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
/** 同一配对码最多允许几次失败校验（防爆破） */
export const PAIRING_MAX_ATTEMPTS = 5;
/** 去掉 I / O / 0 / 1 等易混字符，降低手输/OCR 出错率 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

export interface PairingRecord {
  /** sha256(大写去空格后的 code) */
  codeHash: string;
  expiresAt: number;
  /** 二维码里携带的公网地址（cloudflare 隧道域名或局域网地址） */
  publicUrl: string;
  /** 已失败校验次数 */
  attempts: number;
  /** 配对成功的时刻；非 null 表示该码已作废 */
  usedAt: number | null;
  createdAt: number;
  /** 配对成功后由 daemon 写入，便于 CLI 显示"已连接" */
  pairedFrom?: string;
}

export type PairingFailReason =
  | "no_pairing"
  | "expired"
  | "used"
  | "too_many_attempts"
  | "bad_code";

export type PairingCheck = { ok: true; record: PairingRecord } | { ok: false; reason: PairingFailReason };

export function pairingFilePath(dataDir: string): string {
  return path.join(dataDir, "pairing.json");
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** 生成一次性配对码（约 40 bit 熵） */
export function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function readPairing(file: string): PairingRecord | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw) as PairingRecord;
  } catch {
    // 半写（进程被杀）→ 当作没有配对
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename，避免 daemon 读到半个文件 */
export function writePairing(file: string, rec: PairingRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** 校验配对码；失败时递增 attempts（bad_code 情况） */
export function verifyPairingCode(file: string, code: string): PairingCheck {
  const rec = readPairing(file);
  if (!rec) return { ok: false, reason: "no_pairing" };
  if (rec.usedAt !== null) return { ok: false, reason: "used" };
  if (Date.now() > rec.expiresAt) return { ok: false, reason: "expired" };
  if (rec.attempts >= PAIRING_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  if (hashCode(code) !== rec.codeHash) {
    rec.attempts += 1;
    try {
      writePairing(file, rec);
    } catch {
      // 写失败不影响拒绝；下一次仍会读旧值
    }
    return { ok: false, reason: rec.attempts >= PAIRING_MAX_ATTEMPTS ? "too_many_attempts" : "bad_code" };
  }

  return { ok: true, record: rec };
}

/** 标记配对完成（该码作废） */
export function consumePairing(file: string, from: string): void {
  const rec = readPairing(file);
  if (!rec) return;
  rec.usedAt = Date.now();
  rec.pairedFrom = from;
  writePairing(file, rec);
}

/** 组二维码载荷：自定义 scheme，便于 app 识别不是普通网址 */
export function buildPairingPayload(publicUrl: string, code: string): string {
  return `im://pair?u=${encodeURIComponent(publicUrl)}&c=${encodeURIComponent(code)}`;
}

export interface ParsedPairingPayload {
  publicUrl: string;
  code: string;
}

/** 解析二维码载荷（app 侧同逻辑；服务端用于自检/测试） */
export function parsePairingPayload(text: string): ParsedPairingPayload | null {
  const t = text.trim();
  if (!t.startsWith("im://pair")) return null;
  const q = t.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(t.slice(q + 1));
  const u = params.get("u");
  const c = params.get("c");
  if (!u || !c) return null;
  return { publicUrl: decodeURIComponent(u), code: decodeURIComponent(c) };
}
