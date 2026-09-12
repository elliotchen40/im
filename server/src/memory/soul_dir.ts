/**
 * P14 — SOUL 目录 + 角色选择超时变量化
 * P15 — SOUL_DATA_DIR 隔离 DB
 *
 * SOUL_DIR 默认 ./soul，可被 SOUL_DIR 环境变量覆盖。
 * SOUL_SELECT_TIMEOUT_MS 默认 10000（10 秒）。
 * SOUL_DATA_DIR 默认 ./data/soul（每个 SOUL 一个 wx_bot_<NAME>.db）
 */

import path from "node:path";

const DEFAULT_SOUL_DIR = "./soul";
const DEFAULT_SELECT_TIMEOUT_MS = 10_000;
const DEFAULT_SOUL_DATA_DIR = "./data/soul";

/** SOUL_DIR 每次读 env — 测试可覆盖 */
export function getSoulDir(): string {
  return process.env.SOUL_DIR ?? DEFAULT_SOUL_DIR;
}

/** SOUL_SELECT_TIMEOUT_MS 每次读 env — 必须合法正整数，非法 fallback 默认 + warning */
export function getSoulSelectTimeoutMs(): number {
  const raw = process.env.SOUL_SELECT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SELECT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.warn(
      `[soul_dir] SOUL_SELECT_TIMEOUT_MS=${JSON.stringify(raw)} 非法（必须是正整数 ms），` +
      `fallback 到默认 ${DEFAULT_SELECT_TIMEOUT_MS}ms`,
    );
    return DEFAULT_SELECT_TIMEOUT_MS;
  }
  return n;
}

export function resolveSoulDir(): string {
  return path.resolve(getSoulDir());
}

/** P15 SOUL_DATA_DIR（每个角色一个 DB 的目录）*/
export function getSoulDataDir(): string {
  return process.env.SOUL_DATA_DIR ?? DEFAULT_SOUL_DATA_DIR;
}

export function resolveSoulDataDir(): string {
  return path.resolve(getSoulDataDir());
}

/** 单个角色的 DB 文件绝对路径（严格名字名 + 防越界） */
export function getSoulDbPath(soulName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(soulName)) {
    throw new Error(`[soul_dir] SOUL name "${soulName}" 非法（必须 ^[a-zA-Z0-9_-]+$）`);
  }
  return path.join(resolveSoulDataDir(), `wx_bot_${soulName}.db`);
}

/**
 * P17: 从 .env 的 SYSTEM_PROMPT_FILE 路径解析 SOUL 名
 *   "soul/SOUL_LISA.md" → "LISA"
 *   "./data/soul/SOUL_WRITING.md" → "WRITING"
 *
 * 严格：不匹配 SOUL_<NAME>.md 格式 → 抛错（不静默 fallback）
 * NAME 字符集 `[A-Z0-9_]+`（soul 文件名约定全大写）
 */
export function parseSoulName(promptFile: string): string {
  if (!promptFile || promptFile.trim() === "") {
    throw new Error(`[startup] .env SYSTEM_PROMPT_FILE 为空`);
  }
  const m = /SOUL_([A-Z0-9_]+)\.md$/.exec(promptFile);
  if (!m) {
    throw new Error(
      `[startup] .env SYSTEM_PROMPT_FILE="${promptFile}" 不匹配 SOUL_<NAME>.md 格式（NAME = [A-Z0-9_]+）`,
    );
  }
  return m[1];
}