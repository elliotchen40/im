/**
 * HTTP 长轮询通道 —— 自研 IM 协议的服务端实现，取代微信 iLink 渠道。
 *
 * ## 为什么是长轮询而不是 WebSocket
 * 1. **语义 1:1 等价**：iLink 的 `getUpdates` 本身就是"带游标的长轮询"。
 *    复刻同一形状，Bot 主循环的重试 / 退避 / session 超时自愈逻辑可以原样保留，
 *    改造风险最小（这是"承接架构"而不是"重写架构"的关键）。
 * 2. **零第三方依赖**：只用 `node:http`，不引入 `ws`。部署面与上游一致。
 * 3. **鸿蒙端更简单**：ArkTS 侧用 `@ohos.net.http` 即可，不必自己维护
 *    WebSocket 重连 / 心跳 / 半开连接状态机。
 * WebSocket 推送通道列为 P2 增量（见 docs/protocol/im-protocol.md §7）。
 *
 * ## 对外 HTTP API（给鸿蒙 app）
 * ```
 * GET  /im/health   探活（免鉴权）
 * POST /im/send     上行：app → 服务端          Authorization: Bearer <token>
 * POST /im/sync     下行：app 长轮询拉机器人消息  Authorization: Bearer <token>
 * ```
 *
 * ## 内部 Channel 接口（给 Bot）
 * ```
 * poll(cursor)  取上行消息（app 发来的）
 * send(to, msg) 写下行 outbox（app 通过 /im/sync 拉取）
 * ```
 *
 * ## 投递语义
 * - 上行：`inbox.jsonl` append-only + `inbox.ack` 记录已确认序号 → 至少一次投递。
 *   重复投递由 `dialogues` 表的 `UNIQUE(channel, external_msg_id)` 兜底幂等。
 * - 下行：`outbox.jsonl` 保留最近 `OUTBOX_KEEP` 条，客户端自带 cursor 拉取，
 *   掉线重连后自动补齐（等价于微信的"历史消息"）。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Channel,
  ChannelPollResult,
  InboundImage,
  InboundMessage,
  OutboundMessage,
} from "./types.js";
import { consumePairing, pairingFilePath, verifyPairingCode } from "../pair/pairing.js";

/** HTTP 长轮询默认监听端口（可用 IM_HTTP_PORT 覆盖；开发机容器 8081 → 宿主 18796） */
export const DEFAULT_HTTP_PORT = 8081;
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB，单条消息最多几张图
const OUTBOX_KEEP = 1_000;

interface InboundRecord {
  seq: number;
  channelUserId: string;
  clientMsgId: string;
  text: string;
  images: InboundImage[];
  receivedAt: number;
}

interface OutboxRecord {
  seq: number;
  channelUserId: string;
  text: string;
  kind: string;
  ts: number;
  serverMsgId: string;
}

export interface HttpChannelOptions {
  /** 鉴权 token（IM_APP_TOKEN），必填 —— 为空直接抛错，避免裸奔部署 */
  token: string;
  /** 数据目录（inbox/outbox 落盘处） */
  dataDir: string;
  port?: number;
  host?: string;
  longPollTimeoutMs?: number;
  /** 单用户模式下的固定用户 ID；P2 做多用户时改为按 token/deviceId 映射 */
  defaultUserId?: string;
  /**
   * 历史消息读取回调（/im/history 用）—— 由入口层注入，内部访问 per-SOUL DB。
   * 这样 HttpChannel 保持不依赖 DB，符合「Bot/通道不感知渠道」边界。
   * 返回的 msg 需与 outbox 的记录形态一致（含 seq / channelUserId / text / kind / ts / serverMsgId）。
   */
  historyReader?: (opts: { beforeId?: number; limit: number }) => Array<{
    seq: number;
    channelUserId: string;
    text: string;
    kind: string;
    ts: number;
    serverMsgId: string;
  }>;
}

export class HttpChannel implements Channel {
  readonly name = "im";

  private readonly token: string;
  private readonly dataDir: string;
  private readonly port: number;
  private readonly host: string;
  private readonly longPollTimeoutMs: number;
  private readonly defaultUserId: string;
  private historyReader?: HttpChannelOptions["historyReader"];

