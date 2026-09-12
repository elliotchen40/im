/**
 * P30: 主动关怀 dialogue 写入器
 *
 * 把主动消息写到 soulDb.dialogues：
 *   - role='assistant'（保持 CHECK 约束 user/assistant/system）
 *   - initiator='assistant_initiated'（P30 新加列，区分被动响应 vs 主动发起）
 *
 * 与 P29 区别：P29 只在 content 前缀加 `[proactive/TRIGGER]` 标记；P30 用 schema 列。
 * ALTER 兼容老 DB：db.ts init 阶段已自动加 initiator 列（见 db.ts raw.exec(schema) 之后）。
 */

import type { MemoryDB } from "../memory/db.js";

export interface CareDialogueInput {
  soulDb: MemoryDB;
  userId: number;
  content: string;
  triggerType: string;
}

/** 写一条主动关怀 dialogue（role=assistant, initiator=assistant_initiated） */
export function writeCareDialogue(input: CareDialogueInput): number {
  const { soulDb, userId, content, triggerType } = input;
  // 取 active session，没有就开新
  let sid = soulDb.getActiveSession(userId);
  if (sid === null) {
    sid = soulDb.openSession(userId);
  }
  const now = Date.now();
  // 直接用 raw.prepare INSERT（带 initiator 列），不调 soulDb.insertDialogue（后者不带 initiator）
  try {
    const r = soulDb.raw.prepare(
      "INSERT INTO dialogues (user_id, session_id, channel, role, content, created_at, created_date, initiator) VALUES (?, ?, 'wechat', 'assistant', ?, ?, ?, 'assistant_initiated')"
    ).run(userId, sid, content, now, new Date(now).toISOString().slice(0, 10));
    return Number(r.lastInsertRowid);
  } catch (err) {
    // 老 DB 没 initiator 列（极端情况：db.ts ALTER 失败），fallback 到 insertDialogue（不带 initiator）
    console.warn(`[care/dialogue_writer] 写 initiator 失败（fallback 无 initiator）: ${err instanceof Error ? err.message : err}`);
    const tagged = `[proactive/${triggerType}] ${content}`;
    return soulDb.insertDialogue({
      sessionId: sid,
      userId,
      role: "assistant",
      content: tagged,
    });
  }
}
