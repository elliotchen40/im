import fs from "node:fs";
import path from "node:path";
import type { Channel, InboundMessage } from "./channel/types.js";
import { AIChat, type ImagePart } from "./ai/chat.js";
import type { ModelEntry, ModelsRegistry } from "./ai/config.js";
import type { MemoryDB } from "./memory/db.js";
import { ensureUsersInSoulDb, ensureOneUserInSoulDb, init_soul_db } from "./memory/db.js";
import type { EmbeddingClient } from "./memory/embed.js";
import { v2Chat, loadHistoryFromDB } from "./memory/chat_integration.js";
import { getSoulDbPath } from "./memory/soul_dir.js";
import { createCareGuard, type CareGuard } from "./care/guard.js";
import { runScheduledCareTick } from "./care/scheduled_tick.js";
import type { Summarizer } from "./memory/summarize.js";
import { SoulHandshake } from "./memory/soul_handshake.js";
import { formatHelp, formatStatus, handleMemoryCommand } from "./commands.js";

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
// 渠道 session 超时（承接 iLink errcode -14 语义）后的重连间隔
const SESSION_EXPIRED_DELAY_MS = 5_000;

const contextTokens = new Map<string, string>();

export interface BotContext {
  /**
   * 渠道（取代原 `credentials` + `weixin/api` 的直连）。
   * 微信 iLink 与自研 IM 都只是 Channel 的一个实现 —— Bot 不再感知渠道细节。
   */
  channel: Channel;
  ai: AIChat;
  models: Map<string, ModelEntry>;
  defaultModelName: string;
  /** P16: /new 重启对话所需 deps（reloadEnv / formatModelList 函数引用） */
  onNewDeps?: {
    reloadEnv: () => { systemPrompt: string; models: ModelsRegistry };
    formatModelList: (models: ModelsRegistry) => string;
  };
  /** P15: 共享 DB（只 users 表；全局用户身份） */
  sharedDb: MemoryDB;
  /** P15: 当前 SOUL 的 DB（per-SOUL 记忆） */
  soulDb: MemoryDB;
  /** P15: 当前 SOUL 名 */
  currentSoul: string;
  embed: EmbeddingClient;
  summarizer: Summarizer;
  /** .env 路径（用于 /soul 切换角色后改 SYSTEM_PROMPT_FILE）。默认 ".env" */
  envPath?: string;
}

export class Bot {
  private channel: Channel;
  private ai: AIChat;
  private models: Map<string, ModelEntry>;
  private currentModelName: string;
  private running = false;
  private syncCursor = "";
  /** P16: Bot 自己持有的 deps（不再走 index.ts 闭包） */
  private onNewDeps: BotContext["onNewDeps"] = undefined;
  /** P15: 共享 DB（users 表全局） */
  private sharedDb: MemoryDB;
  /** P15: 当前 SOUL 的 DB（per-SOUL sessions/dialogues/summaries/memories） */
  private soulDb: MemoryDB;
  /** P15: 当前 SOUL 名（默认 ASHLEY） */
  private currentSoul: string;
  private embed: EmbeddingClient;
  private summarizer: any;  // P16: 接受 stub（测试用），生产仍是 Summarizer
  /** P16: 内部会话解析 — 每次都用 this.sharedDb / this.soulDb 最新引用 */
  private resolveSessionInternal(channelUserId: string): { userId: number; sessionId: number } {
    const userId = this.sharedDb.upsertUser(channelUserId);
    // P21 修：冷启动首条消息兜底 — 全新空 shared DB 时 P17 startup selfcheck no-op，
    // 刚 upsert 的 user_id 不在 soulDb.users → openSession FK 会炸。立即补这一个 user。
    // 已存在则 ensureOneUserInSoulDb 是 no-op，开销 < 1ms。
    try {
      ensureOneUserInSoulDb(this.sharedDb, this.soulDb, userId, this.currentSoul);
    } catch (err) {
      console.warn(`[bot] ensureOneUserInSoulDb 警告（non-fatal）: ${err instanceof Error ? err.message : err}`);
    }
    let sid = this.soulDb.getActiveSession(userId);
    if (sid === null) {
      sid = this.soulDb.openSession(userId);
    }
    // P19 BLOCKER-A：daemon 重启后首条消息 AI 应看到历史
    try {
      loadHistoryFromDB(this.ai, channelUserId, userId, sid, this.soulDb);
    } catch (err) {
      console.warn(`[bot] loadHistoryFromDB 警告（non-fatal）: ${err instanceof Error ? err.message : err}`);
    }
    return { userId, sessionId: sid };
  }
  /** P14 SOUL 角色选择握手 */
  private soulHandshake: SoulHandshake;
  /** P15: summarizer 重建器（用于 /soul 切换时换 db connection） */
  private summarizerRebuilder: ((newDb: MemoryDB) => Summarizer) | null = null;
  // LISA DB（主动关怀专用，不随 swapSoulDb 改变）
  private lisaDb: MemoryDB;
  // care guard（静默规则）
  private careGuard: CareGuard;
  // 当前渠道用户（单用户场景：最近收到消息的那个）
  private careChannelUserId: string | null = null;
  // P30.5: 独立 setInterval（不再绑长轮询）
  private careIntervalHandle: NodeJS.Timeout | null = null;
  // P30.5: 4h tick 间隔（环境变量覆盖，默认 4h）
  private careIntervalMs: number = Number(process.env.CARE_TICK_INTERVAL_MS ?? 4 * 60 * 60 * 1000);

