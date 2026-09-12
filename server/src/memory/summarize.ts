/**
 * 异步 summarizer (memory_design.md §五 §六)
 *
 * 触发条件 (4 种叠加):
 *   1. 空闲: 5min 无新消息 → 异步
 *   2. 硬性: unsummarized_count ≥ 20 → 异步（每条新消息进来检查）
 *   3. 显式: /new → 同步（必须等完成才能清空）
 *   4. 退出: SIGTERM → flush 所有 active session
 *
 * 输出 schema (DC-20):
 *   {
 *     summary: string,
 *     facts: [{ type, fact, key?, importance(1-10), confidence(0-1) }]
 *   }
 *
 * 6 项门控 (DC-21):
 *   fact ≤ 200 字 / key UNIQUE / importance ∈ [1,10] / 敏感度 / type ∈ 7 种 / confidence ≥ 0.6
 *
 * 异步 worker：
 *   - 触发 1/2/4 fire-and-forget；触发 3 await
 *   - 硬性触发幂等：summarizing 中再次触发被丢弃
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { MemoryDB } from "./db.js";
import type { EmbeddingClient } from "./embed.js";
import type { CurrentModelInfo } from "../ai/chat.js";
import { blobToEmbedding } from "./db.js";
import { findSimilar } from "./dedup.js";

const HARD_TRIGGER = Number(process.env.SUMMARY_HARD_TRIGGER_THRESHOLD ?? 20);
const IDLE_TIMEOUT_MS = Number(process.env.SUMMARY_IDLE_TIMEOUT_MS ?? 300_000);
const FACT_CONFIDENCE_GATE = Number(process.env.FACT_CONFIDENCE_GATE ?? 0.6);
const FACT_MAX_LEN = 200;

const VALID_MEMORY_TYPES = new Set([
  "preference", "recurring_pattern", "milestone",
  "emotional_state", "life_event", "action_commitment",
]);

const SYSTEM_PROMPT = `你是 wx-robot 的摘要 + 事实抽取器。基于对话历史输出 JSON，必须严格遵守 schema：
{
  "summary": "≤ 300 字的对话摘要，客观第三人称",
  "facts": [
    {
      "type": "preference|recurring_pattern|milestone|emotional_state|life_event|action_commitment",
      "fact": "≤ 200 字的具体陈述，主语明确",
      "key": "可选的去重键，建议 'domain.subject' 格式，如 'food.coffee'",
      "importance": 1-10 整数（10 = 核心身份，1 = 闲聊噪音），
      "confidence": 0-1 浮点（仅当你 ≥ 0.6 该事实才值得记忆），
      "evidence_dialogue_id": 整数（**必填**，引用 user 原话所在 dialogue 的 id；只能从下方提供的 [N] 编号里选；assistant 自己的话不算证据）
    }
  ]
}

【证据规则 · P2 hallu-fix】
每条 fact 必须引用至少 1 条 user 原话作为依据：把"用户在第几条说过的原话"对应的 dialogue id 填到 evidence_dialogue_id。
如果一条 fact 无法定位到任何 user 原话（例如纯靠 assistant 自己扩写得出、或纯推断）→ 直接丢弃，不要写入 facts。
证据存在的意义是防止模型把"自己编的场景细节"当真写进 memory；宁可少写，不要写错。

只输出 JSON，不要 markdown 包裹，不要解释。`;

export interface SummarizeInput {
  /** dialogues must include id field for evidence reference */
  dialogues: { id: number; role: string; content: string }[];
}

export interface ExtractedFact {
  type: string;
  fact: string;
  key?: string;
  importance: number;
  confidence: number;
  /** P2: hallu-fix — reference to a user dialogue id; required for write */
  evidence_dialogue_id?: number;
}

export interface SummarizeOutput {
  summary: string;
  facts: ExtractedFact[];
}

export class Summarizer {
  private openai: OpenAI;
  private model: string;
  private db: MemoryDB;
  private embed: EmbeddingClient;
  private summarizing = new Set<number>(); // sessionIds in flight
  private idleTimers = new Map<number, NodeJS.Timeout>();

