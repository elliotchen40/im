/**
 * SiliconFlow BAAI/bge-m3 embedding 客户端 (DC-11)
 *
 * POST https://api.siliconflow.cn/v1/embeddings
 *  - 默认模型 BAAI/bge-m3, dim=1024
 *  - 批量 embed
 *  - 3 次重试（指数退避 200ms / 400ms / 800ms）
 *  - 缺失 SILICONFLOW_API_KEY → 抛错（任务约束 L-2026-0903-2 占位符不允许）
 */

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "BAAI/bge-m3";
const DEFAULT_DIM = 1024;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * .env.example 里的占位符。Leader 还没填真 key 时会是这个字符串（非空），
 * 不能靠 `!apiKey` 检测，必须显式拦截，否则会带着 Bearer <占位符> 打 SiliconFlow → 401。
 */
export const PLACEHOLDER_KEY = "__FILL_IN_BY_LEADER_AFTER_P7__";

function isMissingOrPlaceholder(key: string | undefined): boolean {
  if (!key) return true;
  return key.trim() === PLACEHOLDER_KEY;
}

export interface EmbeddingClient {
  baseUrl: string;
  model: string;
  dim: number;
  /** 单条或批量，返回长度=输入条数的 Float32Array[]，每个都 L2 归一化 */
  embed(inputs: string[]): Promise<Float32Array[]>;
}

function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

interface SiliconFlowDataItem {
  embedding: number[];
  index: number;
  object: string;
}

interface SiliconFlowResp {
  model: string;
  data: SiliconFlowDataItem[];
  usage?: { prompt_tokens: number; total_tokens: number };
}

export function createEmbeddingClient(opts?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dim?: number;
  fetchImpl?: typeof fetch;
}): EmbeddingClient {
  const apiKey = opts?.apiKey ?? process.env.SILICONFLOW_API_KEY;
  if (isMissingOrPlaceholder(apiKey)) {
    throw new Error(
      `[memory/embed] SILICONFLOW_API_KEY 缺失或仍是占位符 ${PLACEHOLDER_KEY}，` +
      `请 Leader 从真源 ~/.mmx/config.json 复制后填入 .env（不能用占位符，会 401）`
    );
  }
  const baseUrl = opts?.baseUrl ?? process.env.SILICONFLOW_BASE_URL ?? DEFAULT_BASE_URL;
  const model = opts?.model ?? process.env.SILICONFLOW_EMBEDDING_MODEL ?? DEFAULT_MODEL;
  const dim = opts?.dim ?? Number(process.env.SILICONFLOW_EMBEDDING_DIM ?? DEFAULT_DIM);
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;

  async function callOnce(inputs: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SiliconFlow HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json() as SiliconFlowResp;
      if (!Array.isArray(json.data)) {
        throw new Error("SiliconFlow 响应缺 data 数组");
      }
      // 按 index 排序保持与输入顺序一致
      json.data.sort((a, b) => a.index - b.index);
      return json.data.map(d => {
        const arr = new Float32Array(d.embedding);
        return l2Normalize(arr);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl, model, dim,
    async embed(inputs: string[]): Promise<Float32Array[]> {
      if (inputs.length === 0) return [];
      let lastErr: unknown;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          return await callOnce(inputs);
        } catch (err) {
          lastErr = err;
          // 4xx 不重试（除 429）
          const msg = err instanceof Error ? err.message : String(err);
          if (/HTTP 4\d\d(?!29)/.test(msg)) {
            throw err;
          }
          if (attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
          }
        }
      }
      throw new Error(`[memory/embed] ${MAX_RETRIES} 次重试后仍失败: ${lastErr}`);
    },
  };
}
