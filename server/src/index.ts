import { HttpChannel } from "./channel/http_channel.js";
import { AIChat, type ModelConfig } from "./ai/chat.js";
import { Bot } from "./bot.js";
import { loadModels, type ModelsRegistry } from "./ai/config.js";
import { init_db, init_shared_db, init_soul_db, type MemoryDB } from "./memory/db.js";
import { createEmbeddingClient } from "./memory/embed.js";
import { Summarizer } from "./memory/summarize.js";
import { loadHistoryFromDB } from "./memory/chat_integration.js";
import { parseSoulName, getSoulDataDir, resolveSoulDataDir } from "./memory/soul_dir.js";
import fs from "node:fs";
import path from "node:path";

async function loadSystemPromptFromEnv(): Promise<string> {
  let systemPrompt = process.env.SYSTEM_PROMPT ?? "";
  if (process.env.SYSTEM_PROMPT_FILE) {
    try {
      systemPrompt = fs.readFileSync(process.env.SYSTEM_PROMPT_FILE, "utf-8").trim();
      console.log(`[config] 从文件加载系统提示词: ${process.env.SYSTEM_PROMPT_FILE} (${systemPrompt.length} 字符)`);
    } catch (err) {
      console.error(`[config] 读取 ${process.env.SYSTEM_PROMPT_FILE} 失败:`, err);
    }
  }
  return systemPrompt;
}

function readEnvFileIntoProcess(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!key) continue;
    process.env[key] = val;
  }
}

function reloadPromptFromEnv(): string {
  let systemPrompt = process.env.SYSTEM_PROMPT;
  if (process.env.SYSTEM_PROMPT_FILE) {
    try {
      systemPrompt = fs.readFileSync(process.env.SYSTEM_PROMPT_FILE, "utf-8").trim();
    } catch (err) {
      console.error(`[reload] 读取 ${process.env.SYSTEM_PROMPT_FILE} 失败:`, err);
    }
  }
  return systemPrompt ?? "";
}

let STARTUP_ENV_PATH = ".env";

function extractEnvFileFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--env-file=")) {
      const v = a.slice("--env-file=".length).trim();
      return v || null;
    }
    if (a === "--env-file" && i + 1 < argv.length) {
      const v = argv[i + 1].trim();
      return v || null;
    }
  }
  return null;
}

function reloadEnv(): { systemPrompt: string; models: ModelsRegistry } {
  readEnvFileIntoProcess(STARTUP_ENV_PATH);
  const systemPrompt = reloadPromptFromEnv();
  const models = loadModels();
  return { systemPrompt, models };
}

function formatModelList(models: ModelsRegistry): string {
  const lines: string[] = [];
  const defaultEntry = models.byName.get(models.defaultName);
  if (defaultEntry) {
    const c = defaultEntry.config;
    const where = c.baseURL ? ` @ ${c.baseURL}` : "";
    lines.push(`当前默认模型: ${models.defaultName} (${c.model}${where})`);
  } else {
    lines.push(`当前默认模型: ${models.defaultName}`);
  }
  lines.push("可用模型:");
  for (const entry of models.entries) {
    const c = entry.config;
    const where = c.baseURL ? ` @ ${c.baseURL}` : "";
    lines.push(`  · ${entry.name.padEnd(14)} (${c.model}${where})`);
  }
  return lines.join("\n");
}

/**
 * 存储路径兼容层。
 *
 * 上游 wx-robot-ilink 用 `WX_BOT_DB_PATH` 决定 DB 位置；本项目引入
 * `IM_BOT_DB_PATH` 作为首选名，同时保留对上游变量的回落 —— 这样从 wx-robot
 * 迁移过来的既有 DB（含历史会话 / 记忆 / SOUL 数据）可以原样被接管，
 * 不必改一行 memory/ 代码就能复用历史数据。
 */
function resolveStoragePaths(): string {
  const dbPath =
    process.env.IM_BOT_DB_PATH ?? process.env.WX_BOT_DB_PATH ?? "./data/im_bot.db";
  // db.ts / soul_dir.ts 读的是 WX_BOT_DB_PATH，这里统一写回
  process.env.WX_BOT_DB_PATH = dbPath;
  return dbPath;
}

