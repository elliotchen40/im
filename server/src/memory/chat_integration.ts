/**
 * v2 chat 入口 — 把 AIChat + retrieval + summarizer 拼装为带记忆的对话
 *
 * 消息拼装顺序（memory_design.md §四）:
 *   [system + SOUL] → Top-5 summaries → Top-5 memories → Top-10 dialogues (fallback) → 最近 20 条原文 → user
 *
 * history 恢复：daemon 重启时 AIChat.sessions 为空；
 * loadHistoryFromDB(userId, sessionId, db) 拉最近 SHORT_TERM_WINDOW_SIZE 条，按 ASC 推入内存 session。
 */

import type { AIChat, ImagePart } from "../ai/chat.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
} from "openai/resources/chat/completions.js";
import type { MemoryDB } from "./db.js";
import type { EmbeddingClient } from "./embed.js";
import { retrieve, type RetrievalOutput } from "./retrieve.js";
import type { Summarizer } from "./summarize.js";

const SHORT_TERM_WINDOW = Number(process.env.SHORT_TERM_WINDOW_SIZE ?? 20);

export interface V2ChatDeps {
  ai: AIChat;
  db: MemoryDB;
  embed: EmbeddingClient;
  summarizer: Summarizer;
  /** 当前 user 的内部 numeric id + session id（由 caller 解析） */
  resolveSession: (wechatUserId: string) => { userId: number; sessionId: number } | null;
}

/** daemon 启动 / 首次收到 user 消息时调一次，把 DB 最近 20 条塞回内存 session */
export function loadHistoryFromDB(
  ai: AIChat,
  wechatUserId: string,
  userId: number,
  sessionId: number,
  db: MemoryDB,
): void {
  // 注意：SQL 是 DESC 取最近 N，转 ASC 供 messages 顺序
  const recent = db.recentDialogues(sessionId, SHORT_TERM_WINDOW).reverse();
  const session = ai.getSessionPublic(wechatUserId);
  session.history.length = 0;
  for (const d of recent) {
    if (d.role === "user" || d.role === "assistant" || d.role === "system") {
      session.history.push({ role: d.role, content: d.content });
    }
  }
}

