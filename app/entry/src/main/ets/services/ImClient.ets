/**
 * im 协议客户端（服务端实现见 server/src/channel/http_channel.ts）。
 *
 * 只做三件事：/im/health 探活、/im/sync 长轮询收消息、/im/send 发消息。
 *
 * 关键点（docs/protocol/im-protocol.md §6）：
 *   - readTimeout 必须 **大于** 服务端长轮询超时（IM_LONG_POLL_TIMEOUT_MS=35s），
 *     这里取 longPollMs + 5s，否则长轮询会被客户端主动掐断，造成「连接频繁断开」。
 *   - sync 返回后（无论有无消息）应立即用新 cursor 再发一次，不要 sleep。
 *   - send 用本地 clientMsgId 作幂等键，超时重发安全。
 */

import { http } from '@kit.NetworkKit';

/** POST /im/sync 响应里的单条消息 */
export interface SyncMsg {
  seq: number;
  channelUserId: string;
  text: string;
  kind: string;
  ts: number;
  serverMsgId: string;
}

/** POST /im/sync 响应 */
export interface SyncResp {
  ret: number;
  cursor: string;
  msgs: SyncMsg[];
  errmsg?: string;
}

/** POST /im/send 响应 */
export interface SendResp {
  ret: number;
  seq: number;
  clientMsgId: string;
  errmsg?: string;
}

interface SyncReq {
  cursor: string;
}

interface SendReq {
  clientMsgId: string;
  text: string;
}

export class ImClient {
  private baseUrl: string;
  private token: string;
  private longPollMs: number;

  constructor(baseUrl: string, token: string, longPollMs: number = 35000) {
    // 去掉末尾斜杠，避免拼出 //im/sync
    let base: string = baseUrl.trim();
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    this.baseUrl = base;
    this.token = token.trim();
    this.longPollMs = longPollMs;
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }

  /** 探活（免鉴权） */
  async health(): Promise<string> {
    return await this.post('/im/health', '{}', 10000);
  }

  /** 长轮询拉取机器人消息：无新消息时服务端会挂起至多 longPollMs */
  async sync(cursor: string): Promise<SyncResp> {
    const body: SyncReq = { cursor: cursor };
    const raw: string = await this.post('/im/sync', JSON.stringify(body), this.longPollMs + 5000);
    return JSON.parse(raw) as SyncResp;
  }

  /** 发消息（clientMsgId 为幂等键，重发安全） */
  async send(text: string, clientMsgId: string): Promise<SendResp> {
    const body: SendReq = { clientMsgId: clientMsgId, text: text };
    const raw: string = await this.post('/im/send', JSON.stringify(body), 15000);
    return JSON.parse(raw) as SendResp;
  }

  private async post(path: string, json: string, readTimeoutMs: number): Promise<string> {
    const client = http.createHttp();
    try {
      // header 用字面量：与官方示例一致，避免 Record<string,string> → Object 的赋值类型风险
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer ' + this.token
        },
        extraData: json,
        connectTimeout: 10000,
        readTimeout: readTimeoutMs,
        expectDataType: http.HttpDataType.STRING
      };
      let resp: http.HttpResponse;
      try {
        resp = await client.request(this.url(path), options);
      } catch (e) {
        // 网络/超时异常在这里收口，再抛回调用方（pollLoop 负责退避重试）
        throw new Error('请求失败：' + (e as Error).message);
      }
      if (resp.responseCode !== 200) {
        throw new Error('HTTP ' + resp.responseCode);
      }
      return resp.result as string;
    } finally {
      client.destroy();
    }
  }
}

/** 生成本地幂等键（时间戳 + 随机数，避免引入 uuid 依赖） */
export function newClientMsgId(): string {
  const rnd: string = Math.floor(Math.random() * 0xFFFFFF).toString(16);
  return 'c-' + Date.now().toString(36) + '-' + rnd;
}
