/**
 * P29: 单线程 care scheduler（在 Bot.start() 主循环长轮询结束后跑一次）
 *
 * 流程：
 *   0. 全局跳过（quiet hours / permanently disabled）
 *   0.5 频控（24h 内已主动过）
 *   D 优先：mood_event
 *   C 次优：date
 *   B 最后：idle 4h
 *
 * 单次 tick 不入新进程，单线程。Bot 主循环 await runCareTick(deps)。
 */

import type { MemoryDB } from "../memory/db.js";
import type { CareGuard } from "./guard.js";
import type { DetectorFn, CareEvent } from "./detector.js";
import type { GeneratorFn } from "./generator.js";
import { tryMoodEvent, tryDateEvent, tryIdle } from "./trigger.js";
import { hashSignature } from "./guard.js";
import { writeCareDialogue } from "./dialogue_writer.js";

export interface CareSchedulerDeps {
  lisaDb: MemoryDB;           // 总是 LISA DB（主动消息来源 SOUL）
  sharedDb: MemoryDB;
  guard: CareGuard;
  detector: DetectorFn;
  generator: GeneratorFn;
  /** 切到 LISA 的回调（Bot.swapSoulDb 包装；如已在 LISA 则 no-op） */
  onSwitchToLisa: () => Promise<void>;
  /** 发消息回调（Bot.sendTextMessage 包装） */
  onSendMessage: (wechatUserId: string, message: string) => Promise<void>;
  wechatUserId: string;       // 单用户场景：当前 ASHLEY 用户
  userId: number;             // sharedDb.upsertUser(wechatUserId) 的 internal id
  /** P30: 真 generator 需要 ai + embed + model + SOUL prompt */
  generatorDeps?: {
    ai: import("../ai/chat.js").AIChat;
    embed: import("../memory/embed.js").EmbeddingClient;
    modelName: string;
    soulPrompt: string;
  };
  /** P31: 把主动消息 push 到 memSession.history（让后续 user 回复时 LLM 能看到自己刚才的问候） */
  ai?: import("../ai/chat.js").AIChat;
}

export interface CareTickResult {
  triggered: boolean;
  triggerType?: 'mood_event' | 'date' | 'idle';
  eventSummary?: string;
  reason?: string;
}

/** 单次 tick：检查 D-C-B，按优先级 */
export async function runCareTick(deps: CareSchedulerDeps): Promise<CareTickResult> {
  const { lisaDb, guard, detector, generator, onSwitchToLisa, onSendMessage, wechatUserId, userId } = deps;

  // 0. 全局跳过
  if (guard.isQuietHours()) return { triggered: false, reason: "quiet_hours" };
  if (guard.isPermanentlyDisabled(userId)) return { triggered: false, reason: "permanently_disabled" };

  // 0.5 频控
  if (guard.isWithinDailyLimit(userId)) return { triggered: false, reason: "daily_limit" };

  // D 优先：mood_event
  const event = await detector(lisaDb, userId);
  const dResult = tryMoodEvent(event);
  if (dResult.triggered && dResult.event) {
    return await fireCare(deps, dResult.event, 'mood_event');
  }

  // C 次优：date
  const cResult = tryDateEvent(lisaDb, userId);
  if (cResult.triggered && cResult.event) {
    return await fireCare(deps, cResult.event, 'date');
  }

  // B 最后：idle
  const bResult = tryIdle(lisaDb, userId);
  if (bResult.triggered && bResult.event) {
    return await fireCare(deps, bResult.event, 'idle');
  }

  return { triggered: false, reason: `D=${dResult.reason} C=${cResult.reason} B=${bResult.reason}` };
}

/** 触发一次主动消息（切 SOUL → 生成 → 发送 → 写 log + dialogue） */
async function fireCare(
  deps: CareSchedulerDeps,
  event: CareEvent,
  triggerType: 'mood_event' | 'date' | 'idle',
): Promise<CareTickResult> {
  const { lisaDb, sharedDb, guard, generator, generatorDeps, onSwitchToLisa, onSendMessage, wechatUserId, userId } = deps;

  // 7-day dedup
  const signature = hashSignature(event.eventType ?? 'unknown', event.eventSummary ?? '');
  if (guard.isDuplicateEvent(userId, signature)) {
    return { triggered: false, reason: `duplicate_signature ${signature}` };
  }

  // 切到 LISA（如果不在）
  await onSwitchToLisa();

  // 生成消息：P30 真 LLM（如果有 generatorDeps）or P29 stub
  let message: string;
  if (generatorDeps) {
    const { generateCareMessageWithDeps } = await import("./generator.js");
    message = await generateCareMessageWithDeps(generatorDeps, event, lisaDb, userId);
  } else {
    message = await generator(event, lisaDb, userId);
  }

  // 发送（Bot.sendTextMessage 包装）
  await onSendMessage(wechatUserId, message);

  // 写 care_log
  const logId = lisaDb.recordCareLog({
    userId,
    triggerType,
    eventType: event.eventType,
    eventSummary: event.eventSummary,
    eventSignature: signature,
    severity: event.severity,
    messageSent: message,
  });

  // 写 dialogue（assistant role，initiator=assistant_initiated）
  writeCareDialogue({
    soulDb: lisaDb,
    userId,
    content: message,
    triggerType,
  });

  // P31: 同步 push 到 memSession.history，让后续 user 回复时 LLM 能看到自己刚才的主动问候
  // 否则 handleMessage 初始化时 loadHistoryFromDB 只跑一次，care scheduler 后写的 dialogue 进不了内存
  const aiInstance = deps.ai ?? deps.generatorDeps?.ai;
  if (aiInstance) {
    const memSession = aiInstance.getSessionPublic(wechatUserId);
    memSession.history.push({ role: "assistant", content: message });
  }

  return { triggered: true, triggerType, eventSummary: event.eventSummary };
}
