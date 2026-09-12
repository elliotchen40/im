/**
 * 命令与文本格式化 —— 从 bot.ts 拆出的纯逻辑层。
 *
 * 拆分的理由：
 *   1) bot.ts 只留「主循环 + 消息分发」职责，800+ 行的上帝类对维护不友好；
 *   2) 命令实现不依赖 Bot 实例本身，只依赖 memory 层能力（DB / embedding / 会话解析），
 *      因此可以用一个窄接口注入 —— 便于后续单独测试命令行为。
 *
 * 命令语义与上游 wx-robot-ilink 完全一致，见 docs/spec/capability-spec.md §7。
 */

import type { CurrentModelInfo, SessionStats } from "./ai/chat.js";
import type { MemoryDB } from "./memory/db.js";
import type { EmbeddingClient } from "./memory/embed.js";
import { retrieve, type RetrievalOutput } from "./memory/retrieve.js";

interface HelpEntry { usage: string; desc: string; }

const COMMANDS: ReadonlyArray<HelpEntry> = [
  { usage: "/model [name]", desc: "列模型/切换（保留历史）" },
  { usage: "/status",        desc: "当前模型 + 上下文用量 + 消息数" },
  { usage: "/clear",         desc: "清空当前对话（DB 仍保留原文）" },
  { usage: "/new",           desc: "清空上下文 + 重新加载 .env" },
  { usage: "/memory [...]",  desc: "查看/搜索/编辑/删除我的 memories" },
  { usage: "/soul",          desc: "切换 SOUL 角色（10 秒内选序号或角色名）" },
  { usage: "/help",          desc: "显示本帮助" },
];

export function formatHelp(): string {
  const width = COMMANDS.reduce((m, c) => Math.max(m, c.usage.length), 0);
  return COMMANDS.map((c) => `${c.usage.padEnd(width)} - ${c.desc}`).join("\n");
}

function formatNumberWithCommas(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCurrentModelLine(current: CurrentModelInfo): string {
  const where = current.baseURL ? ` @ ${current.baseURL}` : "";
  return `当前模型: ${current.name} (${current.model}${where})`;
}

function formatContextLine(stats: SessionStats | null): string {
  if (!stats) return "会话上下文: 0 / 0 tokens (0.0%)";
  return `会话上下文: ${formatNumberWithCommas(stats.estimatedTokens)} / ${formatNumberWithCommas(stats.contextLimit)} tokens (${stats.contextPercent.toFixed(1)}%)`;
}

function formatMessageLine(stats: SessionStats | null): string {
  if (!stats || stats.messageCount === 0) return "消息数: 0 条";
  return `消息数: ${stats.messageCount} 条 (user ${stats.userMessages} / assistant ${stats.assistantMessages})`;
}

export function formatStatus(
  current: CurrentModelInfo,
  stats: SessionStats | null,
  sessionId: string,
): string {
  const lines: string[] = [
    formatCurrentModelLine(current),
    formatContextLine(stats),
    formatMessageLine(stats),
    `会话ID: ${sessionId}`,
  ];
  if (!stats || stats.messageCount === 0) {
    lines.push("（还没有对话历史，发条消息试试）");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- /memory

/**
 * /memory 命令所需的窄依赖接口 —— 不依赖 Bot 实例，
 * 这样命令逻辑可以脱离 daemon 单独调用（测试 / CLI 复用）。
 */
export interface MemoryCommandDeps {
  soulDb: MemoryDB;
  embed: EmbeddingClient;
  /** 解析渠道用户 → 内部 user_id / session_id（Bot 用 resolveSessionInternal 实现） */
  resolveSession(channelUserId: string): { userId: number; sessionId: number };
}

export async function handleMemoryCommand(
  deps: MemoryCommandDeps,
  fromUser: string,
  rawText: string,
): Promise<string> {
  const trimmed = rawText.trim();
  if (trimmed === "/memory") {
    return await listMemories(deps, fromUser);
  }
  const searchMatch = trimmed.match(/^\/memory\s+search\s+(.+)$/);
  if (searchMatch) {
    return await searchMemories(deps, fromUser, searchMatch[1]);
  }
  const delMatch = trimmed.match(/^\/memory\s+del\s+(\d+)\s*$/);
  if (delMatch) {
    return await delMemory(deps, fromUser, Number(delMatch[1]));
  }
  const editMatch = trimmed.match(/^\/memory\s+edit\s+(\d+)\s+(.+)$/);
  if (editMatch) {
    return await editMemory(deps, fromUser, Number(editMatch[1]), editMatch[2]);
  }
  return "用法: /memory | /memory search <query> | /memory del <id> | /memory edit <id> <new fact>";
}

async function listMemories(deps: MemoryCommandDeps, fromUser: string): Promise<string> {
  const { userId } = deps.resolveSession(fromUser);
  const rows = deps.soulDb.allMemoriesForUser(userId);
  if (rows.length === 0) return "（暂无记忆）";
  const lines = [`记忆数: ${rows.length}`];
  for (const r of rows) {
    lines.push(`#${r.id} [${r.memoryType}] imp=${r.importance} key=${r.key ?? "-"}`);
    lines.push(`  ${r.fact}`);
  }
  return lines.join("\n");
}

async function searchMemories(
  deps: MemoryCommandDeps,
  fromUser: string,
  query: string,
): Promise<string> {
  const { userId, sessionId } = deps.resolveSession(fromUser);
  const [emb] = await deps.embed.embed([query]);
  const out: RetrievalOutput = await retrieve({
    queryEmbedding: emb, userId, sessionId,
    db: deps.soulDb, embed: deps.embed,
  });
  const lines: string[] = [`检索 query: "${query}"`];
  lines.push(`summaries=${out.summaries.length}, memories=${out.memories.length}, fallbackDialogues=${out.dialogues.length}`);
  for (const s of out.summaries) {
    lines.push(`[summary #${s.row.id} score=${s.score.toFixed(3)}] ${s.row.summaryText.slice(0, 100)}`);
  }
  for (const m of out.memories) {
    lines.push(`[memory #${m.row.id} ${m.row.memoryType} score=${m.score.toFixed(3)} imp=${m.row.importance}] ${m.row.fact.slice(0, 100)}`);
  }
  if (out.fallbackUsed) {
    for (const d of out.dialogues) {
      lines.push(`[dialogue #${d.row.id} score=${d.score.toFixed(3)}] ${d.row.content.slice(0, 100)}`);
    }
  }
  return lines.join("\n");
}

async function delMemory(
  deps: MemoryCommandDeps,
  fromUser: string,
  id: number,
): Promise<string> {
  const { userId } = deps.resolveSession(fromUser);
  const ok = deps.soulDb.deleteMemory(userId, id);
  return ok ? `已删除记忆 #${id}` : `记忆 #${id} 不存在`;
}

async function editMemory(
  deps: MemoryCommandDeps,
  fromUser: string,
  id: number,
  newFact: string,
): Promise<string> {
  const { userId } = deps.resolveSession(fromUser);
  const ok = deps.soulDb.updateMemory(userId, id, { fact: newFact.slice(0, 200) });
  return ok ? `已更新记忆 #${id}` : `记忆 #${id} 不存在`;
}