/** v2 主对话入口；bot.handleMessage 在 v2 改调这个 */
export async function v2Chat(
  deps: V2ChatDeps,
  wechatUserId: string,
  userMessage: string,
  images?: ImagePart[],
): Promise<string> {
  const session = deps.resolveSession(wechatUserId);
  if (!session) {
    throw new Error(`[v2Chat] cannot resolve session for ${wechatUserId}`);
  }
  const { userId, sessionId } = session;

  // 1. embed 查询
  const queryEmb = (await deps.embed.embed([userMessage]))[0];

  // 2. 检索 (summaries + memories + fallback dialogues)
  const retr: RetrievalOutput = await retrieve({
    queryEmbedding: queryEmb,
    userId, sessionId,
    db: deps.db,
    embed: deps.embed,
  });

  // 3. 拼 messages
  const messages: ChatCompletionMessageParam[] = [];

  // system（v2: AIChat 已在构造时加载 SOUL.md / SYSTEM_PROMPT_FILE）
  // 顶部追加 EVIDENCE_GRADE_NOTICE（让 LLM 优先看到证据等级概念），然后是 basePrompt
  //   → 检索结果摘要 → [基于推断] memory 注入 → shortTerm history → user 消息
  const retrievalHeader = formatRetrievalHeader(retr);
  const basePrompt = deps.ai.getSystemPrompt();
  const sysContent = EVIDENCE_GRADE_NOTICE + "\n\n" + basePrompt +
    (retrievalHeader ? "\n\n[Memory Retrieval]\n" + retrievalHeader : "") +
    PAST_EVENT_VERIFICATION_RULE;
  messages.push({ role: "system", content: sysContent });

  // summaries
  for (const s of retr.summaries) {
    messages.push({ role: "system", content: `[Past Summary] ${s.row.summaryText}` });
  }
  // memories — P2: 无 evidence 的 memory 加 `[基于推断]` 前缀
  for (const m of retr.memories) {
    const prefix = hasEvidence(m.row.evidence) ? "" : "[基于推断] ";
    messages.push({ role: "system", content: `[Memory:${m.row.memoryType}] ${prefix}${m.row.fact}` });
  }
  // fallback dialogues：retrieveDialogues 已按 created_at ASC 返回，直接用即可
  for (const d of retr.dialogues) {
    messages.push({ role: d.row.role as any, content: d.row.content });
  }

  // 4. 短期窗口（AIChat 内存 session 已有；通过 getSessionPublic 拿 history）
  const memSessionForShort = deps.ai.getSessionPublic(wechatUserId);
  const shortTerm = memSessionForShort.history.slice(-SHORT_TERM_WINDOW);
  for (const m of shortTerm) {
    messages.push(m);
  }

  // 5. 当前 user 消息（多模态）
  const hasImages = !!images && images.length > 0;
  if (hasImages) {
    const content: ChatCompletionContentPart[] = [
      { type: "text", text: userMessage || "请看图片" },
      ...images!.map(img => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mimeType};base64,${img.data.toString("base64")}` },
      })),
    ];
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  // 6. 调 LLM（直接通过 AIChat 的 client，绕过它自带的 history 组装）
  const client = deps.ai.getClient();
  const current = deps.ai.getCurrentModel();
  const completion = await client.chat.completions.create({
    model: current.model,
    messages,
    thinking: { type: "disabled" },
  } as any);
  const rawReply = completion.choices[0]?.message?.content || "";
  const reply = rawReply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || "（AI 未返回内容）";

  // 7. 写 dialogues（用户 + assistant 双写，永久落盘）
  deps.db.insertDialogue({
    sessionId, userId, role: "user", content: userMessage,
    externalMsgId: undefined,
  });
  deps.db.insertDialogue({
    sessionId, userId, role: "assistant", content: reply,
  });

  // 8. AIChat 内存 session 同步（保持 /status 看到当前上下文）
  const memSession = deps.ai.getSessionPublic(wechatUserId);
  memSession.history.push({ role: "user", content: userMessage });
  memSession.history.push({ role: "assistant", content: reply });

  // 9. 触发 summarizer 检查（空闲 + 硬性）
  deps.summarizer.scheduleIdleFlush(sessionId, userId);
  deps.summarizer.maybeHardTrigger(sessionId, userId);

  return reply;
}

function formatRetrievalHeader(retr: RetrievalOutput): string {
  const parts: string[] = [];
  if (retr.summaries.length) parts.push(`summaries=${retr.summaries.length}`);
  if (retr.memories.length) parts.push(`memories=${retr.memories.length}`);
  if (retr.fallbackUsed) parts.push(`dialogues=${retr.dialogues.length} (fallback)`);
  // P2: hallu-fix — 输出有/无 evidence 比例（让 LLM 知道本次召回的可信度）
  if (retr.evidenceWeightedCount) {
    const { withEvidence, withoutEvidence } = retr.evidenceWeightedCount;
    if (withEvidence + withoutEvidence > 0) {
      parts.push(`evidence=${withEvidence}/${withEvidence + withoutEvidence}`);
    }
  }
  return parts.join(", ");
}

/** P2: hallu-fix — 引用过去事件时若细节无依据，必须标注 [基于推断] 或改模糊表述 */
const PAST_EVENT_VERIFICATION_RULE = `

【引用过去事件规则 · P2 hallu-fix】
如果你提到"上次""那天""之前""我们"等过去时态的具体场景细节（地点、物件、动作），
必须确认该细节有 user 原始对话依据：
- 若系统已注入 [基于推断] 前缀的 memory：
  · **不能**把它当作真实发生的事实来扩展或描写任何具体细节（颜色、材质、动作、对话台词等都不行）。
  · **只能**复述它的概括含义，并用模糊语气（如"我好像记得你提过那条裙子""印象里好像是这样"）。
  · 例外：如果 user 在本轮新消息里亲口确认了该细节（例如"对，就是墨绿色那条"）→ 可以把它当 user 当前事实处理。
- 若系统没注入该 memory、纯靠自己前几轮编出来的场景细节 → 立刻停止，改用"我有点印象但不太确定…"等安全说法。
- 不允许基于你自己前几轮编出来的场景继续扩写细节。`;

/** P2: hallu-fix — 在 system 顶部的证据等级说明，让 LLM 在调用任何细节前先看 evidence 来源 */
const EVIDENCE_GRADE_NOTICE = `【证据等级 · P2 hallu-fix · 优先级最高】
本次对话注入的 memory/summary 来自你的长期记忆库，每条都标注了证据强度：
- **有 evidence 的**（无 [基于推断] 前缀）= 该事实有 user 原始对话可引用 → 可作为真实历史细节扩展描写。
- **[基于推断] 的**（带 [基于推断] 前缀）= 该事实是从过去对话推断或补全的、缺乏明确 user 原话依据 → **不可**当作真实发生的事实来描写任何具体场景细节（颜色、物品、动作、台词、场景等），只能用模糊语气复述其含义。
调用任何具体场景细节前，先看该条 memory 是否带 [基于推断] 前缀；带前缀的只能复述概括含义，绝不扩写。`;

/** P2: 检测 evidence 是否存在 */
function hasEvidence(evidenceJson: string | null): boolean {
  if (!evidenceJson) return false;
  try {
    const arr = JSON.parse(evidenceJson);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}
