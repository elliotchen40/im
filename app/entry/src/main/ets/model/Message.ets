/**
 * 聊天消息模型。
 *
 * 字段映射（见 docs/protocol/im-protocol.md §3.3）：
 *   id      — 我方消息 = 本地 clientMsgId（幂等键）；对方消息 = serverMsgId
 *   kind    — 'reply' | 'proactive' | 'command'，对应服务端 OutboundMessage.kind
 *   pending — 乐观 UI：已本地插入、等待服务端长轮询回包
 */

export enum MessageKind {
  REPLY = 'reply',
  PROACTIVE = 'proactive',
  COMMAND = 'command',
}

@Observed
export class ChatMessage {
  id: string;
  text: string;
  /** true = 我发出的 */
  fromMe: boolean;
  kind: string;
  /** ms epoch */
  ts: number;
  /** 本地乐观展示中（等待服务端回包） */
  pending: boolean;
  /** 发送失败 */
  failed: boolean;

  constructor(
    id: string,
    text: string,
    fromMe: boolean,
    kind: string,
    ts: number,
    pending: boolean = false,
    failed: boolean = false,
  ) {
    this.id = id;
    this.text = text;
    this.fromMe = fromMe;
    this.kind = kind;
    this.ts = ts;
    this.pending = pending;
    this.failed = failed;
  }

  /** 是否为主动关怀消息（服务端 care 系统发起） */
  isProactive(): boolean {
    return this.kind === MessageKind.PROACTIVE;
  }
}
