/**
 * P30: 主动关怀消息生成器（真 LLM 实现）
 *
 * 替换 P29 stub：
 *   1. embed eventSummary → 检索 LISA DB 真实历史（summaries + memories + fallback dialogues）
 *   2. 拼 prompt：SOUL_LISA 人设 + 当前事件 + 整合材料（不直接引用原话）
 *   3. 调 LLM 生成 ≤50 字、温柔亲密、像真人女友的关怀消息
 *
 * 错误吞掉：fallback 返回固定消息，不影响主流程。
 */

import type { MemoryDB } from "../memory/db.js";
import type { AIChat } from "../ai/chat.js";
import type { EmbeddingClient } from "../memory/embed.js";
import { retrieve } from "../memory/retrieve.js";
import type { CareEvent } from "./detector.js";

export type GeneratorFn = (event: CareEvent, db: MemoryDB, userId: number) => Promise<string>;

export interface GeneratorDeps {
  ai: AIChat;
  embed: EmbeddingClient;
  modelName: string;
  /** SOUL_LISA.md 文件路径或 prompt 字符串 */
  soulPrompt: string;
}

const SIMILARITY_THRESHOLD = 0.60; // 与 docs/memory_design.md §十二 一致

/** 真 LLM generator */
export async function generateCareMessageWithDeps(
  deps: GeneratorDeps,
  event: CareEvent,
  db: MemoryDB,
  userId: number,
): Promise<string> {
  const { ai, embed, modelName, soulPrompt } = deps;

  try {
    // 1. embed + retrieve
    const query = event.eventSummary || "关心用户";
    const [queryEmb] = await embed.embed([query]);
    const retr = await retrieve({
      queryEmbedding: queryEmb,
      userId,
      sessionId: 0,
      db,
      embed,
      threshold: SIMILARITY_THRESHOLD,
    });

    const contextParts: string[] = [];
    for (const s of retr.summaries) contextParts.push(`[Summary] ${s.row.summaryText}`);
    for (const m of retr.memories) contextParts.push(`[Memory] ${m.row.fact}`);
    for (const d of retr.dialogues) contextParts.push(`[Dialogue] ${d.row.content}`);

    // 2. 拼 prompt
    const prompt = `${soulPrompt}

【当前情境】
你正在主动关怀用户。检测到以下事件需要关心：
- 事件类型：${event.eventType ?? "unknown"}
- 事件摘要：${event.eventSummary ?? "(无)"}
- 严重度：${event.severity ?? 0}/5
- 支持片段（用于你的理解，不要直接引用）：${event.contextSnippet ?? "(无)"}

【历史整合材料】（用于你的理解，不要直接引用原话）
${contextParts.length > 0 ? contextParts.join("\n") : "(暂无历史)"}

【要求】
1. **绝对不要直接引用**"支持片段"或历史原话
2. 整合 + 软化：用你的理解重新表述，让用户感觉你真的懂
3. 简短（≤50 字）
4. 温柔、亲密、像真人女友的语气
5. 开头不要"你好"/"有什么事吗"（那是用户触发场景）
6. 体现 LISA 人设：依恋、撒娇、想念、主动关心

直接输出关怀消息（一句话）：`;

    const response = await ai.getClient().chat.completions.create({
      model: modelName,
      temperature: 0.8,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    } as any);

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      return "[care] 我想你了";
    }
    return content;
  } catch (err) {
    console.warn(`[care/generator] 真 LLM 调用失败（fallback 固定消息）: ${err instanceof Error ? err.message : err}`);
    return "[care] 我想你了，记得照顾自己";
  }
}

/** P29 stub：保留用于测试 fallback */
export async function generateCareMessage(event: CareEvent, _db: MemoryDB, _userId: number): Promise<string> {
  return `[stub proactive message] event=${event.eventType ?? "unknown"} severity=${event.severity ?? 0} summary=${event.eventSummary ?? "(none)"}`;
}
