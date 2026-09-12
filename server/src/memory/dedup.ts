/**
 * 去重工具 (P8)
 *
 * 提供：
 *   - cosine(a, b)：归一化向量的 cosine（已 L2 归一化时等价于 dot product）
 *   - findSimilar<T>(items, target, threshold)：在 items 中找出与 target 相似度 > threshold 的元素
 *   - dedupeByCosine<T>(scoredItems, threshold)：组内去重，按 score 降序遍历，保留首个出现的；
 *                                                   后出现的若与已保留元素相似度 > threshold 则丢弃。
 *
 * 阈值默认 0.85，沿用 P8 要求。
 */

export const DEFAULT_DEDUP_THRESHOLD = Number(process.env.DEDUP_THRESHOLD ?? 0.85);

/**
 * Cosine similarity。假设两向量已 L2 归一化（embed.ts 里所有输出都归一化），可直接点积。
 * 长度不一致时按短边计算（容错）。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface Scored<T> {
  row: T;
  score: number;
  embedding: Float32Array;
}

/**
 * 在 candidates 中找出与 target 相似度 > threshold 的元素（按 score 降序）。
 * 用于 summarize 写 memory 前：embed 新 fact → 在 user 已有 memories 中找 > 0.85 的 → 跳过。
 */
export function findSimilar<T>(
  candidates: Array<{ row: T; embedding: Float32Array }>,
  target: Float32Array,
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): Array<{ row: T; score: number }> {
  const out: Array<{ row: T; score: number }> = [];
  for (const c of candidates) {
    const s = cosine(c.embedding, target);
    if (s > threshold) out.push({ row: c.row, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 组内去重：按 score 降序遍历，保留首个；后出现的若与已保留的某元素相似度 > threshold 则丢弃。
 *
 * 输入必须已按 score DESC 排好序（retrieve.ts 内部就这么排的）。
 * 用于 retrieve 返回前：对 summaries 命中、memories 命中分别做组内去重，保留每个 topic 最高分那条。
 */
export function dedupeByCosine<T>(
  items: Scored<T>[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): Scored<T>[] {
  const kept: Scored<T>[] = [];
  for (const item of items) {
    let dup = false;
    for (const k of kept) {
      if (cosine(item.embedding, k.embedding) > threshold) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(item);
  }
  return kept;
}

/** 把 BLOB 转 Float32Array（与 db.ts blobToEmbedding 行为一致，本地副本以免循环依赖） */
export function blobToFloat32(buf: Buffer | Uint8Array): Float32Array {
  const view = buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
  // 用 ArrayBuffer 拷一份以避免 Buffer 内存对齐与 Float32Array 不一致
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return new Float32Array(ab);
}