  constructor(ctx: BotContext) {
    this.channel = ctx.channel;
    this.ai = ctx.ai;
    this.models = ctx.models;
    this.currentModelName = ctx.defaultModelName;
    this.onNewDeps = ctx.onNewDeps;
    // P15: sharedDb 用于 users 表（全局身份）；soulDb 用于当前 SOUL 的业务表
    this.sharedDb = ctx.sharedDb;
    this.soulDb = ctx.soulDb;
    this.currentSoul = ctx.currentSoul;
    this.embed = ctx.embed;
    this.summarizer = ctx.summarizer;
    this.soulHandshake = new SoulHandshake({ envPath: ctx.envPath });
    // 打开 LISA DB（主动消息来源 SOUL，永久打开不随 swapSoulDb 改）
    this.lisaDb = init_soul_db("LISA", getSoulDbPath("LISA"));
    this.careGuard = createCareGuard(this.lisaDb);
  }

  /** /memory 命令的窄依赖（命令实现已拆到 commands.ts） */
  private memoryCommandDeps() {
    return {
      soulDb: this.soulDb,
      embed: this.embed,
      resolveSession: (uid: string) => this.resolveSessionInternal(uid),
    };
  }

  /** 主动关怀 tick 的依赖（tick 实现已拆到 care/scheduled_tick.ts） */
  private careTickDeps() {
    return {
      lisaDb: this.lisaDb,
      sharedDb: this.sharedDb,
      guard: this.careGuard,
      ai: this.ai,
      embed: this.embed,
      careChannelUserId: this.careChannelUserId,
      careIntervalMs: this.careIntervalMs,
      onSwitchToLisa: () => this.switchToLisaCarefully(),
      onSendMessage: (uid: string, msg: string) => this.sendCareMessage(uid, msg),
    };
  }

  updateModels(models: Map<string, ModelEntry>, defaultModelName: string): void {
    this.models = models;
    this.currentModelName = defaultModelName;
  }

  /**
   * P15: /soul 切换角色后调用 — 关闭旧 soulDb，开新 soulDb，更新 currentSoul
   * 失败时回滚（不关闭旧 DB）。
   */
  swapSoulDb(newSoulName: string, newSoulDb: MemoryDB): void {
    const oldDb = this.soulDb;
    try {
      this.soulDb = newSoulDb;
      this.currentSoul = newSoulName;
    } catch (err) {
      // 失败 — 回滚
      this.soulDb = oldDb;
      throw err;
    }
    // 成功 — 关闭旧 DB（summarizer 持有旧 db connection，需重建）
    try { oldDb.close(); } catch {}
    // P18 BLOCKER 1+3：新 SOUL DB 缺 users 会导致后续 FK 失败
    // 用 IMMEDIATE 事务补齐（避免 race）
    try {
      ensureUsersInSoulDb(this.sharedDb, newSoulDb, newSoulName);
    } catch (err) {
      console.warn(`[bot] ensureUsersInSoulDb 警告：${err}`);
    }
    // summarizer 也持有 db connection，切换后必须重建实例
    if (this.summarizerRebuilder) {
      try {
        this.summarizer = this.summarizerRebuilder(newSoulDb);
        console.log(`[bot] summarizer 已用新 SOUL db 重建`);
      } catch (err) {
        console.error(`[bot] summarizer 重建失败: ${err}`);
      }
    }
  }

