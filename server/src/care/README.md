# src/care/ — P29 LISA 主动关怀触发器骨架

> **阶段 1**：数据层 + 调度骨架 + 静默规则全套（mock detector，不调真 LLM）。
> 阶段 2 在 P30：替换 detector 为真 LLM 实现。

## 模块清单

| 文件 | 职责 |
|---|---|
| `trigger.ts` | D-C-B 优先级触发器（D=mood_event, C=date, B=idle） |
| `scheduler.ts` | 单线程 scheduler（Bot.start() 主循环长轮询结束后跑一次） |
| `guard.ts` | 静默规则 + 拒收检测（quiet hours / daily limit / 7-day dedup / 拒收计数） |
| `detector.ts` | 阶段 1 mock（30% 概率返回事件），P30 替换为真 LLM |
| `generator.ts` | 阶段 2 stub（直接返回 mock 消息） |
| `dialogue_writer.ts` | 写 dialogues (role=assistant，消息前缀 `[proactive/TRIGGER]`) |
| `README.md` | 本文件 |

## 流程图

```
Bot.start() 主循环
  ↓
长轮询 getUpdates
  ↓
for msg in resp.msgs → handleMessage(msg)
  ↓
await runCareTick({ lisaDb, sharedDb, guard, detector, generator, ... })
  │
  ├─ 0. quiet_hours? ────────────────→ triggered=false
  ├─ 0. permanently_disabled? ───────→ triggered=false
  ├─ 0.5 daily_limit? ───────────────→ triggered=false
  │
  ├─ D: detector(lisaDb, userId) → hasEvent + severity≥3?
  │   ├─ 7-day dedup? ────────────────→ triggered=false
  │   └─ switchToLisa → generate → send → recordCareLog → writeDialogue
  │
  ├─ C: memories 里 metadata.date 在 [now, now+7d]?
  │   └─ (同 D 触发链)
  │
  └─ B: lastDialogueTime > 4h ago?
      └─ (同 D 触发链)

return CareTickResult
```

## 静默规则（guard）

| 规则 | 阈值 |
|---|---|
| `isQuietHours()` | 02:00-06:00 wall-clock |
| `isWithinDailyLimit(userId)` | 24h 内已主动过 → true |
| `isDuplicateEvent(userId, signature)` | 7 天内同 signature → true |
| `shouldPermanentlyDisable(userId)` | 拒收累计 ≥3 次 → true（永久禁） |

## 拒收检测（handleMessage 内）

```ts
const REJECT_PATTERNS = [/别发(了|吧)?/i, /让我静静/i, /够了/i];
const RESUME_PATTERNS = [/恢复主动通知/i, /可以主动(联系|发消息)?/i];

if (REJECT_PATTERNS.some(p => p.test(msg.text))) {
  this.careGuard.incrementRejection(userId);  // 累计 ≥3 → 永久禁
}
if (RESUME_PATTERNS.some(p => p.test(msg.text))) {
  this.careGuard.resetRejections(userId);  // 用户主动恢复
}
```

## DB 表（P29 新增）

| 表 | 字段 | 用途 |
|---|---|---|
| `care_log` | user_id, triggered_at, trigger_type, event_type, event_summary, event_signature, severity, message_sent, user_responded | 主动消息事件记录 |
| `user_state` | user_id, rejection_count, permanently_disabled, updated_at | 拒收计数 + 永久禁主动开关 |

## P30 待做

- 替换 `detector.ts` 为真 LLM 实现（输入 user 历史 → SiliconFlow embed → similar memories → 调小模型判断）
- 替换 `generator.ts` 为真 LLM 生成（个性化关怀消息）
- dialogue role 扩 CHECK 约束（新增 `assistant_initiated`）
