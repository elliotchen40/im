/**
 * wx-robot 记忆系统 v2 — SQLite 封装
 *
 * 6 张表 (memory_design.md §三)：
 *   users / sessions / dialogues / summaries / memories
 *   + idx_dialogues_session / idx_summaries_user / idx_memories_user_imp / idx_memories_expires
 *
 * 设计决策：
 *   DC-32 独立数据库（不与 wx-robot 业务状态混）
 *   UNIQUE(channel, external_msg_id) 防重投
 *   summaries.embedding / memories.embedding 存 Float32 小端 BLOB
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export const EMBEDDING_DIM = 1024; // BAAI/bge-m3

const DEFAULT_DB_PATH = path.resolve("claude_workspace/data/wx_bot.db");

/** Float32 数组 ↔ BLOB（little-endian）。normalize 不在这里做，由 embed.ts 负责。 */
export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(buf: Buffer): Float32Array {
  // 拷一份以避免 Buffer 内存对齐与 Float32Array 不一致
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

export interface MemoryDB {
  raw: Database.Database;
  close(): void;
  // 高层 helper
  upsertUser(wechatUserId: string): number;
  getActiveSession(userId: number): number | null;
  openSession(userId: number): number;
  closeSession(sessionId: number): void;
  insertDialogue(input: {
    sessionId: number;
    userId: number;
    role: "user" | "assistant" | "system";
    content: string;
    externalMsgId?: string;
    tokens?: number;
    latencyMs?: number;
  }): number;
  recentDialogues(sessionId: number, limit: number): DialogueRow[];
  unsummarizedCount(sessionId: number): number;
  insertSummary(input: {
    sessionId: number;
    userId: number;
    summaryText: string;
    memoryType?: string;
    importance?: number;
    sourceDialogueIds: number[];
    embedding: Float32Array;
    embeddingModel: string;
    /** P2: hallu-fix — reference dialogue ids that support this summary (JSON array) */
    evidence?: number[];
  }): number;
  allSummariesForUser(userId: number): SummaryRow[];
  upsertMemory(input: {
    userId: number;
    memoryType: string;
    fact: string;
    key?: string;
    importance: number;
    embedding: Float32Array;
    embeddingModel: string;
    metadata?: Record<string, unknown>;
    expiresAt?: number;
    /** P2: hallu-fix — reference dialogue ids that support this fact (JSON array) */
    evidence?: number[];
  }): { id: number; inserted: boolean };
  allMemoriesForUser(userId: number): MemoryRow[];
  deleteMemory(userId: number, memoryId: number): boolean;
  updateMemory(userId: number, memoryId: number, patch: { fact?: string; importance?: number }): boolean;
  listActiveSessions(): SessionRow[];
  setSessionSummaryStatus(sessionId: number, status: "pending" | "summarized" | "flushed"): void;
  markDialoguesSummarized(dialogueIds: number[], summaryId: number): void;
  // P29: 主动关怀 helper（per-SOUL DB）
  recentDialoguesByDay(userId: number, daysBack: number): DialogueRow[];
  // P30.5: user 维度最近 N 条（不限 day/session）—— 长程 health 事件窗口
  recentDialoguesByUser(userId: number, limit: number): DialogueRow[];
  // P30.5v1.1.2: user 维度过去 N 天 dialogues（按 created_at 倒序）—— 保证覆盖多天前 health 序列
  recentDialoguesByDays(userId: number, daysBack: number, limit: number): DialogueRow[];
  lastDialogueTime(userId: number): number | null;
  recordCareLog(input: {
    userId: number;
    triggerType: 'mood_event' | 'date' | 'idle';
    eventType?: string;
    eventSummary?: string;
    eventSignature?: string;
    severity?: number;
    messageSent?: string;
  }): number;
  countCareLogInWindow(userId: number, sinceMs: number, triggerType?: string): number;
  countDuplicateSignature(userId: number, signature: string, sinceMs: number): number;
  markCareLogResponded(logId: number, status: 0 | 1 | 2): void;
  getRejectionCount(userId: number): number;
  incrementRejection(userId: number): number;
  resetRejection(userId: number): void;
  setPermanentlyDisabled(userId: number, disabled: boolean): void;
  isPermanentlyDisabled(userId: number): boolean;
}

export interface DialogueRow {
  id: number;
  sessionId: number;
  userId: number;
  channel: string;
  role: string;
  content: string;
  externalMsgId: string | null;
  tokens: number | null;
  latencyMs: number | null;
  relatedSummaryId: number | null;
  createdAt: number;
  createdDate: string;
}

export interface SummaryRow {
  id: number;
  sessionId: number;
  userId: number;
  summaryText: string;
  memoryType: string | null;
  importance: number;
  sourceDialogueIds: string; // JSON
  embedding: Buffer;
  embeddingModel: string;
  createdAt: number;
  /** P2: hallu-fix — JSON array of dialogue ids that support this summary; null = legacy (no evidence) */
  evidence: string | null;
}

export interface MemoryRow {
  id: number;
  userId: number;
  memoryType: string;
  fact: string;
  key: string | null;
  importance: number;
  embedding: Buffer;
  embeddingModel: string;
  referCount: number;
  lastReferAt: number | null;
  metadataJson: string | null;
  createdAt: number;
  expiresAt: number | null;
  /** P2: hallu-fix — JSON array of dialogue ids that support this fact; null = legacy (no evidence) */
  evidence: string | null;
}

export interface SessionRow {
  id: number;
  userId: number;
  channel: string;
  startedAt: number;
  lastActiveAt: number;
  isActive: number;
  summaryStatus: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  wechat_user_id TEXT UNIQUE NOT NULL,
  internal_user_id TEXT,
  display_name TEXT,
  created_at INTEGER, last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'wechat',
  started_at INTEGER, last_active_at INTEGER,
  is_active INTEGER DEFAULT 1,
  summary_status TEXT DEFAULT 'pending'
    CHECK(summary_status IN ('pending','summarized','flushed')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS dialogues (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'wechat',
  role TEXT CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  external_msg_id TEXT,
  tokens INTEGER, latency_ms INTEGER,
  related_summary_id INTEGER,
  created_at INTEGER, created_date TEXT,
  -- P30: 主动发起方（'user' / 'assistant_initiated' / 'assistant_response'）；老 DB 无此列，启动时 ALTER 兼容
  initiator TEXT DEFAULT 'user',
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(related_summary_id) REFERENCES summaries(id) ON DELETE SET NULL,
  UNIQUE(channel, external_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_dialogues_session ON dialogues(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  memory_type TEXT,
  importance INTEGER DEFAULT 5,
  source_dialogue_ids TEXT,
  embedding BLOB,
  embedding_model TEXT DEFAULT 'BAAI/bge-m3',
  created_at INTEGER,
  -- P2: hallu-fix — JSON array of user dialogue_ids supporting this summary; null = legacy
  evidence TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  memory_type TEXT CHECK(memory_type IN (
    'preference','recurring_pattern','milestone',
    'emotional_state','life_event','action_commitment','safety_flag'
  )),
  fact TEXT NOT NULL,
  key TEXT,
  importance INTEGER DEFAULT 5
    CHECK(importance BETWEEN 1 AND 10),
  embedding BLOB,
  embedding_model TEXT DEFAULT 'BAAI/bge-m3',
  refer_count INTEGER DEFAULT 0,
  last_refer_at INTEGER,
  metadata_json TEXT,
  created_at INTEGER, expires_at INTEGER,
  -- P2: hallu-fix — JSON array of user dialogue_ids supporting this fact; null = legacy
  evidence TEXT,
  UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_user_imp ON memories(user_id, importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;

-- P29: care_log 表（per-SOUL DB，存主动关怀事件记录）
CREATE TABLE IF NOT EXISTS care_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  event_type TEXT,
  event_summary TEXT,
  event_signature TEXT,
  severity INTEGER,
  message_sent TEXT,
  user_responded INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_care_log_user_time ON care_log(user_id, triggered_at);
CREATE INDEX IF NOT EXISTS idx_care_log_signature ON care_log(user_id, event_signature, triggered_at);

-- P29: user_state 表（拒收计数 + 永久禁主动开关）
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY,
  rejection_count INTEGER DEFAULT 0,
  permanently_disabled INTEGER DEFAULT 0,
  updated_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`;

const REQUIRED_TABLES = [
  "users", "sessions", "dialogues", "summaries", "memories",
];

/** P15: 共享 DB schema（只 users 表） */
const SHARED_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  wechat_user_id TEXT UNIQUE NOT NULL,
  internal_user_id TEXT,
  display_name TEXT,
  created_at INTEGER, last_seen_at INTEGER
);
`;

/** P15: 每个 SOUL 的 DB schema（含 users 表 — 用于 FK 引用 + 迁移脚本复制；upsertUser 也可独立工作） */
const SOUL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  wechat_user_id TEXT UNIQUE NOT NULL,
  internal_user_id TEXT,
  display_name TEXT,
  created_at INTEGER, last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'wechat',
  started_at INTEGER, last_active_at INTEGER,
  is_active INTEGER DEFAULT 1,
  summary_status TEXT DEFAULT 'pending'
    CHECK(summary_status IN ('pending','summarized','flushed')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS dialogues (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'wechat',
  role TEXT CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  external_msg_id TEXT,
  tokens INTEGER, latency_ms INTEGER,
  related_summary_id INTEGER,
  created_at INTEGER, created_date TEXT,
  -- P30: 主动发起方（'user' / 'assistant_initiated' / 'assistant_response'）；老 DB 无此列，启动时 ALTER 兼容
  initiator TEXT DEFAULT 'user',
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(related_summary_id) REFERENCES summaries(id) ON DELETE SET NULL,
  UNIQUE(channel, external_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_dialogues_session ON dialogues(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  memory_type TEXT,
  importance INTEGER DEFAULT 5,
  source_dialogue_ids TEXT,
  embedding BLOB,
  embedding_model TEXT DEFAULT 'BAAI/bge-m3',
  created_at INTEGER,
  -- P2: hallu-fix — JSON array of user dialogue_ids supporting this summary; null = legacy
  evidence TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  memory_type TEXT CHECK(memory_type IN (
    'preference','recurring_pattern','milestone',
    'emotional_state','life_event','action_commitment','safety_flag'
  )),
  fact TEXT NOT NULL,
  key TEXT,
  importance INTEGER DEFAULT 5
    CHECK(importance BETWEEN 1 AND 10),
  embedding BLOB,
  embedding_model TEXT DEFAULT 'BAAI/bge-m3',
  refer_count INTEGER DEFAULT 0,
  last_refer_at INTEGER,
  metadata_json TEXT,
  created_at INTEGER, expires_at INTEGER,
  -- P2: hallu-fix — JSON array of user dialogue_ids supporting this fact; null = legacy
  evidence TEXT,
  UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_user_imp ON memories(user_id, importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;

-- P29: care_log 表（per-SOUL DB，存主动关怀事件记录）
CREATE TABLE IF NOT EXISTS care_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  event_type TEXT,
  event_summary TEXT,
  event_signature TEXT,
  severity INTEGER,
  message_sent TEXT,
  user_responded INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_care_log_user_time ON care_log(user_id, triggered_at);
CREATE INDEX IF NOT EXISTS idx_care_log_signature ON care_log(user_id, event_signature, triggered_at);

-- P29: user_state 表（拒收计数 + 永久禁主动开关）
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY,
  rejection_count INTEGER DEFAULT 0,
  permanently_disabled INTEGER DEFAULT 0,
  updated_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`;

const SHARED_REQUIRED_TABLES = ["users"];
const SOUL_REQUIRED_TABLES = ["sessions", "dialogues", "summaries", "memories", "care_log", "user_state"];

function tableExists(raw: Database.Database, name: string): boolean {
  try {
    const r = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!r;
  } catch {
    return false;
  }
}

/**
 * 共享 prepared statements（init_shared_db / init_db 都用）
 * users 表的 stmt 必须在 users 表存在的 DB 上 prepare；soul DB 没 users 表时会失败。
 */
function buildStatements(raw: Database.Database) {
  // 探测表是否存在；不存在时不 prepare 该 stmt（避免 SQLITE_ERROR）
  const hasUsers = tableExists(raw, "users");
  const hasSessions = tableExists(raw, "sessions");
  const hasDialogues = tableExists(raw, "dialogues");
  const hasSummaries = tableExists(raw, "summaries");
  const hasMemories = tableExists(raw, "memories");
  const hasCareLog = tableExists(raw, "care_log");
  const hasUserState = tableExists(raw, "user_state");
  return {
    upsertUser: hasUsers ? raw.prepare(`
      INSERT INTO users (wechat_user_id, created_at, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(wechat_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      RETURNING id
    `) : null,
    getActiveSession: hasSessions ? raw.prepare(`
      SELECT id FROM sessions WHERE user_id = ? AND is_active = 1
      ORDER BY last_active_at DESC LIMIT 1
    `) : null,
    openSession: hasSessions ? raw.prepare(`
      INSERT INTO sessions (user_id, channel, started_at, last_active_at, is_active, summary_status)
      VALUES (?, 'wechat', ?, ?, 1, 'pending')
    `) : null,
    closeSession: hasSessions ? raw.prepare(`UPDATE sessions SET is_active = 0 WHERE id = ?`) : null,
    touchSession: hasSessions ? raw.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`) : null,
    insertDialogue: hasDialogues ? raw.prepare(`
      INSERT OR IGNORE INTO dialogues
        (session_id, user_id, channel, role, content, external_msg_id, tokens, latency_ms, created_at, created_date)
      VALUES (?, ?, 'wechat', ?, ?, ?, ?, ?, ?, ?)
    `) : null,
    recentDialogues: hasDialogues ? raw.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId, channel, role, content,
             external_msg_id AS externalMsgId, tokens, latency_ms AS latencyMs,
             related_summary_id AS relatedSummaryId, created_at AS createdAt, created_date AS createdDate
      FROM dialogues WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `) : null,
    unsummarizedCount: hasDialogues ? raw.prepare(`
      SELECT COUNT(*) AS n FROM dialogues
      WHERE session_id = ? AND related_summary_id IS NULL
    `) : null,
    insertSummary: hasSummaries ? raw.prepare(`
      INSERT INTO summaries
        (session_id, user_id, summary_text, memory_type, importance, source_dialogue_ids, embedding, embedding_model, created_at, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `) : null,
    allSummariesForUser: hasSummaries ? raw.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId,
             summary_text AS summaryText, memory_type AS memoryType, importance,
             source_dialogue_ids AS sourceDialogueIds, embedding,
             embedding_model AS embeddingModel, created_at AS createdAt,
             evidence
      FROM summaries WHERE user_id = ?
    `) : null,
    upsertMemoryLookup: hasMemories ? raw.prepare(`SELECT id, importance FROM memories WHERE user_id = ? AND key = ?`) : null,
    updateMemoryImportance: hasMemories ? raw.prepare(`UPDATE memories SET importance = MAX(importance, ?) WHERE id = ?`) : null,
    insertMemory: hasMemories ? raw.prepare(`
      INSERT INTO memories
        (user_id, memory_type, fact, key, importance, embedding, embedding_model,
         refer_count, last_refer_at, metadata_json, created_at, expires_at, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
    `) : null,
    allMemoriesForUser: hasMemories ? raw.prepare(`
      SELECT id, user_id AS userId, memory_type AS memoryType, fact, key, importance,
             embedding, embedding_model AS embeddingModel,
             refer_count AS referCount, last_refer_at AS lastReferAt,
             metadata_json AS metadataJson, created_at AS createdAt, expires_at AS expiresAt,
             evidence
      FROM memories WHERE user_id = ?
      ORDER BY importance DESC, created_at DESC
    `) : null,
    deleteMemory: hasMemories ? raw.prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`) : null,
    updateMemoryFact: hasMemories ? raw.prepare(`UPDATE memories SET fact = ? WHERE id = ? AND user_id = ?`) : null,
    updateMemoryImp: hasMemories ? raw.prepare(`UPDATE memories SET importance = ? WHERE id = ? AND user_id = ?`) : null,
    listActiveSessions: hasSessions ? raw.prepare(`
      SELECT id, user_id AS userId, channel,
             started_at AS startedAt, last_active_at AS lastActiveAt,
             is_active AS isActive, summary_status AS summaryStatus
      FROM sessions WHERE is_active = 1
    `) : null,
    setSessionSummaryStatus: hasSessions ? raw.prepare(`UPDATE sessions SET summary_status = ? WHERE id = ?`) : null,
    markDialoguesSummarized: hasDialogues ? raw.prepare(`
      UPDATE dialogues SET related_summary_id = ?
      WHERE id = (?) -- placeholder, replaced via array
    `) : null,
    // P29: care_log + user_state stmts
    recentDialoguesByUserDay: hasDialogues ? raw.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId, channel, role, content,
             external_msg_id AS externalMsgId, tokens, latency_ms AS latencyMs,
             related_summary_id AS relatedSummaryId, created_at AS createdAt, created_date AS createdDate
      FROM dialogues
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC
    `) : null,
    recentDialoguesByUser: hasDialogues ? raw.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId, channel, role, content,
             external_msg_id AS externalMsgId, tokens, latency_ms AS latencyMs,
             related_summary_id AS relatedSummaryId, created_at AS createdAt, created_date AS createdDate
      FROM dialogues
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `) : null,
    // P30.5v1.1.2: 过去 N 天 dialogues（保证覆盖多天前 health 序列）
    recentDialoguesByDays: hasDialogues ? raw.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId, channel, role, content,
             external_msg_id AS externalMsgId, tokens, latency_ms AS latencyMs,
             related_summary_id AS relatedSummaryId, created_at AS createdAt, created_date AS createdDate
      FROM dialogues
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `) : null,
    lastDialogueTimeForUser: hasDialogues ? raw.prepare(`
      SELECT MAX(created_at) AS t FROM dialogues WHERE user_id = ?
    `) : null,
    insertCareLog: hasCareLog ? raw.prepare(`
      INSERT INTO care_log (user_id, triggered_at, trigger_type, event_type, event_summary, event_signature, severity, message_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `) : null,
    countCareLogInWindow: hasCareLog ? raw.prepare(`
      SELECT COUNT(*) AS n FROM care_log WHERE user_id = ? AND triggered_at >= ?
    `) : null,
    countCareLogInWindowByType: hasCareLog ? raw.prepare(`
      SELECT COUNT(*) AS n FROM care_log WHERE user_id = ? AND triggered_at >= ? AND trigger_type = ?
    `) : null,
    countDuplicateSignature: hasCareLog ? raw.prepare(`
      SELECT COUNT(*) AS n FROM care_log WHERE user_id = ? AND event_signature = ? AND triggered_at >= ?
    `) : null,
    markCareLogResponded: hasCareLog ? raw.prepare(`
      UPDATE care_log SET user_responded = ? WHERE id = ?
    `) : null,
    getUserState: hasUserState ? raw.prepare(`
      SELECT user_id AS userId, rejection_count AS rejectionCount, permanently_disabled AS permanentlyDisabled, updated_at AS updatedAt
      FROM user_state WHERE user_id = ?
    `) : null,
    insertUserState: hasUserState ? raw.prepare(`
      INSERT OR IGNORE INTO user_state (user_id, rejection_count, permanently_disabled, updated_at)
      VALUES (?, 0, 0, ?)
    `) : null,
    incrementRejection: hasUserState ? raw.prepare(`
      UPDATE user_state SET rejection_count = rejection_count + 1, updated_at = ? WHERE user_id = ?
    `) : null,
    resetRejection: hasUserState ? raw.prepare(`
      UPDATE user_state SET rejection_count = 0, updated_at = ? WHERE user_id = ?
    `) : null,
    setPermanentlyDisabled: hasUserState ? raw.prepare(`
      UPDATE user_state SET permanently_disabled = ?, updated_at = ? WHERE user_id = ?
    `) : null,
  };
}

/** P15: 初始化共享 DB（仅 users 表） — 全局用户身份 */
export function init_shared_db(dbPath?: string): MemoryDB {
  const finalPath = dbPath ?? (process.env.WX_BOT_DB_PATH ?? DEFAULT_DB_PATH);
  return buildMemoryDb(finalPath, SHARED_SCHEMA, SHARED_REQUIRED_TABLES, "shared");
}

/** P15: 初始化单个 SOUL 的 DB（sessions/dialogues/summaries/memories） */
export function init_soul_db(soulName: string, dataDir?: string): MemoryDB {
  // soulName 验证 — 防越界
  if (!/^[a-zA-Z0-9_-]+$/.test(soulName)) {
    throw new Error(`[memory/db] init_soul_db: SOUL name "${soulName}" 非法`);
  }
  // 委托 soul_dir.ts 计算路径（避免重复硬编码）
  // 动态 import 避免循环依赖（这里s）
  // 实际：调用者应已验证 soulName 合法，路径由调用方通过 getSoulDbPath 获取
  // 这里接受完整绝对路径以保持函数纯净
  const finalPath = dataDir ?? path.resolve(`./data/soul/wx_bot_${soulName}.db`);
  return buildMemoryDb(finalPath, SOUL_SCHEMA, SOUL_REQUIRED_TABLES, `soul[${soulName}]`);
}

/**
 * P18: 把 shared DB 的 users 复制到 SOUL DB（解决 FK 问题）
 *
 * BLOCKER 1：刚 swapSoulDb 到一个 fresh SOUL DB 时，users 表为空 — 后续 user_id FK 会炸
 * BLOCKER 3：用 IMMEDIATE 事务避免 race（外部 INSERT shared.users 时）
 *
 * 返回补齐的 user 数（0 表示已对齐）
 */
export function ensureUsersInSoulDb(
  sharedDb: MemoryDB,
  soulDb: MemoryDB,
  currentSoul: string,
): number {
  const sharedUsers = sharedDb.raw.prepare("SELECT * FROM users").all() as Array<{
    id: number;
    wechat_user_id: string;
    internal_user_id: string | null;
    display_name: string | null;
    created_at: number | null;
    last_seen_at: number | null;
  }>;
  if (sharedUsers.length === 0) return 0;

  const existingIds = new Set(
    (soulDb.raw.prepare("SELECT id FROM users").all() as Array<{ id: number }>).map(u => u.id),
  );
  const missing = sharedUsers.filter(u => !existingIds.has(u.id));
  if (missing.length === 0) return 0;

  // IMMEDIATE 事务 — 立即获取写锁，避免与外部 INSERT 冲突
  const stmt = soulDb.raw.prepare(
    "INSERT OR IGNORE INTO users (id, wechat_user_id, internal_user_id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  soulDb.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const u of missing) {
      stmt.run(u.id, u.wechat_user_id, u.internal_user_id, u.display_name, u.created_at, u.last_seen_at);
    }
    soulDb.raw.exec("COMMIT");
  } catch (err) {
    try { soulDb.raw.exec("ROLLBACK"); } catch {}
    throw err;
  }
  console.log(`[ensureUsersInSoulDb] ✅ 已补 ${missing.length} users 到 SOUL DB[${currentSoul}]`);
  return missing.length;
}

/**
 * P21 修：补单个 user 到 soulDb（冷启动首条消息路径的兜底）
 *
 * 场景：daemon 全新启动 → sharedDb 是空 → P17 startup selfcheck 跑 ensureUsersInSoulDb
 *       但 shared 空所以 no-op（0 行）。首条消息来时 sharedDb.upsertUser 创建 user_id=N，
 *       但 soulDb.users 里没有 N → soulDb.openSession(N) FK 失败。
 *
 * 修法：resolveSessionInternal 内 upsertUser 后立刻调本函数，把刚 upsert 的 user
 *       同步到 soulDb（IMMEDIATE 事务 + INSERT OR IGNORE 避免并发冲突）。
 *
 * 与 ensureUsersInSoulDb 的区别：本函数只补一个 user，不扫全表；用于"热路径"调用，
 *       必须 O(1)，不能 O(shared_users)。
 */
export function ensureOneUserInSoulDb(
  sharedDb: MemoryDB,
  soulDb: MemoryDB,
  userId: number,
  currentSoul: string,
): boolean {
  // 已存在则 no-op
  const exists = soulDb.raw.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
  if (exists) return false;

  const row = sharedDb.raw.prepare(
    "SELECT id, wechat_user_id, internal_user_id, display_name, created_at, last_seen_at FROM users WHERE id = ?",
  ).get(userId) as {
    id: number;
    wechat_user_id: string;
    internal_user_id: string | null;
    display_name: string | null;
    created_at: number | null;
    last_seen_at: number | null;
  } | undefined;
  if (!row) {
    throw new Error(`[ensureOneUserInSoulDb] sharedDb.users 缺 id=${userId}（不应发生）`);
  }

  // IMMEDIATE 事务 — 立即获取写锁，避免与外部 INSERT 冲突
  soulDb.raw.exec("BEGIN IMMEDIATE");
  try {
    soulDb.raw.prepare(
      "INSERT OR IGNORE INTO users (id, wechat_user_id, internal_user_id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.wechat_user_id, row.internal_user_id, row.display_name, row.created_at, row.last_seen_at);
    soulDb.raw.exec("COMMIT");
  } catch (err) {
    try { soulDb.raw.exec("ROLLBACK"); } catch {}
    throw err;
  }
  console.log(`[ensureOneUserInSoulDb] ✅ 已补 user_id=${userId} 到 SOUL DB[${currentSoul}]`);
  return true;
}

/** 通用 DB 构造器（init_shared_db + init_soul_db 共享） */
function buildMemoryDb(
  dbPath: string,
  schema: string,
  requiredTables: string[],
  label: string,
): MemoryDB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(schema);

  // P30: 兼容老 DB（dialogues 表没有 initiator 列）—— ALTER TABLE 添加
  if (tableExists(raw, "dialogues")) {
    const cols = raw.prepare("PRAGMA table_info(dialogues)").all() as Array<{ name: string }>;
    const hasInitiator = cols.some((c) => c.name === "initiator");
    if (!hasInitiator) {
      try {
        raw.exec("ALTER TABLE dialogues ADD COLUMN initiator TEXT DEFAULT 'user'");
        console.log(`[memory/db] P30: dialogues 表已加 initiator 列（兼容老 DB）`);
      } catch (err) {
        console.warn(`[memory/db] P30 ALTER 失败（可能已存在）: ${err}`);
      }
    }
  }

  // P2: 兼容老 DB（summaries/memories 表没有 evidence 列）—— ALTER TABLE 添加
  for (const t of ["summaries", "memories"] as const) {
    if (tableExists(raw, t)) {
      const cols = raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "evidence")) {
        try {
          raw.exec(`ALTER TABLE ${t} ADD COLUMN evidence TEXT`);
          console.log(`[memory/db] P2: ${t} 表已加 evidence 列（兼容老 DB）`);
        } catch (err) {
          console.warn(`[memory/db] P2 ALTER ${t}.evidence 失败（可能已存在）: ${err}`);
        }
      }
    }
  }

  // schema 校验
  const rows = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
      requiredTables.map(() => "?").join(",") +
    ")"
  ).all(...requiredTables) as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  for (const t of requiredTables) {
    if (!present.has(t)) {
      throw new Error(`[memory/db] init_db(${label}) 后缺少表: ${t}`);
    }
  }

  // shared DB 不需要 memories/sessions/dialogues/summaries stmt（这些表不存在）
  // soul DB 不需要 users 表以外的共享 stmt — 但实际 upsertUser 在 soul DB 用不到（用户身份走 shared）
  // 折中：构造所有 stmt，但 try/catch 缺失表的（因为 prepare 时 SQLite 不报缺失，只有执行时报）
  const stmt = buildStatements(raw);
  const now = () => Date.now();
  const todayStr = () => new Date().toISOString().slice(0, 10);

  /** stmt 缺失（DB 类型不匹配）— throw 明确错误，避免后续 .run 崩在 SQLite 深处 */
  function checkStmt(name: string, s: any): any {
    if (!s) {
      throw new Error(`[memory/db] 操作 ${name} 在当前 DB 上不可用（表缺失）`);
    }
    return s;
  }

  return {
    raw,
    close: () => raw.close(),
    upsertUser(wechatUserId) {
      const t = now();
      const r = checkStmt("upsertUser", stmt.upsertUser).get(wechatUserId, t, t);
      return (r as { id: number }).id;
    },
    getActiveSession(userId) {
      const r = checkStmt("getActiveSession", stmt.getActiveSession).get(userId) as { id: number } | undefined;
      return r ? r.id : null;
    },
    openSession(userId) {
      const t = now();
      const r = checkStmt("openSession", stmt.openSession).run(userId, t, t);
      return Number(r.lastInsertRowid);
    },
    closeSession(sessionId) {
      checkStmt("closeSession", stmt.closeSession).run(sessionId);
    },
    insertDialogue(input) {
      const r = checkStmt("insertDialogue", stmt.insertDialogue).run(
        input.sessionId, input.userId, input.role, input.content,
        input.externalMsgId ?? null, input.tokens ?? null, input.latencyMs ?? null,
        now(), todayStr(),
      );
      checkStmt("touchSession", stmt.touchSession).run(now(), input.sessionId);
      return Number(r.lastInsertRowid);
    },
    recentDialogues(sessionId, limit) {
      return checkStmt("recentDialogues", stmt.recentDialogues).all(sessionId, limit) as DialogueRow[];
    },
    unsummarizedCount(sessionId) {
      const r = checkStmt("unsummarizedCount", stmt.unsummarizedCount).get(sessionId) as { n: number };
      return r.n;
    },
    insertSummary(input) {
      const r = checkStmt("insertSummary", stmt.insertSummary).run(
        input.sessionId, input.userId, input.summaryText,
        input.memoryType ?? null, input.importance ?? 5,
        JSON.stringify(input.sourceDialogueIds),
        embeddingToBlob(input.embedding), input.embeddingModel,
        now(),
        input.evidence ? JSON.stringify(input.evidence) : null,
      );
      return Number(r.lastInsertRowid);
    },
    allSummariesForUser(userId) {
      return checkStmt("allSummariesForUser", stmt.allSummariesForUser).all(userId) as SummaryRow[];
    },
    upsertMemory(input) {
      const meta = input.metadata ? JSON.stringify(input.metadata) : null;
      const evJson = input.evidence ? JSON.stringify(input.evidence) : null;
      if (input.key) {
        const existing = checkStmt("upsertMemoryLookup", stmt.upsertMemoryLookup).get(input.userId, input.key) as { id: number; importance: number } | undefined;
        if (existing) {
          checkStmt("updateMemoryImportance", stmt.updateMemoryImportance).run(input.importance, existing.id);
          return { id: existing.id, inserted: false };
        }
      }
      const r = checkStmt("insertMemory", stmt.insertMemory).run(
        input.userId, input.memoryType, input.fact, input.key ?? null,
        input.importance, embeddingToBlob(input.embedding), input.embeddingModel,
        meta, now(), input.expiresAt ?? null,
        evJson,
      );
      return { id: Number(r.lastInsertRowid), inserted: true };
    },
    allMemoriesForUser(userId) {
      return checkStmt("allMemoriesForUser", stmt.allMemoriesForUser).all(userId) as MemoryRow[];
    },
    deleteMemory(userId, memoryId) {
      const r = checkStmt("deleteMemory", stmt.deleteMemory).run(memoryId, userId);
      return r.changes > 0;
    },
    updateMemory(userId, memoryId, patch) {
      let changes = 0;
      if (patch.fact !== undefined) {
        changes += checkStmt("updateMemoryFact", stmt.updateMemoryFact).run(patch.fact, memoryId, userId).changes;
      }
      if (patch.importance !== undefined) {
        changes += checkStmt("updateMemoryImp", stmt.updateMemoryImp).run(patch.importance, memoryId, userId).changes;
      }
      return changes > 0;
    },
    listActiveSessions() {
      return checkStmt("listActiveSessions", stmt.listActiveSessions).all() as SessionRow[];
    },
    setSessionSummaryStatus(sessionId, status) {
      checkStmt("setSessionSummaryStatus", stmt.setSessionSummaryStatus).run(status, sessionId);
    },
    markDialoguesSummarized(dialogueIds, summaryId) {
      const upd = checkStmt("markDialoguesSummarized", stmt.markDialoguesSummarized);
      const txn = raw.transaction((ids: number[]) => {
        for (const id of ids) upd.run(summaryId, id);
      });
      txn(dialogueIds);
    },
    // === P29: 主动关怀 helper (SOUL buildMemoryDb) ===
    recentDialoguesByDay(userId, daysBack) {
      // daysBack=0 → 今天 00:00 起；daysBack=1 → 昨天 00:00 起
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const sinceMs = startOfDay.getTime() - daysBack * 24 * 60 * 60 * 1000;
      return checkStmt("recentDialoguesByUserDay", stmt.recentDialoguesByUserDay)
        .all(userId, sinceMs) as DialogueRow[];
    },
    recentDialoguesByUser(userId, limit) {
      // P30.5: user 维度最近 N 条 dialogues（不限 session/day），用于 detector 长程窗口
      return checkStmt("recentDialoguesByUser", stmt.recentDialoguesByUser)
        .all(userId, limit) as DialogueRow[];
    },
    recentDialoguesByDays(userId, daysBack, limit) {
      // P30.5v1.1.2: 过去 N 天 dialogues（保证覆盖多天前 health 序列）
      const sinceMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
      return checkStmt("recentDialoguesByDays", stmt.recentDialoguesByDays)
        .all(userId, sinceMs, limit) as DialogueRow[];
    },
    lastDialogueTime(userId) {
      const r = checkStmt("lastDialogueTimeForUser", stmt.lastDialogueTimeForUser)
        .get(userId) as { t: number | null } | undefined;
      return r?.t ?? null;
    },
    recordCareLog(input) {
      const r = checkStmt("insertCareLog", stmt.insertCareLog).run(
        input.userId,
        now(),
        input.triggerType,
        input.eventType ?? null,
        input.eventSummary ?? null,
        input.eventSignature ?? null,
        input.severity ?? null,
        input.messageSent ?? null,
      );
      return Number(r.lastInsertRowid);
    },
    countCareLogInWindow(userId, sinceMs, triggerType) {
      if (triggerType) {
        const r = checkStmt("countCareLogInWindowByType", stmt.countCareLogInWindowByType)
          .get(userId, sinceMs, triggerType) as { n: number };
        return r.n;
      }
      const r = checkStmt("countCareLogInWindow", stmt.countCareLogInWindow)
        .get(userId, sinceMs) as { n: number };
      return r.n;
    },
    countDuplicateSignature(userId, signature, sinceMs) {
      const r = checkStmt("countDuplicateSignature", stmt.countDuplicateSignature)
        .get(userId, signature, sinceMs) as { n: number };
      return r.n;
    },
    markCareLogResponded(logId, status) {
      checkStmt("markCareLogResponded", stmt.markCareLogResponded).run(status, logId);
    },
    getRejectionCount(userId) {
      checkStmt("insertUserState", stmt.insertUserState).run(userId, now());
      const r = checkStmt("getUserState", stmt.getUserState).get(userId) as
        | { rejectionCount: number; permanentlyDisabled: number; updatedAt: number | null }
        | undefined;
      return r?.rejectionCount ?? 0;
    },
    incrementRejection(userId) {
      checkStmt("insertUserState", stmt.insertUserState).run(userId, now());
      checkStmt("incrementRejection", stmt.incrementRejection).run(now(), userId);
      const r = checkStmt("getUserState", stmt.getUserState).get(userId) as
        | { rejectionCount: number } | undefined;
      return r?.rejectionCount ?? 0;
    },
    resetRejection(userId) {
      checkStmt("insertUserState", stmt.insertUserState).run(userId, now());
      checkStmt("resetRejection", stmt.resetRejection).run(now(), userId);
    },
    setPermanentlyDisabled(userId, disabled) {
      checkStmt("insertUserState", stmt.insertUserState).run(userId, now());
      checkStmt("setPermanentlyDisabled", stmt.setPermanentlyDisabled).run(disabled ? 1 : 0, now(), userId);
    },
    isPermanentlyDisabled(userId) {
      checkStmt("insertUserState", stmt.insertUserState).run(userId, now());
      const r = checkStmt("getUserState", stmt.getUserState).get(userId) as
        | { permanentlyDisabled: number } | undefined;
      return (r?.permanentlyDisabled ?? 0) === 1;
    },
  };
}

/**
 * 初始化 DB：建表 + 校验。dbPath 路径可被环境变量 WX_BOT_DB_PATH 覆盖。
 * 父目录不存在则自动 mkdir -p。
 *
 * ⚠️ P15 之后弃用：用 init_shared_db + init_soul_db 替代。
 * 保留是为了 v2_1_dedup 向后兼容（旧的 tests/single-db setup 还在跑）。
 */
export function init_db(dbPath: string = process.env.WX_BOT_DB_PATH ?? DEFAULT_DB_PATH): MemoryDB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);

  // schema 校验：sqlite_master 查到全部 5 张主表（设计文档标题写"6 张表"，实际是 5 张主表 +
  // CREATE INDEX 不算表，索引仅校验存在）
  const rows = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
      REQUIRED_TABLES.map(() => "?").join(",") +
    ")"
  ).all(...REQUIRED_TABLES) as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  for (const t of REQUIRED_TABLES) {
    if (!present.has(t)) {
      throw new Error(`[memory/db] init_db 后缺少表: ${t}`);
    }
  }

  const stmt = buildStatements(raw);

  const now = () => Date.now();
  const todayStr = () => new Date().toISOString().slice(0, 10);

  function checkStmt(name: string, s: any): any {
    if (!s) throw new Error(`[memory/db] 操作 ${name} 在当前 DB 上不可用（表缺失）`);
    return s;
  }

  return {
    raw,
    close: () => raw.close(),
    upsertUser(wechatUserId) {
      const t = now();
      const r = checkStmt("upsertUser", stmt.upsertUser).get(wechatUserId, t, t);
      return (r as { id: number }).id;
    },
    getActiveSession(userId) {
      const r = checkStmt("getActiveSession", stmt.getActiveSession).get(userId) as { id: number } | undefined;
      return r ? r.id : null;
    },
    openSession(userId) {
      const t = now();
      const r = checkStmt("openSession", stmt.openSession).run(userId, t, t);
      return Number(r.lastInsertRowid);
    },
    closeSession(sessionId) {
      checkStmt("closeSession", stmt.closeSession).run(sessionId);
    },
    insertDialogue(input) {
      const r = checkStmt("insertDialogue", stmt.insertDialogue).run(
        input.sessionId, input.userId, input.role, input.content,
        input.externalMsgId ?? null, input.tokens ?? null, input.latencyMs ?? null,
        now(), todayStr(),
      );
      checkStmt("touchSession", stmt.touchSession).run(now(), input.sessionId);
      return Number(r.lastInsertRowid);
    },
    recentDialogues(sessionId, limit) {
      return checkStmt("recentDialogues", stmt.recentDialogues).all(sessionId, limit) as DialogueRow[];
    },
    unsummarizedCount(sessionId) {
      const r = checkStmt("unsummarizedCount", stmt.unsummarizedCount).get(sessionId) as { n: number };
      return r.n;
    },
    insertSummary(input) {
      const r = checkStmt("insertSummary", stmt.insertSummary).run(
        input.sessionId, input.userId, input.summaryText,
        input.memoryType ?? null, input.importance ?? 5,
        JSON.stringify(input.sourceDialogueIds),
        embeddingToBlob(input.embedding), input.embeddingModel,
        now(),
        input.evidence ? JSON.stringify(input.evidence) : null,
      );
      return Number(r.lastInsertRowid);
    },
    allSummariesForUser(userId) {
      return checkStmt("allSummariesForUser", stmt.allSummariesForUser).all(userId) as SummaryRow[];
    },
    upsertMemory(input) {
      const meta = input.metadata ? JSON.stringify(input.metadata) : null;
      const evJson = input.evidence ? JSON.stringify(input.evidence) : null;
      if (input.key) {
        const existing = checkStmt("upsertMemoryLookup", stmt.upsertMemoryLookup).get(input.userId, input.key) as { id: number; importance: number } | undefined;
        if (existing) {
          checkStmt("updateMemoryImportance", stmt.updateMemoryImportance).run(input.importance, existing.id);
          return { id: existing.id, inserted: false };
        }
      }
      const r = checkStmt("insertMemory", stmt.insertMemory).run(
        input.userId, input.memoryType, input.fact, input.key ?? null,
        input.importance, embeddingToBlob(input.embedding), input.embeddingModel,
        meta, now(), input.expiresAt ?? null,
        evJson,
      );
      return { id: Number(r.lastInsertRowid), inserted: true };
    },
    allMemoriesForUser(userId) {
      return checkStmt("allMemoriesForUser", stmt.allMemoriesForUser).all(userId) as MemoryRow[];
    },
    deleteMemory(userId, memoryId) {
      const r = checkStmt("deleteMemory", stmt.deleteMemory).run(memoryId, userId);
      return r.changes > 0;
    },
    updateMemory(userId, memoryId, patch) {
      let changes = 0;
      if (patch.fact !== undefined) {
        changes += checkStmt("updateMemoryFact", stmt.updateMemoryFact).run(patch.fact, memoryId, userId).changes;
      }
      if (patch.importance !== undefined) {
        changes += checkStmt("updateMemoryImp", stmt.updateMemoryImp).run(patch.importance, memoryId, userId).changes;
      }
      return changes > 0;
    },
    listActiveSessions() {
      return checkStmt("listActiveSessions", stmt.listActiveSessions).all() as SessionRow[];
    },
    setSessionSummaryStatus(sessionId, status) {
      checkStmt("setSessionSummaryStatus", stmt.setSessionSummaryStatus).run(status, sessionId);
    },
    markDialoguesSummarized(dialogueIds, summaryId) {
      const upd = checkStmt("markDialoguesSummarized", stmt.markDialoguesSummarized);
      const txn = raw.transaction((ids: number[]) => {
        for (const id of ids) upd.run(summaryId, id);
      });
      txn(dialogueIds);
    },
    // === P29: 主动关怀 helper (legacy init_db — 表缺失, 会 throw 明确错) ===
    recentDialoguesByDay() { throw new Error("[memory/db] P29 recentDialoguesByDay 在 legacy init_db 上不可用（care_log/user_state 表缺失）"); },
    recentDialoguesByUser() { throw new Error("[memory/db] P30.5 recentDialoguesByUser 在 legacy init_db 上不可用"); },
    recentDialoguesByDays() { throw new Error("[memory/db] P30.5v1.1.2 recentDialoguesByDays 在 legacy init_db 上不可用"); },
    lastDialogueTime() { throw new Error("[memory/db] P29 lastDialogueTime 在 legacy init_db 上不可用"); },
    recordCareLog() { throw new Error("[memory/db] P29 recordCareLog 在 legacy init_db 上不可用"); },
    countCareLogInWindow() { throw new Error("[memory/db] P29 countCareLogInWindow 在 legacy init_db 上不可用"); },
    countDuplicateSignature() { throw new Error("[memory/db] P29 countDuplicateSignature 在 legacy init_db 上不可用"); },
    markCareLogResponded() { throw new Error("[memory/db] P29 markCareLogResponded 在 legacy init_db 上不可用"); },
    getRejectionCount() { throw new Error("[memory/db] P29 getRejectionCount 在 legacy init_db 上不可用"); },
    incrementRejection() { throw new Error("[memory/db] P29 incrementRejection 在 legacy init_db 上不可用"); },
    resetRejection() { throw new Error("[memory/db] P29 resetRejection 在 legacy init_db 上不可用"); },
    setPermanentlyDisabled() { throw new Error("[memory/db] P29 setPermanentlyDisabled 在 legacy init_db 上不可用"); },
    isPermanentlyDisabled() { throw new Error("[memory/db] P29 isPermanentlyDisabled 在 legacy init_db 上不可用"); },
  };
}