async function main(): Promise<void> {
  if (process.argv.includes("--logout")) {
    console.log(
      "[channel/im] --logout 已废弃：自研 IM 渠道不存在扫码登录态。\n" +
        "  渠道凭证是服务端 `IM_APP_TOKEN`（.env 配置）。如需轮换：\n" +
        "  1) 修改 .env 里的 IM_APP_TOKEN  2) 重启 daemon  3) 同步更新 app 端配置",
    );
    return;
  }

  const argvEnv = extractEnvFileFromArgv(process.argv);
  if (argvEnv) {
    STARTUP_ENV_PATH = argvEnv;
    console.log(`[config] 启动 .env 文件: ${STARTUP_ENV_PATH}`);
  } else {
    console.log(`[config] 启动 .env 文件: ${STARTUP_ENV_PATH} (默认)`);
  }

  // P17: --soul <NAME> 命令行覆盖 .env（测试用）
  const soulIdx = process.argv.indexOf("--soul");
  if (soulIdx !== -1 && process.argv[soulIdx + 1]) {
    const soulName = process.argv[soulIdx + 1];
    process.env.SYSTEM_PROMPT_FILE = `soul/SOUL_${soulName}.md`;
    console.log(`[config] --soul CLI override: SYSTEM_PROMPT_FILE=${process.env.SYSTEM_PROMPT_FILE}`);
  }

  const dbPath = resolveStoragePaths();

  // === 渠道启动（取代原 `await login()` 的微信扫码登录）===
  const channelDataDir =
    process.env.IM_DATA_DIR ?? path.join(path.dirname(dbPath) || ".", "im");
  const channel = new HttpChannel({
    token: process.env.IM_APP_TOKEN ?? "",
    dataDir: channelDataDir,
    port: Number(process.env.IM_HTTP_PORT ?? 8787),
    host: process.env.IM_BIND_HOST ?? "0.0.0.0",
    longPollTimeoutMs: Number(process.env.IM_LONG_POLL_TIMEOUT_MS ?? 35_000),
    defaultUserId: process.env.IM_OWNER_USER_ID ?? "owner",
  });
  await channel.start();

  // === v2 memory init (P15: shared + soul DB; P17: SOUL 从 .env 解析) ===
  const sharedDb: MemoryDB = init_shared_db();
  const promptFile = process.env.SYSTEM_PROMPT_FILE ?? "soul/SOUL_ASHLEY.md";
  const currentSoul = parseSoulName(promptFile);  // 严格匹配，不静默 fallback
  const soulDb: MemoryDB = init_soul_db(currentSoul);
  console.log(`[memory] shared DB + soul DB[${currentSoul}] 已初始化（from ${promptFile}）`);

  // P17: 启动自检 (a) SOUL 文件存在
  if (!fs.existsSync(promptFile)) {
    throw new Error(`[startup] SOUL 文件不存在：${promptFile}`);
  }

  // P17: 启动自检 (c) SOUL md 字符数 > 50（防空白 prompt）
  const soulContent = fs.readFileSync(promptFile, "utf-8");
  if (soulContent.trim().length < 50) {
    throw new Error(`[startup] SOUL 文件太短（${soulContent.trim().length} 字符）：${promptFile}`);
  }

  // P17: 启动自检 (b) SOUL DB 与 shared DB 的 users 表一致 — 缺失自动补
  const sharedUsers = sharedDb.raw.prepare("SELECT id FROM users").all() as Array<{ id: number }>;
  const soulUserIds = new Set(
    (soulDb.raw.prepare("SELECT id FROM users").all() as Array<{ id: number }>).map(u => u.id),
  );
  const missingInSoul = sharedUsers.filter(u => !soulUserIds.has(u.id));
  if (missingInSoul.length > 0) {
    console.warn(
      `[startup] ⚠️ SOUL DB[${currentSoul}] 缺 user_id=${missingInSoul.map(u => u.id).join(",")}，FK 可能炸`,
    );
    const ins = soulDb.raw.prepare(
      "INSERT OR IGNORE INTO users (id, wechat_user_id, internal_user_id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const u of missingInSoul) {
      const row = sharedDb.raw.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as any;
      if (row) ins.run(row.id, row.wechat_user_id, row.internal_user_id, row.display_name, row.created_at, row.last_seen_at);
    }
    console.log(`[startup] ✅ 已自动补 ${missingInSoul.length} users 到 SOUL DB[${currentSoul}]`);
  }

  const embed = createEmbeddingClient();

  // === AIChat ===
  const systemPrompt = await loadSystemPromptFromEnv();
  const models = loadModels();
  const defaultEntry = models.byName.get(models.defaultName);
  if (!defaultEntry) {
    throw new Error(`默认模型 ${models.defaultName} 不在 registry 中`);
  }
  const defaultCfg: ModelConfig = defaultEntry.config;

  const ai = new AIChat({
    apiKey: defaultCfg.apiKey,
    baseURL: defaultCfg.baseURL,
    model: defaultCfg.model,
    contextLimit: defaultCfg.contextLimit,
    name: defaultEntry.name,
    systemPrompt,
  });

  console.log(`[config] 已配置 ${models.entries.length} 个模型`);
  console.log(`[config] 默认模型: ${defaultEntry.name} (${defaultCfg.model})`);
  console.log(`[config] 模型列表: ${models.entries.map((e) => e.name).join(", ")}`);

  // === Summarizer ===
  const summarizer = new Summarizer({
    openai: ai.getClient(),
    currentModel: ai.getCurrentModel(),
    db: soulDb, embed,
  });

  // P19 MAJOR-A: 删除死代码 function resolveSession — P18 已全替换成 Bot.resolveSessionInternal

  // === P16: /new 闭包逻辑已移至 Bot.onNewInternal（避免持有旧 DB 引用）
  // 此处只注入 reloadEnv / formatModelList 函数引用给 Bot
  const onNewDeps = { reloadEnv, formatModelList };
  let botRef: Bot | null = null;

  const bot = new Bot({
    channel,
    ai,
    models: models.byName,
    defaultModelName: defaultEntry.name,
    onNewDeps,  // P16: 不再传 onNew 闭包 — Bot.onNewInternal 用 onNewDeps
    sharedDb, soulDb, currentSoul, embed, summarizer,
  });
  botRef = bot;

  // P15: 让 bot 在 /soul 切换时能重建 summarizer（新 db connection）
  botRef.setSummarizerRebuilder((newDb) => {
    return new Summarizer({
      openai: ai.getClient(),
      currentModel: ai.getCurrentModel(),
      db: newDb,
      embed,
    });
  });

  // === SIGTERM graceful: flush 所有 active sessions ===
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，开始 graceful shutdown...`);
    try {
      await summarizer.flushAllActiveSessions();
      console.log("[shutdown] summarizer flush 完成");
    } catch (err) {
      console.error(`[shutdown] flush 失败: ${err}`);
    }
    bot.stop();
    try {
      await channel.stop();
    } catch (err) {
      console.error(`[shutdown] 渠道停止失败: ${err}`);
    }
    soulDb.close();
    sharedDb.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
