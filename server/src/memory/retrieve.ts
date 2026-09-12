/**
 * 向量检索 (DC-13/14/18/19)
 *
 *   summaries: Top-K=5, 阈值 0.60
 *   memories:  Top-K=5, 阈值 0.60
 *   fallback:  RAW_DIALOGUE_RETRIEVAL=fallback 时，summaries 命中 < 3 → 检索 dialogues Top-K=10
 *
 * embeddings 已是 L2 归一化（embed.ts），所以 cosine = dot product。
 */

import { blobToEmbedding, type MemoryDB, type SummaryRow, type MemoryRow, type DialogueRow } from "./db.js";
import type { EmbeddingClient } from "./embed.js";
import { dedupeByCosine, type Scored } from "./dedup.js";

const DEFAULT_TOP_K = Number(process.env.TOP_K ?? 5);
const DEFAULT_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD ?? 0.60);
const RAW_FALLBACK_TOP_K = 10;
const RAW_FALLBACK_HIT_THRESHOLD = 3; // summaries 命中 < 3 触发 fallback

export type RawDialogueMode = "off" | "fallback" | "always";

export function getRawDialogueMode(): RawDialogueMode {
  const v = (process.env.RAW_DIALOGUE_RETRIEVAL ?? "fallback").toLowerCase();
  if (v === "off" || v === "fallback" || v === "always") return v;
  return "fallback";
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s; // 已归一化 → 即 cosine
}

export interface ScoredSummary { row: SummaryRow; score: number; }
export interface ScoredMemory  { row: MemoryRow;  score: number; }
export interface ScoredDialogue { row: DialogueRow; score: number; }

export interface RetrievalInput {
  queryEmbedding: Float32Array;
  userId: number;
  sessionId: number;
  db: MemoryDB;
  embed: EmbeddingClient;
  topK?: number;
  threshold?: number;
}

export interface EvidenceWeightedCount {
  withEvidence: number;
  withoutEvidence: number;
}

export interface RetrievalOutput {
  summaries: ScoredSummary[];
  memories: ScoredMemory[];
  dialogues: ScoredDialogue[];
  fallbackUsed: boolean;
  /** P2: hallu-fix — 召回池中有/无 evidence 的条数（summaries + memories 合计） */
  evidenceWeightedCount: EvidenceWeightedCount;
}

/** P2: hallu-fix — parse evidence JSON; null/empty/parse-fail → 无 evidence */
function hasEvidence(evidenceJson: string | null): boolean {
  if (!evidenceJson) return false;
  try {
    const arr = JSON.parse(evidenceJson);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/** P2: hallu-fix — 无 evidence 的 memory/summary score × 0.5 */
const NO_EVIDENCE_SCORE_PENALTY = 0.5;

export async function retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
  const topK = input.topK ?? DEFAULT_TOP_K;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  // P2: 有/无 evidence 分池计数（最终 topK 内 + 全池）
  let withEvidenceCount = 0;
  let withoutEvidenceCount = 0;

  // summaries
  const summaryRows = input.db.allSummariesForUser(input.userId);
  const scoredSummaries: ScoredSummary[] = [];
  for (const row of summaryRows) {
    // P2: 全 pool 计数（threshold 之前累加，反映 user 整体 memory 库的可信度，
    //      不被 threshold/dedup/topK 截断影响）
    if (hasEvidence(row.evidence)) withEvidenceCount++; else withoutEvidenceCount++;
    const emb = blobToEmbedding(row.embedding);
    const s = cosine(input.queryEmbedding, emb);
    if (s < threshold) continue;
    const hasEv = hasEvidence(row.evidence);
    const finalScore = hasEv ? s : s * NO_EVIDENCE_SCORE_PENALTY;
    scoredSummaries.push({ row, score: finalScore });
  }
  scoredSummaries.sort((a, b) => b.score - a.score);
  // P8: 组内去重 — 保留每个 topic 最高分那条；后出现且与已保留 cosine > 0.85 的丢弃
  const dedupedSummaries = dedupeByCosine<SummaryRow>(
    scoredSummaries.map(s => ({ ...s, embedding: blobToEmbedding(s.row.embedding) })),
  );
  const topSummaries = dedupedSummaries.slice(0, topK).map(s => ({ row: s.row, score: s.score }));

  // memories
  const memoryRows = input.db.allMemoriesForUser(input.userId);
  const scoredMemories: ScoredMemory[] = [];
  for (const row of memoryRows) {
    // P2: 全 pool 计数（同 summaries）
    if (hasEvidence(row.evidence)) withEvidenceCount++; else withoutEvidenceCount++;
    const emb = blobToEmbedding(row.embedding);
    const s = cosine(input.queryEmbedding, emb);
    if (s < threshold) continue;
    const hasEv = hasEvidence(row.evidence);
    const finalScore = hasEv ? s : s * NO_EVIDENCE_SCORE_PENALTY;
    scoredMemories.push({ row, score: finalScore });
  }
  scoredMemories.sort((a, b) => b.score - a.score);
  // P8: 组内去重
  const dedupedMemories = dedupeByCosine<MemoryRow>(
    scoredMemories.map(m => ({ ...m, embedding: blobToEmbedding(m.row.embedding) })),
  );
  const topMemories = dedupedMemories.slice(0, topK).map(m => ({ row: m.row, score: m.score }));

  // fallback dialogues
  let dialogues: ScoredDialogue[] = [];
  let fallbackUsed = false;
  const mode = getRawDialogueMode();
  if (mode === "always") {
    dialogues = await retrieveDialogues(input, RAW_FALLBACK_TOP_K, threshold);
    fallbackUsed = true;
  } else if (mode === "fallback" && topSummaries.length < RAW_FALLBACK_HIT_THRESHOLD) {
    dialogues = await retrieveDialogues(input, RAW_FALLBACK_TOP_K, threshold);
    fallbackUsed = true;
  }

  return {
    summaries: topSummaries,
    memories: topMemories,
    dialogues,
    fallbackUsed,
    evidenceWeightedCount: { withEvidence: withEvidenceCount, withoutEvidence: withoutEvidenceCount },
  };
}

async function retrieveDialogues(
  input: RetrievalInput,
  topK: number,
  threshold: number,
): Promise<ScoredDialogue[]> {
  const candidates = input.db.recentDialogues(input.sessionId, 50);
  if (candidates.length === 0) return [];
  const texts = candidates.map(c => c.content);
  const embeddings = await input.embed.embed(texts);
  const scored: ScoredDialogue[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const s = cosine(input.queryEmbedding, embeddings[i]);
    if (s >= threshold) scored.push({ row: candidates[i], score: s });
  }
  // Top-K 选取按 score DESC；返回前**再按 created_at ASC 重排**——注入 LLM 的对话必须按时间顺序
  // （最新消息在后），不然 LLM 看到上下文是反的。verifier P1-2。
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  top.sort((a, b) => a.row.createdAt - b.row.createdAt);
  return top;
}

/** 仅 summaries + memories，不检索 dialogues（/memory search 子命令使用） */
export async function searchAll(input: RetrievalInput): Promise<RetrievalOutput> {
  return retrieve({ ...input });
}
