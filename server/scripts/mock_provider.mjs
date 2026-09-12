#!/usr/bin/env node
/**
 * 本地 mock LLM / embedding provider —— 让端到端闭环在**没有外部 API key** 的情况下也能验证。
 *
 * 提供 OpenAI 兼容端点（供 .env.verify 指向）：
 *   POST /v1/chat/completions   普通对话 → 固定回复（故意带 <think> 块，顺带验证 think 剥离）
 *                               若响应要求 json_object（summarizer / care detector）→ 返回合法 JSON
 *   POST /v1/embeddings         1024 维确定性伪向量（同文本 → 同向量，L2 归一化）
 *   GET  /health
 *
 * 只用于验证链路，不产生任何费用、不访问外网。
 *
 * 用法：
 *   node scripts/mock_provider.mjs          # 默认端口 8899
 *   MOCK_PORT=9000 node scripts/mock_provider.mjs
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8899);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const EMBED_DIM = Number(process.env.MOCK_EMBED_DIM ?? 1024);

/** 确定性伪向量：同文本 → 同向量（FNV-1a 播种 + LCG 序列 + L2 归一化） */
function pseudoEmbedding(text, dim) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    v[i] = (s / 4294967295) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return Array.from(v);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __raw: raw });
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, role: "mock-provider", port: PORT });
  }

  if (req.method !== "POST") {
    return sendJson(res, 404, { error: { message: "not found" } });
  }

  const body = await readBody(req);

  // ---- chat completions -------------------------------------------------
  if (url.pathname.endsWith("/chat/completions")) {
    const wantsJson =
      body?.response_format?.type === "json_object" ||
      JSON.stringify(body?.messages ?? []).includes("JSON") ||
      JSON.stringify(body?.messages ?? []).includes("json");
    const lastUser = Array.isArray(body?.messages)
      ? [...body.messages].reverse().find((m) => m?.role === "user")
      : undefined;
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

    let content;
    if (wantsJson) {
      // summarizer / care detector 期望的结构
      content = JSON.stringify({
        summary: "mock 摘要：用户打了招呼，情绪平稳。",
        facts: [],
        hasEvent: false,
        reason: "mock provider 固定返回",
      });
    } else {
      // 故意带 <think> 块，验证 AIChat 的 think 剥离
      content = `<think>这是 mock 的内部思考</think>收到你的消息：「${userText.slice(0, 40)}」。我是 im 的 mock 回复。`;
    }

    return sendJson(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  }

  // ---- embeddings -------------------------------------------------------
  if (url.pathname.endsWith("/embeddings")) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
    const data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: pseudoEmbedding(String(text), EMBED_DIM),
    }));
    return sendJson(res, 200, {
      object: "list",
      data,
      model: body?.model ?? "BAAI/bge-m3",
      usage: { prompt_tokens: inputs.length * 5, total_tokens: inputs.length * 5 },
    });
  }

  return sendJson(res, 404, { error: { message: `unknown path ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-provider] listening on http://${HOST}:${PORT} (dim=${EMBED_DIM})`);
  console.log(`[mock-provider] 用法：把 .env 的 OPENAI_BASE_URL / SILICONFLOW_BASE_URL 指向 http://${HOST}:${PORT}/v1`);
});
