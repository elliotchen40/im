/**
 * P14 — /soul 命令状态机 + 原子写入 .env
 *
 * 流程：
 *   用户发 /soul → enterWait(fromUser) → 列候选 + 10s 等待
 *   10s 内用户发序号 ("1") 或角色名 ("ASHLEY") → tryHandleSelection
 *     匹配 → atomicWriteEnvSoulPath(newPath) → 返回 "已切换到 NAME"
 *   超时 → 清状态
 *
 * 文件名过滤：^SOUL_[a-zA-Z0-9_-]+\.md$（不允许 .. 或路径分隔符）
 *
 * .env 写入：先写 .env.tmp 再 rename — 原子写入（POSIX rename 原子）
 * 写入失败要 throw，让 caller 决定怎么处理
 */

import fs from "node:fs";
import path from "node:path";
import { getSoulDir, getSoulSelectTimeoutMs, resolveSoulDir } from "./soul_dir.js";

export interface SoulCandidate {
  /** 角色名（去掉 SOUL_ 前缀和 .md 后缀），大写展示 */
  name: string;
  /** 文件 basename，如 SOUL_ASHLEY.md */
  file: string;
  /** 文件完整绝对路径 */
  fullPath: string;
}

export interface SoulWaitState {
  candidates: SoulCandidate[];
  timer: NodeJS.Timeout;
  startedAt: number;
}

export interface SoulHandshakeDeps {
  /** .env 文件路径，默认 cwd 相对路径 ".env" */
  envPath?: string;
}

const VALID_FILE_RE = /^SOUL_[a-zA-Z0-9_-]+\.md$/;

/**
 * 扫描 SOUL_DIR，过滤 SOUL_*.md 文件名（严格正则防越界）。
 * 返回按文件名字典序排序（让列表稳定）。
 * 接受可选 soulDir 参数（测试可 override；默认读 getSoulDir()）
 */