  constructor(opts: {
    openai: OpenAI;
    currentModel: CurrentModelInfo;
    db: MemoryDB;
    embed: EmbeddingClient;
  }) {
    this.openai = opts.openai;
    this.model = opts.currentModel.model;
    this.db = opts.db;
    this.embed = opts.embed;
  }

  /** 切换模型（/model / /new）后让 summarizer 用新 client */
  setModel(client: OpenAI, model: string): void {
    this.openai = client;
    this.model = model;
  }

  /** 触发 1: 空闲（每条消息后调） — 重置 timer，超时则异步 flush */
  scheduleIdleFlush(sessionId: number, userId: number): void {
    const old = this.idleTimers.get(sessionId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      void this.flushSessionAsync(sessionId, userId, "idle");
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(sessionId, t);
  }

  cancelIdle(sessionId: number): void {
    const t = this.idleTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.idleTimers.delete(sessionId);
  }

  /** 触发 2: 硬性 — 异步，幂等 */
  maybeHardTrigger(sessionId: number, userId: number): void {
    if (this.summarizing.has(sessionId)) return;
    if (this.db.unsummarizedCount(sessionId) < HARD_TRIGGER) return;
    void this.flushSessionAsync(sessionId, userId, "hard");
  }

  /** 触发 3: /new 同步 flush */
  async flushSessionSync(sessionId: number, userId: number): Promise<void> {
    this.cancelIdle(sessionId);
    await this.flushSession(sessionId, userId, "explicit");
  }

  /** 触发 4: SIGTERM — flush 所有 active session */
  async flushAllActiveSessions(): Promise<void> {
    const sessions = this.db.listActiveSessions();
    await Promise.all(sessions.map(s =>
      this.flushSession(s.id, s.userId, "shutdown").catch(err => {
        console.error(`[summarizer] flush session ${s.id} failed: ${err}`);
      })
    ));
  }

  private async flushSessionAsync(sessionId: number, userId: number, reason: string): Promise<void> {
    if (this.summarizing.has(sessionId)) return;
    this.summarizing.add(sessionId);
    try {
      await this.flushSession(sessionId, userId, reason);
    } catch (err) {
      console.error(`[summarizer] ${reason} flush session ${sessionId} failed: ${err}`);
    } finally {
      this.summarizing.delete(sessionId);
    }
  }

  private async flushSession(sessionId: number, userId: number, reason: string): Promise<void> {
    // 取所有未摘要的 dialogues
    const all = this.db.recentDialogues(sessionId, 1000).reverse();
    const unsum = all.filter(d => d.relatedSummaryId === null);
    if (unsum.length === 0) return;

    // P2: 把 dialogue id 一起给 LLM（LLM 需要引用作为 evidence）
    const input: SummarizeInput = {
      dialogues: unsum.map(d => ({ id: d.id, role: d.role, content: d.content })),
    };
    // P2: 收集 user 的 dialogue ids — 验证 LLM 引用的 evidence_dialogue_id 必须在此集合
    const userDialogueIds = new Set(unsum.filter(d => d.role === "user").map(d => d.id));

    const out = await this.callLLM(input, unsum);
    // P2: evidence 门控 — 没有合法 user evidence 的 fact 丢弃
    const validatedFacts = out.facts
      .map(f => this.gate(f, userDialogueIds))
      .filter((f): f is ExtractedFact => f !== null);
    // P2: 丢弃统计（gate() 返回 null 的总数；不只是 evidence，safety/length 等门控也会触发）
    const droppedCount = out.facts.length - validatedFacts.length;

    if (out.summary.trim().length === 0) return;

    // embed summary + 每个 fact
    const texts = [out.summary, ...validatedFacts.map(f => f.fact)];
    const embeddings = await this.embed.embed(texts);
    const summaryEmb = embeddings[0];
    const factEmbs = embeddings.slice(1);

    // P2: summary 的 evidence = 这次参与的所有 user dialogue ids（保守；保留对话原文即可）
    const summaryEvidence = Array.from(userDialogueIds);
    const summaryId = this.db.insertSummary({
      sessionId, userId,
      summaryText: out.summary,
      memoryType: validatedFacts[0]?.type ?? null,
      importance: validatedFacts.reduce((m, f) => Math.max(m, f.importance), 5),
      sourceDialogueIds: unsum.map(d => d.id),
      embedding: summaryEmb,
      embeddingModel: this.embed.model,
      evidence: summaryEvidence,
    });
    this.db.markDialoguesSummarized(unsum.map(d => d.id), summaryId);
    this.db.setSessionSummaryStatus(sessionId, "summarized");

    // 写 memories（P8: embed 去重 — 与该 user 已有 memory cosine > 0.85 则跳过）
    const existingRows = this.db.allMemoriesForUser(userId);
    const existingEmbeddings = existingRows.map(r => ({
      row: r,
      embedding: blobToEmbedding(r.embedding),
    }));
    for (let i = 0; i < validatedFacts.length; i++) {
      const f = validatedFacts[i];
      try {
        const similar = findSimilar(existingEmbeddings, factEmbs[i]);
        if (similar.length > 0) {
          console.log(
            `[summarizer] skip dup fact: "${f.fact.slice(0, 40)}..." ` +
            `与已有 memory id=${similar[0].row.id} similarity=${similar[0].score.toFixed(3)}`
          );
          continue;
        }
        const result = this.db.upsertMemory({
          userId, memoryType: f.type, fact: f.fact, key: f.key,
          importance: f.importance, embedding: factEmbs[i],
          embeddingModel: this.embed.model,
          evidence: f.evidence_dialogue_id ? [f.evidence_dialogue_id] : undefined,
        });
        // 新插入的也纳入去重集合，避免同批次多条 fact 互相重复
        if (result.inserted) {
          existingEmbeddings.push({
            row: { ...f, id: result.id } as any,
            embedding: factEmbs[i],
          });
        }
      } catch (err) {
        console.error(`[summarizer] upsertMemory failed: ${err}`);
      }
    }
    if (droppedCount > 0) {
      console.log(`[summarizer] gate() 丢弃 ${droppedCount} 条 fact (${out.facts.length} → ${validatedFacts.length}；含 evidence/长度/类型/置信度 等门控)`);
    }
    console.log(`[summarizer] ${reason} session=${sessionId} summary=${summaryId} facts=${validatedFacts.length}`);
  }

  private async callLLM(input: SummarizeInput, unsum: { id: number; role: string; content: string }[]): Promise<SummarizeOutput> {
    // P2: 给每条 dialogue 加 [N] 编号，让 LLM 可以引用作为 evidence_dialogue_id
    const userText =
      "对话历史（每行 [id=N] role: content；id 用于 evidence_dialogue_id 引用）：\n" +
      unsum.map(d => `[id=${d.id}] ${d.role}: ${d.content}`).join("\n");
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ];
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    } as any);
    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed: SummarizeOutput;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 容错：尝试剥离 markdown ```json 包裹
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { summary: "", facts: [] };
    }
    return {
      summary: String(parsed.summary ?? ""),
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    };
  }

  /** 7 项门控（含 P2 evidence 门控）；不通过返回 null */
  private gate(f: ExtractedFact, userDialogueIds?: Set<number>): ExtractedFact | null {
    if (!f || typeof f !== "object") return null;
    if (typeof f.fact !== "string") return null;
    const fact = f.fact.trim();
    if (fact.length === 0) return null;
    if (fact.length > FACT_MAX_LEN) return null; // 截断会改语义，丢弃
    if (typeof f.type !== "string" || !VALID_MEMORY_TYPES.has(f.type)) return null;
    if (typeof f.importance !== "number") return null;
    const importance = Math.max(1, Math.min(10, Math.round(f.importance)));
    if (typeof f.confidence !== "number") return null;
    if (f.confidence < FACT_CONFIDENCE_GATE) return null;
    // P2: evidence 门控 — evidence_dialogue_id 必须指向 user 原话
    if (!f.evidence_dialogue_id || typeof f.evidence_dialogue_id !== "number") return null;
    if (userDialogueIds && !userDialogueIds.has(f.evidence_dialogue_id)) return null;
    return { ...f, fact, importance };
  }
}