  /** 入口层在 soulDb 就绪后注入历史读取回调（/im/history 用） */
  setHistoryReader(
    reader: (opts: { beforeId?: number; limit: number }) => Array<{
      seq: number;
      channelUserId: string;
      text: string;
      kind: string;
      ts: number;
      serverMsgId: string;
    }>,
  ): void {
    this.historyReader = reader;
  }

  private server: http.Server | null = null;
  private running = false;

  /** 上行（app → bot） */
  private inbound: InboundRecord[] = [];
  private inboundSeq = 0;
  private inboundAckSeq = 0;

  /** 下行（bot → app） */
  private outbox: OutboxRecord[] = [];
  private outboxSeq = 0;

  /** poll / sync 的挂起者（长轮询） */
  private waiters: Array<() => void> = [];

  constructor(opts: HttpChannelOptions) {
    if (!opts.token || !opts.token.trim()) {
      throw new Error(
        "[channel/im] IM_APP_TOKEN 未配置 —— 拒绝以无鉴权方式启动 HTTP 通道",
      );
    }
    this.token = opts.token.trim();
    this.dataDir = opts.dataDir;
    this.port = opts.port ?? DEFAULT_HTTP_PORT;
    this.host = opts.host ?? "0.0.0.0";
    this.longPollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.defaultUserId = opts.defaultUserId ?? "owner";
    this.historyReader = opts.historyReader;
  }

  // ---------------------------------------------------------------- 持久化

  /** 公开当前单用户模式的 userId（入口层 /im/history 回调要用） */
  get userId(): string {
    return this.defaultUserId;
  }

  private get inboxPath(): string {
    return path.join(this.dataDir, "inbox.jsonl");
  }
  private get inboxAckPath(): string {
    return path.join(this.dataDir, "inbox.ack");
  }
  private get outboxPath(): string {
    return path.join(this.dataDir, "outbox.jsonl");
  }