export function listSoulFiles(soulDir?: string): SoulCandidate[] {
  const dir = soulDir ? path.resolve(soulDir) : resolveSoulDir();
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SoulCandidate[] = [];
  for (const file of entries) {
    if (!VALID_FILE_RE.test(file)) continue;
    const name = file.slice("SOUL_".length, file.length - ".md".length);
    out.push({
      name: name.toUpperCase(),
      file,
      fullPath: path.join(dir, file),
    });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

export class SoulHandshake {
  private waitMap = new Map<string, SoulWaitState>();
  private deps: SoulHandshakeDeps;

  constructor(deps: SoulHandshakeDeps = {}) {
    this.deps = deps;
  }

  /** 测试钩子：暴露 waitMap */
  getWaitMap(): Map<string, SoulWaitState> {
    return this.waitMap;
  }

  hasPending(fromUser: string): boolean {
    return this.waitMap.has(fromUser);
  }

  /**
   * 用户发 /soul → 进入选择状态
   * 返回：
   *   - reply: 给用户的回复（含候选列表 + 等待提示）
   *   - candidates: 当前候选（bot 用以渲染）
   *   - timeoutMs: 超时时长（ms）
   */
  enterWait(fromUser: string, soulDir?: string): { reply: string; candidates: SoulCandidate[]; timeoutMs: number } {
    // 覆盖旧 timer
    const old = this.waitMap.get(fromUser);
    if (old) clearTimeout(old.timer);

    const candidates = listSoulFiles(soulDir);
    const timeoutMs = getSoulSelectTimeoutMs();

    if (candidates.length === 0) {
      // 0 候选 → 直接返回，不进入等待
      return {
        reply: `（暂无可用角色 — ${getSoulDir()} 下没有 SOUL_*.md 文件）`,
        candidates: [],
        timeoutMs,
      };
    }

    const lines: string[] = [`可用角色（${Math.round(timeoutMs / 1000)} 秒内选序号或角色名）:`];
    candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.name}`));
    const reply = lines.join("\n");

    const t = setTimeout(() => {
      this.waitMap.delete(fromUser);
    }, timeoutMs);

    this.waitMap.set(fromUser, {
      candidates,
      timer: t,
      startedAt: Date.now(),
    });

    return { reply, candidates, timeoutMs };
  }

  /**
   * 用户在等待状态内发文本 → 解析 + 匹配 + 改 .env
   * 返回：
   *   - { reply, newPath, candidate }：匹配成功
   *   - { reply }：超时 / 无效 / 错误
   *   - null：用户不在等待状态（caller 继续走主对话路径）
   */
  tryHandleSelection(fromUser: string, text: string):
    | { reply: string; newPath: string; candidate: SoulCandidate }
    | { reply: string }
    | null {
    if (!this.waitMap.has(fromUser)) return null;

    const state = this.waitMap.get(fromUser)!;
    const trimmed = text.trim();

    // 序号匹配
    let matched: SoulCandidate | undefined;
    const num = Number(trimmed);
    if (Number.isInteger(num) && num >= 1 && num <= state.candidates.length) {
      matched = state.candidates[num - 1];
    } else {
      // 角色名匹配（不分大小写）
      const upper = trimmed.toUpperCase();
      matched = state.candidates.find(c => c.name === upper);
    }

    // 清状态（无论匹配成功或失败）
    clearTimeout(state.timer);
    this.waitMap.delete(fromUser);

    if (!matched) {
      return { reply: "请输入有效序号或角色名（已取消本次选择）" };
    }

    // 改 .env（atomic）
    const newPath = path.relative(process.cwd(), matched.fullPath) || matched.fullPath;
    try {
      atomicWriteEnvSoulPath(newPath, this.deps.envPath);
    } catch (err) {
      return {
        reply: `切换失败：${err instanceof Error ? err.message : err}`,
      };
    }

    return { reply: `已切换到 ${matched.name}\n文件：${newPath}`, newPath, candidate: matched };
  }

  /** 清空所有 pending（测试 / shutdown） */
  clearAll(): void {
    for (const s of this.waitMap.values()) clearTimeout(s.timer);
    this.waitMap.clear();
  }
}

/**
 * 原子更新 .env 的 SYSTEM_PROMPT_FILE 行：
 *   - 写 .env.tmp → rename 到 .env（POSIX 原子）
 *   - 保留原文件其他内容、注释、空行
 *   - 如原文件没 SYSTEM_PROMPT_FILE 行 → 追加
 *   - 失败时 throw，不破坏原文件
 *   - 保留原文件权限（如 0o600）
 */
export function atomicWriteEnvSoulPath(newPath: string, envPath: string = ".env"): void {
  const absEnv = path.resolve(envPath);
  if (!fs.existsSync(absEnv)) {
    throw new Error(`.env 文件不存在：${absEnv}`);
  }

  // 备份原 stat
  const origStat = fs.statSync(absEnv);
  const origContent = fs.readFileSync(absEnv, "utf-8");

  const lines = origContent.split(/\r?\n/);
  let replaced = false;
  const newLines = lines.map(line => {
    if (/^SYSTEM_PROMPT_FILE\s*=/.test(line)) {
      replaced = true;
      return `SYSTEM_PROMPT_FILE=${newPath}`;
    }
    return line;
  });
  if (!replaced) {
    newLines.push(`SYSTEM_PROMPT_FILE=${newPath}`);
  }
  // 保留尾部换行
  const newContent = newLines.join("\n");

  // 先写 .env.tmp，再 rename（POSIX 原子）
  const tmpPath = absEnv + ".tmp";
  try {
    fs.writeFileSync(tmpPath, newContent, "utf-8");
    fs.renameSync(tmpPath, absEnv);
    // 恢复权限（如 0o600）
    try {
      fs.chmodSync(absEnv, origStat.mode & 0o777);
    } catch {
      // chmod 失败不致命（无权限改权限时）
    }
  } catch (err) {
    // 清理 tmp
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}