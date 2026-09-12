/**
 * Channel 抽象层 —— 取代 wx-robot-ilink 的 `src/weixin/` 渠道层。
 *
 * 设计目标：把"渠道"从 Bot 核心逻辑里彻底剥离。原项目的 Bot 直接 import
 * `weixin/api.js`（getUpdates / sendTextMessage / downloadImage / IlinkApiError），
 * 于是"微信"硬编码在业务代码里。这里改为面向接口：
 *
 *   Bot  ──poll(cursor)──▶  Channel  ──▶  具体实现（im / wechat / ...）
 *        ◀──send(to,msg)──
 *
 * 新增渠道 = 新增一个实现类，Bot / memory / care / ai 一行都不用改。
 *
 * 字段命名与 iLink 的对应关系（保持语义可追溯）：
 *   channelUserId  ↔  from_user_id / to_user_id
 *   clientMsgId    ↔  external_msg_id（幂等键，desktop dialogues 表 UNIQUE(channel, external_msg_id)）
 *   replyContext   ↔  context_token
 *   poll 的 cursor ↔  get_updates_buf（增量游标）
 *   failure.code   ↔  ret / errcode（业务层失败，HTTP 200 但 body 报错）
 */

/** 入站图片。渠道负责取回原始字节，Bot 不再关心 CDN / 解密等渠道细节。 */
export interface InboundImage {
  /** MIME，如 image/jpeg、image/png */
  mime: string;
  /** base64 编码的原始字节（不含 `data:` 前缀） */
  dataBase64: string;
}

/** 渠道 → 服务端的一条用户消息 */
export interface InboundMessage {
  /** 渠道侧用户标识（替代 wechat_user_id） */
  channelUserId: string;
  /** 渠道侧消息 ID —— 幂等键，重投同一 ID 不得重复入库 */
  clientMsgId: string;
  /** 纯文本（渠道特有结构如引用块已在此层归一化） */
  text: string;
  /** 同消息附带的图片 */
  images: InboundImage[];
  /** 收到时间（ms epoch） */
  receivedAt: number;
  /** 回复上下文 token（承接 context_token；无则 undefined） */
  replyContext?: string;
  /** 渠道内单调递增序号 */
  seq: number;
}

/** 服务端 → 渠道的一条机器人消息 */
export interface OutboundMessage {
  text: string;
  /** 回复上下文 token，渠道自行决定是否回带 */
  replyContext?: string;
  /** 是否为主动关怀消息（care 系统发起），客户端会特殊展示 */
  proactive?: boolean;
  /** 消息种类标记，默认 reply */
  kind?: "reply" | "proactive" | "command";
}

/**
 * 业务层失败码。
 *   session_expired — 无法自愈，需重新鉴权（对应 iLink errcode -14）
 *   transient       — 可重试
 *   fatal           — 配置/协议错误，重试无意义
 */
export type ChannelFailureCode = "session_expired" | "transient" | "fatal";

export interface ChannelPollFailure {
  code: ChannelFailureCode;
  message: string;
}

export interface ChannelPollResult {
  /** 新的增量游标（承接 get_updates_buf），调用方需持久化后下次回传 */
  cursor: string;
  messages: InboundMessage[];
  /** 非空表示本次轮询在业务层失败（HTTP 层面成功） */
  failure?: ChannelPollFailure;
}

/** 渠道需要提供的能力。Bot 只依赖这一个接口。 */
export interface Channel {
  /** 渠道名，落库到 dialogues.channel 字段（原值固定 'wechat'） */
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 拉取用户消息；cursor 为空串表示"从上次已确认位置继续" */
  poll(cursor: string): Promise<ChannelPollResult>;
  /** 向渠道侧用户发送机器人消息 */
  send(to: string, msg: OutboundMessage): Promise<void>;
}
