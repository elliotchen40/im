/**
 * P29: D-C-B 优先级触发器
 *
 * 优先级（高 → 低）：
 *   D (mood_event) — 检测到情绪事件（detector 命中）
 *   C (date)       — 用户记忆里近期重要日期（memories.metadata_json.date）
 *   B (idle)       — 4h 无对话
 *
 * 每次 tick 顺序检查 D → C → B，第一个触发就停。
 */

import type { MemoryDB } from "../memory/db.js";
import type { CareEvent } from "./detector.js";

export type TriggerType = "mood_event" | "date" | "idle";

export interface TriggerResult {
  triggered: boolean;
  triggerType?: TriggerType;
  event?: CareEvent;
  reason?: string;
}

const IDLE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

/** D 优先：mood_event（来自 detector） */
export function tryMoodEvent(event: CareEvent | null): TriggerResult {
  if (!event) return { triggered: false, reason: "D: detector returned null" };
  if (!event.hasEvent) return { triggered: false, reason: "D: no event" };
  if ((event.severity ?? 0) < 3) {
    return { triggered: false, reason: `D: severity ${event.severity} < 3` };
  }
  return { triggered: true, triggerType: "mood_event", event };
}

/** C 次优：date — 检查 memories 里近期 7 天的日期事件 */
export function tryDateEvent(db: MemoryDB, userId: number): TriggerResult {
  const now = Date.now();
  const in7Days = now + 7 * 24 * 60 * 60 * 1000;
  // P29 简化：扫所有 memories，metadata_json 含 "date" 字段且在 [now, in7Days] 范围内
  const memories = db.allMemoriesForUser(userId);
  for (const m of memories) {
    const meta = (m as any).metadataJson;
    if (!meta) continue;
    try {
      const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
      const date = parsed?.date;
      if (typeof date !== "number") continue;
      if (date >= now && date <= in7Days) {
        return {
          triggered: true,
          triggerType: "date",
          event: {
            hasEvent: true,
            eventType: "date",
            eventSummary: `${parsed.label ?? "重要日期"} 在 ${new Date(date).toLocaleDateString()}`,
            severity: 4,
            contextSnippet: parsed.note ?? "",
          },
        };
      }
    } catch {
      continue;
    }
  }
  return { triggered: false, reason: "C: no upcoming date" };
}

/** B 最后：idle 4h+ 无对话 */
export function tryIdle(db: MemoryDB, userId: number): TriggerResult {
  const last = db.lastDialogueTime(userId);
  if (!last) return { triggered: false, reason: "B: no dialogue history" };
  const since = Date.now() - last;
  if (since < IDLE_THRESHOLD_MS) {
    return { triggered: false, reason: `B: last dialogue ${Math.round(since / 60000)}min ago < 4h` };
  }
  return {
    triggered: true,
    triggerType: "idle",
    event: {
      hasEvent: true,
      eventType: "work" as any, // 'work' 不是 idle，但 P29 简化复用（detector eventType 枚举不含 idle）
      eventSummary: `用户 idle 超过 4h（${Math.round(since / 60000)}min）`,
      severity: 2, // idle 优先级低
    },
  };
}