  /** P15: 由 index.ts 注入 — 接收新 soulDb 返回新的 Summarizer 实例 */
  setSummarizerRebuilder(fn: (newDb: MemoryDB) => Summarizer): void {
    this.summarizerRebuilder = fn;
  }

  /**
   * P16: /new 重启对话 — 用 bot 实例自己的 db / summarizer
   * （避免闭包持有旧引用导致 "connection is not open"）
   */
  async onNewInternal(channelUserId: string): Promise<string> {
    if (!this.onNewDeps) {
      return "[bot] onNewDeps 未注入，无法重启";
    }
    const resolved = this.resolveSessionInternal(channelUserId);
    try {
      await this.summarizer.flushSessionSync(resolved.sessionId, resolved.userId);
    } catch (err) {
      console.error(`[reload] summarizer flush 失败: ${err}`);
    }
    this.soulDb.closeSession(resolved.sessionId);
    const newSessionId = this.soulDb.openSession(resolved.userId);
    this.ai.clearSession(channelUserId);
    this.summarizer.cancelIdle(newSessionId);

    const { systemPrompt: newPrompt, models: newModels } = this.onNewDeps.reloadEnv();
    const newDefaultEntry = newModels.byName.get(newModels.defaultName);
    if (!newDefaultEntry) {
      return `[reload] 新 .env 未配置任何模型，未应用变更`;
    }
    const cfg = newDefaultEntry.config;
    this.ai.setModel(newDefaultEntry.name, {
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
      contextLimit: cfg.contextLimit,
    });
    this.ai.setSystemPrompt(newPrompt);
    this.summarizer.setModel(this.ai.getClient(), cfg.model);
    this.updateModels(newModels.byName, newDefaultEntry.name);
    console.log(`[reload] 用户 ${channelUserId} 触发 /new，新默认模型: ${newDefaultEntry.name}`);
    return `${this.onNewDeps.formatModelList(newModels)}\n对话已重置，环境已重载 ✅`;
  }