  private loadState(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });

    // 下行
    const outboxLines = readJsonl<OutboxRecord>(this.outboxPath);
    this.outbox = outboxLines.slice(-OUTBOX_KEEP);
    this.outboxSeq = this.outbox.reduce((m, r) => Math.max(m, r.seq), 0);

    // 上行：文件里只保留未 ack 的行
    this.inbound = readJsonl<InboundRecord>(this.inboxPath);
    this.inboundSeq = this.inbound.reduce((m, r) => Math.max(m, r.seq), 0);
    try {
      const raw = fs.readFileSync(this.inboxAckPath, "utf-8").trim();
      this.inboundAckSeq = raw ? Number(raw) || 0 : 0;
    } catch {
      this.inboundAckSeq = 0;
    }
    // ack 已更新但文件没压缩过（进程被杀）→ 丢掉已 ack 的
    this.inbound = this.inbound.filter((r) => r.seq > this.inboundAckSeq);
    // 关键：inbox 被 ack 压缩后文件里没有行，但上行序号必须继续**单调递增**。
    // 否则 daemon 重启后新消息从 seq=1 重新计数，而 Bot 的游标已恢复到 N，
    // poll 的 `seq > since` 会把它们全判为「已投递」而**永久丢弃**（重启后收不到任何消息）。
    // 以 ack 作为下界即可保证单调。
    this.inboundSeq = Math.max(this.inboundSeq, this.inboundAckSeq);
    console.log(
      `[channel/im] 状态已恢复：outbox=${this.outbox.length} 条(seq=${this.outboxSeq}) ` +
        `inbox 待投递=${this.inbound.length} 条(ack=${this.inboundAckSeq})`,
    );
  }

  private appendJsonl(file: string, obj: unknown): void {
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf-8");
  }

  /** ack 上行序号：更新 ack 文件并把 inbox 压缩成"未投递"部分 */
  private ackInbound(seq: number): void {
    this.inboundAckSeq = Math.max(this.inboundAckSeq, seq);
    this.inbound = this.inbound.filter((r) => r.seq > this.inboundAckSeq);
    try {
      fs.writeFileSync(this.inboxAckPath, String(this.inboundAckSeq), "utf-8");
      fs.writeFileSync(
        this.inboxPath,
        this.inbound.map((r) => JSON.stringify(r)).join("\n") + (this.inbound.length ? "\n" : ""),
        "utf-8",
      );
    } catch (err) {
      console.warn(`[channel/im] 压缩 inbox 失败（non-fatal）: ${describe(err)}`);
    }
  }

  private compactOutbox(): void {
    if (this.outbox.length <= OUTBOX_KEEP) return;
    this.outbox = this.outbox.slice(-OUTBOX_KEEP);
    try {
      fs.writeFileSync(
        this.outboxPath,
        this.outbox.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    } catch (err) {
      console.warn(`[channel/im] 压缩 outbox 失败（non-fatal）: ${describe(err)}`);
    }
  }

  // ------------------------------------------------------------- 长轮询原语

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  private waitForActivity(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.running) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.push(finish);
    });
  }

  // ------------------------------------------------------------ Channel 接口

  async start(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.loadState();

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
    this.running = true;
    console.log(
      `[channel/im] HTTP 长轮询通道已启动 http://${this.host}:${this.port} ` +
        `(user=${this.defaultUserId}, longPoll=${this.longPollTimeoutMs}ms)`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    console.log("[channel/im] 通道已停止");
  }

  async poll(cursor: string): Promise<ChannelPollResult> {
    const since = cursor ? Number(cursor) || 0 : this.inboundAckSeq;

    let pending = this.inbound.filter((m) => m.seq > since);
    if (pending.length === 0) {
      await this.waitForActivity(this.longPollTimeoutMs);
      pending = this.inbound.filter((m) => m.seq > since);
    }

    if (pending.length === 0) {
      return { cursor: String(this.inboundAckSeq), messages: [] };
    }

    const maxSeq = pending[pending.length - 1].seq;
    const messages: InboundMessage[] = pending.map((r) => ({
      channelUserId: r.channelUserId,
      clientMsgId: r.clientMsgId,
      text: r.text,
      images: r.images,
      receivedAt: r.receivedAt,
      seq: r.seq,
    }));
    this.ackInbound(maxSeq);
    return { cursor: String(maxSeq), messages };
  }

  async send(to: string, msg: OutboundMessage): Promise<void> {
    const seq = ++this.outboxSeq;
    const rec: OutboxRecord = {
      seq,
      channelUserId: to,
      text: msg.text,
      kind: msg.kind ?? (msg.proactive ? "proactive" : "reply"),
      ts: Date.now(),
      serverMsgId: crypto.randomUUID(),
    };
    this.outbox.push(rec);
    this.appendJsonl(this.outboxPath, rec);
    this.compactOutbox();
    console.log(`[channel/im] → ${to} (seq=${seq}, ${msg.text.length} 字符, kind=${rec.kind})`);
    this.wake(); // 唤醒挂起中的 /im/sync
  }

  // --------------------------------------------------------------- HTTP 层

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/im/health") {
        return this.json(res, 200, {
          ret: 0,
          channel: this.name,
          outboxSeq: this.outboxSeq,
          inboundAck: this.inboundAckSeq,
          pendingInbound: this.inbound.length,
        });
      }
      if (req.method !== "POST") {
        return this.json(res, 404, { ret: -1, errmsg: "not found" });
      }
      // 扫码配对：**故意放在 authorized 之前** —— 它的目的就是换取 token，
      // 保护手段是「一次性配对码 + 5 分钟有效期 + 失败计数」（见 pair/pairing.ts）。
      if (url.pathname === "/im/pair") return await this.handlePair(req, res);
      if (!this.authorized(req)) {
        return this.json(res, 401, { ret: -1, errmsg: "unauthorized" });
      }
      if (url.pathname === "/im/send") return await this.handleSend(req, res);
      if (url.pathname === "/im/sync") return await this.handleSync(req, res);
      if (url.pathname === "/im/history") return await this.handleHistory(req, res);
      return this.json(res, 404, { ret: -1, errmsg: "not found" });
    } catch (err) {
      console.error(`[channel/im] 请求处理异常 ${req.method} ${url.pathname}: ${describe(err)}`);
      if (!res.headersSent) this.json(res, 500, { ret: -1, errmsg: describe(err) });
    }
  }

  /**
   * 扫码配对：用一次性配对码换取 baseUrl + token。
   * 免 Bearer 鉴权（见 handle() 里的路由注释），保护靠配对码本身的三重约束。
   */
  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const code = typeof body.code === "string" ? body.code : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!code.trim()) {
      return this.json(res, 400, { ret: -1, errmsg: "missing code" });
    }

    const from = req.socket.remoteAddress ?? "unknown";
    const file = pairingFilePath(this.dataDir);
    const check = verifyPairingCode(file, code);
    if (!check.ok) {
      console.warn(`[channel/im] ❌ 配对被拒（${check.reason}）from ${from}`);
      return this.json(res, 403, { ret: -1, errmsg: `pairing rejected: ${check.reason}` });
    }

    consumePairing(file, deviceId ? `${deviceId}@${from}` : from);
    console.log(`[channel/im] ✅ 配对成功，已发放 token（from ${from}）`);
    this.json(res, 200, {
      ret: 0,
      baseUrl: check.record.publicUrl,
      token: this.token,
      userId: this.defaultUserId,
    });
  }

  /** 上行：app 发消息 → 入 inbox → 唤醒 Bot 的 poll */
  private async handleSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const text = typeof body.text === "string" ? body.text : "";
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const images: InboundImage[] = [];
    for (const img of rawImages) {
      const mime = typeof img?.mime === "string" ? img.mime : "image/jpeg";
      const dataBase64 = typeof img?.dataBase64 === "string" ? img.dataBase64 : "";
      if (dataBase64) images.push({ mime, dataBase64 });
    }
    if (!text.trim() && images.length === 0) {
      return this.json(res, 400, { ret: -1, errmsg: "empty message" });
    }

    const clientMsgId =
      typeof body.clientMsgId === "string" && body.clientMsgId.trim()
        ? body.clientMsgId.trim()
        : crypto.randomUUID();
    const channelUserId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : this.defaultUserId;

    const rec: InboundRecord = {
      seq: ++this.inboundSeq,
      channelUserId,
      clientMsgId,
      text,
      images,
      receivedAt: Date.now(),
    };
    this.inbound.push(rec);
    this.appendJsonl(this.inboxPath, rec);
    console.log(`[channel/im] ← ${channelUserId} (seq=${rec.seq}, ${text.slice(0, 60) || `[图片 x${images.length}]`})`);
    this.wake(); // 唤醒 Bot 的 poll
    this.json(res, 200, { ret: 0, seq: rec.seq, clientMsgId });
  }

  /** 下行：app 长轮询拉机器人消息（承接 getUpdates 长轮询语义） */
  private async handleSync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const cursorRaw = body.cursor === undefined || body.cursor === null ? "" : String(body.cursor);
    const since = cursorRaw ? Number(cursorRaw) || 0 : 0;

    let pending = this.outbox.filter((m) => m.seq > since);
    if (pending.length === 0) {
      await this.waitForActivity(this.longPollTimeoutMs);
      pending = this.outbox.filter((m) => m.seq > since);
    }

    const cursor = pending.length
      ? String(pending[pending.length - 1].seq)
      : String(Math.max(since, this.outboxSeq));
    this.json(res, 200, { ret: 0, cursor, msgs: pending });
  }

  /**
   * 历史：app 下拉加载更早消息（分页）。
   * 入参（POST body）：
   *   beforeId?: number  —— 只返回 id < beforeId 的消息（更早的）；不传则取最新一页
   *   limit?: number     —— 条数上限（默认 30，最大 100）
   * 出参：{ ret, msgs }，msgs 按 id 升序排列（与 sync 的 outbox 形态一致）。
   */
  private async handleHistory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const beforeId = typeof body.beforeId === "number" ? body.beforeId : undefined;
    const limitRaw = typeof body.limit === "number" ? body.limit : 30;
    const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)));
    if (!this.historyReader) {
      return this.json(res, 200, { ret: 0, msgs: [] });
    }
    const rows = this.historyReader({ beforeId, limit });
    this.json(res, 200, { ret: 0, msgs: rows });
  }

  // ------------------------------------------------------------------ 工具

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const got = Buffer.from(m[1].trim());
    const want = Buffer.from(this.token);
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(got, want);
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`请求体不是合法 JSON: ${describe(err)}`));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function readJsonl<T>(file: string): T[] {
  try {
    if (!fs.existsSync(file)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // 半行（进程被杀时最后一行可能截断）→ 跳过
      }
    }
    return out;
  } catch (err) {
    console.warn(`[channel/im] 读取 ${file} 失败（按空处理）: ${describe(err)}`);
    return [];
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
