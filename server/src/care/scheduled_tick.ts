/**
 * 主动关怀调度 tick —— 从 bot.ts 拆出（bot.ts 只保留主循环与消息分发）。
 *
 * 与上游 wx-robot-ilink 的 P30.5 修复保持一致：
 *   - 由独立 `setInterval` 驱动，**不绑长轮询**（用户 24h 不发消息也会跑）
 *   - 4h 最小间隔节流放在 tick **内部**（基于 care_log 最新 triggered_at），
 *     而不是靠 tick 之间的间隔 —— 避免重启后立刻重复触发
 *   - 从未收过消息（无 careChannelUserId）→ 跳过
 *
 * 触发优先级 / 静默 / 频率规则全部在 care/scheduler.ts 与 care/guard.ts 中，
 * 本文件只负责「取依赖 → 调用 → 记日志」。
 */

import fs from "node:fs";
import type { AIChat } from "../ai/chat.js";
import type { MemoryDB } from "../memory/db.js";
import type { EmbeddingClient } from "../memory/embed.js";
import { getSoulDbPath } from "../memory/soul_dir.js";
import type { CareGuard } from "./guard.js";
import { runCareTick } from "./scheduler.js";
import { detectCareEvent } from "./detector.js";
import { generateCareMessage } from "./generator.js";

export interface ScheduledCareTickDeps {
  /** LISA DB（主动关怀专用，不随 swapSoulDb 改变） */
  lisaDb: MemoryDB;
  sharedDb: MemoryDB;
  guard: CareGuard;
  ai: AIChat;
  embed: EmbeddingClient;
  /** 当前渠道用户；null = 还没收到过消息 → 直接跳过 */
  careChannelUserId: string | null;
  /** tick 间隔（ms），同时用作 4h 节流的阈值 */
  careIntervalMs: number;
  /** 命中事件时切到 LISA SOUL（Bot 注入 swapSoulDb + summarizer 重建） */
  onSwitchToLisa: () => Promise<void>;
  /** 发主动消息（Bot 注入 channel.send） */
  onSendMessage: (channelUserId: string, text: string) => Promise<void>;
}

export async function runScheduledCareTick(deps: ScheduledCareTickDeps): Promise<void> {
  const {
    lisaDb, sharedDb, guard, ai, embed,
    careChannelUserId, careIntervalMs,
    onSwitchToLisa, onSendMessage,
  } = deps;

  if (!careChannelUserId) {
    console.log("[bot] care tick: 跳过（无 careChannelUserId，首次 handleMessage 后再 tick）");
    return;
  }

  try {
    // 最小间隔节流（基于 care_log 最新 trigger 时间，避免 hot loop / 重启重复触发）
    const lastTickMs = lisaDb.raw
      .prepare("SELECT MAX(triggered_at) AS t FROM care_log")
      .get() as { t: number | null } | undefined;
    if (lastTickMs && lastTickMs.t) {
      const sinceLast = Date.now() - lastTickMs.t;
      if (sinceLast < careIntervalMs) {
        console.log(`[bot] care tick 跳过：距上次 tick ${Math.round(sinceLast / 60000)}min < ${careIntervalMs / 3600000}h`);
        return;
      }
    }

    const userId = sharedDb.upsertUser(careChannelUserId);

    // 读 SOUL_LISA prompt 注入 generator
    const lisaPromptPath = getSoulDbPath("LISA").replace(/\/wx_bot_LISA\.db$/, "/../../soul/SOUL_LISA.md");
    let soulPrompt = "[SOUL:LISA] 你是一个温柔的、依恋的真人女友。";
    try {
      if (fs.existsSync(lisaPromptPath)) {
        soulPrompt = fs.readFileSync(lisaPromptPath, "utf-8").trim();
      } else if (fs.existsSync("soul/SOUL_LISA.md")) {
        soulPrompt = fs.readFileSync("soul/SOUL_LISA.md", "utf-8").trim();
      }
    } catch (e) {
      console.warn(`[bot] 读 SOUL_LISA prompt 失败（fallback 默认）: ${e}`);
    }

    const result = await runCareTick({
      lisaDb,
      sharedDb,
      guard,
      detector: detectCareEvent,
      generator: generateCareMessage,
      generatorDeps: {
        ai,
        embed,
        modelName: ai.getCurrentModel().model,
        soulPrompt,
      },
      // P31: 让 fireCare 能把主动消息 push 进 memSession.history
      ai,
      onSwitchToLisa,
      onSendMessage,
      wechatUserId: careChannelUserId,
      userId,
    });

    if (result.triggered) {
      console.log(`[bot] care tick triggered: type=${result.triggerType} summary=${result.eventSummary?.slice(0, 60)}`);
    } else {
      console.log(`[bot] care tick skipped: ${result.reason}`);
    }
  } catch (err) {
    console.error(`[bot] care tick 异常（non-fatal）: ${err}`);
  }
}