  async start(): Promise<void> {
    this.running = true;
    this.loadSyncCursor();  // 重启后恢复增量游标
    console.log("[bot] 机器人已启动，开始监听消息...");

    // P30.5: 独立 setInterval scheduler（与 handleMessage 完全解耦），
    // 启动时立刻跑一次，然后每 careIntervalMs 跑一次
    console.log(`[bot] care scheduler: setInterval ${this.careIntervalMs}ms (${this.careIntervalMs / 3600000}h)`);
    const tick = () => runScheduledCareTick(this.careTickDeps());
    void tick();
    this.careIntervalHandle = setInterval(() => {
      void tick();
    }, this.careIntervalMs);

    let failures = 0;

    while (this.running) {
      try {
        const resp = await this.channel.poll(this.syncCursor);

        // 渠道业务错误 = HTTP 200 + body 里报错（承接原 iLink 的 ret/errcode 判定）。
        // 上游旧代码只查 `resp.ret !== 0`，于是「只有 errcode 没有 ret」（如 session 超时 errcode:-14）
        // 会被当成成功 —— bot 表面在跑、实际已死，且没有任何日志。这里保留这一层防护。
        if (resp.failure) {
          failures++;
          const isSessionTimeout = resp.failure.code === "session_expired";
          console.error(
            `[bot] poll 业务错误${isSessionTimeout ? "（session 超时）" : ""} ` +
              `[${resp.failure.code}]: ${resp.failure.message}`,
          );
          if (isSessionTimeout) {
            // session 超时先重置游标重连；游标已为空仍超时 = 渠道凭证本身失效，不能自愈
            if (this.syncCursor) {
              console.warn("[bot] session 超时 → 重置 sync cursor 后重连");
              this.syncCursor = "";
              this.persistSyncCursor();
              await sleep(SESSION_EXPIRED_DELAY_MS);
            } else {
              // 不可自愈：只在首次失败时告警一次，之后按 BACKOFF_DELAY_MS 退避，避免每 5s 刷屏
              if (failures === 1) {
                console.error("[bot] ⚠️ 渠道会话已失效且无法自愈 —— 请检查渠道凭证配置后重启 daemon");
              }
              await sleep(BACKOFF_DELAY_MS);
            }
            continue;
          }
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[bot] 连续失败 ${failures} 次，等待 ${BACKOFF_DELAY_MS / 1000}s 后重试`);
            failures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        failures = 0;

        if (resp.cursor) {
          this.syncCursor = resp.cursor;
          this.persistSyncCursor();
        }

        for (const msg of resp.messages) {
          await this.handleMessage(msg);
        }
      } catch (err) {
        failures++;
        console.error(`[bot] 轮询异常: ${err}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.careIntervalHandle) {
      clearInterval(this.careIntervalHandle);
      this.careIntervalHandle = null;
      console.log("[bot] care interval cleared");
    }
    console.log("[bot] 机器人已停止");
  }

  // === sync cursor 持久化（承接上游 weclaw 的 .sync.json / getUpdatesBuf 机制）===
  // cursor 由 Channel.poll 返回、由 Bot 持久化并回传，与上游 getUpdatesBuf 语义一一对应。
  /** sync cursor 落盘路径（按渠道名区分） */
  private syncCursorPath(): string {
    const dbPath = process.env.IM_BOT_DB_PATH ?? process.env.WX_BOT_DB_PATH ?? "data/im_bot.db";
    const dir = path.dirname(dbPath);
    const safeId = this.channel.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(dir && dir !== "." ? dir : "data", `sync_cursor_${safeId}.json`);
  }

  /** 启动时读回 sync cursor（best-effort，失败即从空 cursor 开始） */
  private loadSyncCursor(): void {
    try {
      const p = this.syncCursorPath();
      if (!fs.existsSync(p)) return;
      // 兼容上游 wx-robot 的 get_updates_buf 字段名
      const data = JSON.parse(fs.readFileSync(p, "utf-8")) as {
        cursor?: string;
        get_updates_buf?: string;
      };
      const cursor = data.cursor ?? data.get_updates_buf;
      if (cursor) {
        this.syncCursor = cursor;
        console.log(`[bot] 已恢复 sync cursor (${cursor}) from ${p}`);
      }
    } catch (err) {
      console.warn(`[bot] 恢复 sync cursor 失败（忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 落盘 sync cursor（best-effort） */
  private persistSyncCursor(): void {
    try {
      const p = this.syncCursorPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ cursor: this.syncCursor }), "utf-8");
    } catch (err) {
      console.warn(`[bot] 保存 sync cursor 失败（忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  private formatModelList(): string {
    const current = this.ai.getCurrentModel();
    const lines: string[] = [];
    lines.push(`当前模型: ${current.name} (${current.model})`);
    lines.push("可用模型:");
    for (const [name, entry] of this.models) {
      const c = entry.config;
      const where = c.baseURL ? ` @ ${c.baseURL}` : "";
      lines.push(`  · ${name.padEnd(14)} (${c.model}${where})`);
    }
    lines.push("切换: /model <name>");
    return lines.join("\n");
  }

  /** P14 /soul 命令：列候选 + 进入 10s 等待 */
  private async handleSoulCommand(fromUser: string, _text: string): Promise<string> {
    const result = this.soulHandshake.enterWait(fromUser);
    return result.reply;
  }

  private handleModelCommand(rawText: string): { handled: true; reply: string } | { handled: false } {
    const trimmed = rawText.trim();
    if (!trimmed.startsWith("/model")) return { handled: false };

    const rest = trimmed.slice("/model".length).trim();
    if (rest === "") {
      return { handled: true, reply: this.formatModelList() };
    }

    const name = rest.split(/\s+/)[0].toLowerCase();
    const entry = this.models.get(name);
    if (!entry) {
      const names = Array.from(this.models.keys()).join(" / ");
      return { handled: true, reply: `模型 ${name} 不存在。可用: ${names}` };
    }

    this.ai.setModel(entry.name, {
      apiKey: entry.config.apiKey,
      baseURL: entry.config.baseURL,
      model: entry.config.model,
      contextLimit: entry.config.contextLimit,
    });
    this.summarizer.setModel(this.ai.getClient(), entry.config.model);
    this.currentModelName = entry.name;
    console.log(`[bot] 已切换模型 -> ${entry.name} (${entry.config.model})`);
    return { handled: true, reply: `已切换到 ${entry.name} (${entry.config.model})` };
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    const fromUser = msg.channelUserId;
    if (!fromUser) return;

    if (msg.replyContext) {
      contextTokens.set(fromUser, msg.replyContext);
    }

    // 渠道层已把消息归一化为 text + images（上游的 extractTextFromMessage /
    // extractImageItems / downloadImage 三个渠道细节调用全部收敛到 Channel 实现里）
    const text = msg.text;
    const imageItems = msg.images;

    // 记录当前用户（care tick 需要）+ 拒收/恢复检测
    this.careChannelUserId = fromUser;
    if (text.trim()) {
      const REJECT_PATTERNS = [/别发(了|吧)?/i, /让我静静/i, /够了/i];
      const RESUME_PATTERNS = [/恢复主动通知/i, /可以主动(联系|发消息)?/i];
      if (REJECT_PATTERNS.some(p => p.test(text))) {
        try {
          const uid = this.sharedDb.upsertUser(fromUser);
          const newCount = this.careGuard.incrementRejection(uid);
          console.log(`[bot] 拒收检测：${fromUser} rejection_count=${newCount}`);
        } catch (err) {
          console.warn(`[bot] 拒收检测异常（non-fatal）: ${err}`);
        }
      } else if (RESUME_PATTERNS.some(p => p.test(text))) {
        try {
          const uid = this.sharedDb.upsertUser(fromUser);
          this.careGuard.resetRejections(uid);
          console.log(`[bot] 恢复主动通知：${fromUser} rejection_count 重置`);
        } catch (err) {
          console.warn(`[bot] 恢复检测异常（non-fatal）: ${err}`);
        }
      }
    }

    if (text.trim().startsWith("/model")) {
      const cmd = this.handleModelCommand(text);
      if (cmd.handled) {
        console.log(`[bot] 命令 from=${fromUser}: /model -> ${cmd.reply.slice(0, 80)}`);
        await this.reply(fromUser, cmd.reply);
        return;
      }
    }

    if (!imageItems.length && text.trim() === "/status") {
      const stats = this.ai.getSessionStats(fromUser);
      const current = this.ai.getCurrentModel();
      console.log(`[bot] 命令 from=${fromUser}: /status`);
      await this.reply(fromUser, formatStatus(current, stats, fromUser));
      return;
    }

    if (!imageItems.length && text.trim() === "/clear") {
      // /clear: 清内存 session + 关 active session + 开新 session（落盘数据保留）
      this.ai.clearSession(fromUser);
      const resolved = this.resolveSessionInternal(fromUser);
      this.soulDb.closeSession(resolved.sessionId);
      const newSessionId = this.soulDb.openSession(resolved.userId);
      const memSession = this.ai.getSessionPublic(fromUser);
      memSession.history.length = 0;
      this.summarizer.cancelIdle(newSessionId);
      console.log(`[bot] 命令 from=${fromUser}: /clear (close ${resolved.sessionId} → open ${newSessionId})`);
      await this.reply(fromUser, "对话已重置 ✅");
      return;
    }

    if (!imageItems.length && text.trim() === "/new") {
      console.log(`[bot] 命令 from=${fromUser}: /new`);
      try {
        const reply = await this.onNewInternal(fromUser);
        await this.reply(fromUser, reply);
      } catch (err) {
        console.error(`[bot] /new 失败: ${err}`);
        await this.reply(fromUser, "环境重载失败，请稍后再试。");
      }
      return;
    }

    if (!imageItems.length && text.trim().startsWith("/memory")) {
      console.log(`[bot] 命令 from=${fromUser}: /memory`);
      const reply = await handleMemoryCommand(this.memoryCommandDeps(), fromUser, text);
      await this.reply(fromUser, reply);
      return;
    }

    if (!imageItems.length && text.trim() === "/help") {
      console.log(`[bot] 命令 from=${fromUser}: /help`);
      await this.reply(fromUser, formatHelp());
      return;
    }

    if (!imageItems.length && text.trim().startsWith("/soul")) {
      console.log(`[bot] 命令 from=${fromUser}: /soul`);
      const reply = await this.handleSoulCommand(fromUser, text);
      await this.reply(fromUser, reply);
      return;
    }

    // === SOUL 角色选择优先级（在主对话前）===
    // 用户处于 soul 选择等待状态 → 任何文本输入都先尝试解析为选择
    if (this.soulHandshake.hasPending(fromUser) && text.trim()) {
      const result = this.soulHandshake.tryHandleSelection(fromUser, text);
      if (result !== null) {
        console.log(`[bot] /soul 选择 from=${fromUser}: ${result.reply.slice(0, 80)}`);
        await this.reply(fromUser, result.reply);
        // 切换成功 → 自动重启对话
        if ("newPath" in result) {
          const m = result.candidate.name;
          try {
            // dynamic import 避免循环依赖
            const { init_soul_db } = await import("./memory/db.js");
            const { getSoulDbPath } = await import("./memory/soul_dir.js");
            const newDbPath = getSoulDbPath(m);
            const newDb = init_soul_db(m, newDbPath);
            this.swapSoulDb(m, newDb);
            console.log(`[bot] SOUL 切换完成：${this.currentSoul} (db=${newDbPath})`);
            try {
              const restartReply = await this.onNewInternal(fromUser);
              await this.reply(fromUser, restartReply);
            } catch (err) {
              console.error(`[bot] /soul 重启失败: ${err}`);
              await this.reply(fromUser, `重启对话失败：${err instanceof Error ? err.message : err}`);
            }
          } catch (err) {
            console.error(`[bot] /soul DB 切换失败: ${err}`);
            await this.reply(fromUser, `DB 切换失败：${err instanceof Error ? err.message : err}`);
          }
        }
        return;
      }
    }

    if (!text.trim() && imageItems.length === 0) return;

    // === v2 主对话路径 ===
    const logText = text
      ? text.slice(0, 100)
      : imageItems.length
        ? `[图片 x${imageItems.length}]`
        : "";
    console.log(`[bot] 收到消息 from=${fromUser}: ${logText}`);

    // 渠道已把图片取回并 base64 化（上游 downloadImage 的 CDN 下载 + AES 解密细节
    // 全部收敛在 Channel 实现里），这里只需解码成 AIChat 的 ImagePart。
    const images: ImagePart[] = [];
    let imageFailures = 0;
    for (const item of imageItems) {
      try {
        images.push({ data: Buffer.from(item.dataBase64, "base64"), mimeType: item.mime });
      } catch (err) {
        imageFailures++;
        console.error(`[bot] 图片解码失败: ${err}`);
      }
    }

    let userMessageForAi = text.trim();
    if (!userMessageForAi && imageFailures > 0 && images.length === 0) {
      userMessageForAi = "用户发送了一张图片但加载失败，请按文字回复。";
    }

    try {
      const aiReply = await v2Chat(
        { ai: this.ai, db: this.soulDb, embed: this.embed, summarizer: this.summarizer,
          // P20 修：箭头函数包一层把 this 绑死 — 方法引用传给 deps 后裸调会丢 this，
          // 导致 this.sharedDb 为 undefined，upsertUser 炸。
          resolveSession: (uid: string) => this.resolveSessionInternal(uid) },
        fromUser, userMessageForAi, images.length > 0 ? images : undefined,
      );
      console.log(`[bot] AI 回复 to=${fromUser}: ${aiReply.slice(0, 100)}`);
      await this.reply(fromUser, aiReply);
    } catch (err) {
      console.error(`[bot] AI 调用失败: ${err}`);
      await this.reply(fromUser, "抱歉，AI 暂时无法回复，请稍后再试。");
    }
  }

  // === 主动关怀 helpers ===
  /** 切到 LISA SOUL（如果在别的 SOUL，触发 swapSoulDb + summarizer 重建） */
  private async switchToLisaCarefully(): Promise<void> {
    if (this.currentSoul === "LISA") return;
    try {
      const newDb = init_soul_db("LISA", getSoulDbPath("LISA"));
      this.swapSoulDb("LISA", newDb);
      console.log(`[bot] care: 已切到 LISA`);
    } catch (err) {
      console.error(`[bot] care switchToLisa 失败: ${err}`);
    }
  }

  /** 发主动关怀消息（独立 send，不带 replyContext，因为是主动发起） */
  private async sendCareMessage(to: string, text: string): Promise<void> {
    try {
      await this.channel.send(to, { text, proactive: true, kind: "proactive" });
      console.log(`[bot] care: 已发送 ${text.length} 字符 to=${to}`);
    } catch (err) {
      console.error(`[bot] care send 失败 to=${to}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async reply(to: string, text: string): Promise<void> {
    const replyContext = contextTokens.get(to);
    try {
      await this.channel.send(to, { text, replyContext });
    } catch (err) {
      console.error(`[bot] 发送消息失败 to=${to}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
