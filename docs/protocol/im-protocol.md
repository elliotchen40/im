# im 协议规范 v1 —— 自研 IM 渠道

> 取代微信 iLink（`ilink/bot/*`）。服务端实现见 `server/src/channel/http_channel.ts`；
> 鸿蒙客户端实现见 `app/entry/src/main/ets/services/ImClient.ets`。
>
> 设计原则：**与上游 iLink 的 `getUpdates` 长轮询语义 1:1 对应**，这样 Bot 主循环的
> 重试 / 退避 / session 超时自愈逻辑可以原样承接，改造风险最小。

---

## 1. 为什么不是 WebSocket

| 维度 | HTTP 长轮询（选型） | WebSocket |
|---|---|---|
| 与上游语义 | `getUpdates` 本身就是「带游标的长轮询」→ 1:1 | 需重新设计游标与重投 |
| 依赖 | 仅 `node:http`，零第三方包 | 需 `ws`（服务端）+ 客户端重连/心跳状态机 |
| 鸿蒙端 | `@ohos.net.http` 直接可用 | 需自行实现 WS 客户端与半开连接检测 |
| 离线补投 | 天然靠 cursor 补齐 | 需额外补偿逻辑 |

WS 推送通道列为 **P2 增量**（§7），v1 不做。

---

## 2. 传输与鉴权

- 传输：HTTP/1.1，`Content-Type: application/json; charset=utf-8`。
- 鉴权：请求头 `Authorization: Bearer <IM_APP_TOKEN>`。
  - token 由 `openssl rand -hex 32` 生成，两端共享。
  - 服务端用 `crypto.timingSafeEqual` 比较，长度不等直接拒绝。
  - **`IM_APP_TOKEN` 为空时服务端拒绝启动**（不允许裸奔）。
- 未鉴权 → `401 {"ret":-1,"errmsg":"unauthorized"}`。
- 单条请求体上限 `8 MiB`（图片走 base64，按需拆分）。

---

## 3. 端点

### 3.1 `GET /im/health`（免鉴权）

```json
{ "ret": 0, "channel": "im", "outboxSeq": 12, "inboundAck": 9, "pendingInbound": 0 }
```

`outboxSeq` = 下行最新序号；`inboundAck` = Bot 已确认的上行序号；`pendingInbound` = 待 Bot 处理条数。

### 3.2 `POST /im/send` —— 上行（app → 服务端）

请求：
```json
{
  "clientMsgId": "c-7f3a…",          // 可选；缺省服务端生成。幂等键
  "userId": "owner",                 // 可选；缺省用 IM_OWNER_USER_ID
  "text": "今天好累",
  "images": [ {"mime":"image/jpeg","dataBase64":"/9j/4AAQ…"} ]   // 可选
}
```

响应：
```json
{ "ret": 0, "seq": 10, "clientMsgId": "c-7f3a…" }
```

- `text` 与 `images` 同时为空 → `400 {"ret":-1,"errmsg":"empty message"}`。
- 语义：**投递即入队**。服务端持久化到 `inbox.jsonl` 后立即返回，不等 Bot 处理完。
- 幂等：同一 `clientMsgId` 可能因网络重试重复投递 → 由 `dialogues` 表
  `UNIQUE(channel, external_msg_id)` 兜底去重（客户端可安心重试）。

### 3.3 `POST /im/sync` —— 下行（app 长轮询拉取）

请求：
```json
{ "cursor": "9" }        // 空串或省略 = 从最早保留的消息开始（首次全量同步）
```

响应：
```json
{
  "ret": 0,
  "cursor": "12",
  "msgs": [
    { "seq": 10, "channelUserId": "owner", "text": "…", "kind": "reply",
      "ts": 1767000000000, "serverMsgId": "uuid" },
    { "seq": 11, "channelUserId": "owner", "text": "…", "kind": "proactive",
      "ts": 1767000300000, "serverMsgId": "uuid" }
  ]
}
```

- **长轮询**：无新消息时挂起最多 `IM_LONG_POLL_TIMEOUT_MS`（默认 35s），
  期间有新下行消息则立即返回。客户端拿到空 `msgs` 应立刻用新 `cursor` 再次请求。
- `kind`：`reply`（被动回复）/ `proactive`（主动关怀，app 端应特殊展示）/ `command`（命令回执）。
- `cursor` 语义：**已收到的最大 seq**。下次请求回传该值，即可获得其后的所有消息。
- 保留窗口：服务端 `outbox` 保留最近 `OUTBOX_KEEP=1000` 条；超出后从头部淘汰。

### 3.4 `POST /im/pair` —— 扫码配对（免 Bearer 鉴权）

它的作用就是**换取** `IM_APP_TOKEN`，所以不能要求 Bearer；保护手段是「一次性配对码」本身。

**服务器侧出码**（`npm run pair`）会在终端渲染二维码，载荷是一个自定义 scheme：

```
im://pair?u=<公网地址>&c=<一次性配对码>
```

- `u` = 写进二维码的服务端地址：优先 `.env` 的 `IM_PUBLIC_URL`（走隧道时填 `https://你的域名`），
  否则回落到自动探测的局域网 IP + `IM_HTTP_PORT`。
- `c` = 8 位一次性配对码（字符集剔除了 `I/O/0/1` 等易混字符，约 40 bit 熵）。

**app 侧兑换**：

请求：
```json
{ "code": "MZ2CCGNQ", "deviceId": "macbook-test" }
```

响应：
```json
{ "ret": 0, "baseUrl": "https://im.example.com", "token": "<IM_APP_TOKEN>", "userId": "owner" }
```

失败：

| 场景 | HTTP | errmsg |
|---|---|---|
| 没有进行中的配对 | 403 | `pairing rejected: no_pairing` |
| 配对码已过期（默认 5 分钟） | 403 | `pairing rejected: expired` |
| 配对码已被用过 | 403 | `pairing rejected: used` |
| 错误码次数超限（默认 5 次） | 403 | `pairing rejected: too_many_attempts` |
| 配对码不对 | 403 | `pairing rejected: bad_code` |
| 缺 `code` | 400 | `missing code` |

**安全约束**（实现见 `server/src/pair/pairing.ts`）：

1. **一次性**：兑换成功即写 `usedAt`，同一个码再调一律 `used`。
2. **短时效**：`PAIRING_TTL_MS = 5 分钟`。
3. **失败计数**：同一码错 5 次即作废（防爆破）。
4. **只存 hash**：`data/pairing.json` 里只有 `sha256(code)`，不落明文码。
5. **不放大权限**：`/im/sync`、`/im/send` 仍然必须带 `Authorization: Bearer`（实测 401）。

> 为什么不把 token 直接放进二维码：二维码可能被旁人看到、被截图、被转发到群里。
> 一次性 + 短时效的配对码把泄露窗口压到最小，用掉即废。

**文件即 IPC**：CLI 与 daemon 是**两个进程**，用 `data/pairing.json` 共享状态 ——
CLI 写码 → daemon 校验并标记 `usedAt` → CLI 轮询到 `usedAt` 就打印成功并退出。

---

## 4. 投递语义

### 上行（app → Bot）
- 落盘 `inbox.jsonl`（append-only）→ 入内存队列 → 唤醒 Bot 的 `poll`。
- Bot 取走一批后写 `inbox.ack` 记录已确认序号，并把 `inbox.jsonl` 压缩为「未投递」部分。
- 因此是**至少一次**投递：投递后 Bot 崩溃在落库前，重启后会重新收到 → 靠幂等键去重。

### 下行（Bot → app）
- Bot `send(to,msg)` → 分配单调递增 `seq` → append `outbox.jsonl` → 唤醒挂起的 `/im/sync`。
- app 自带 `cursor`，掉线重连后自动补齐缺失消息（等价微信「历史消息」）。
- 服务端重启不丢：`outbox.jsonl` 启动时回读，`outboxSeq` 从最大 seq 继续。

---

## 5. 错误模型

与上游 iLink 的 `ret` / `errcode` 对应，im 用 HTTP 状态码 + body：

| 场景 | HTTP | body | Bot 行为 |
|---|---|---|---|
| 正常 | 200 | `{"ret":0,…}` | 继续 |
| 未鉴权 | 401 | `{"ret":-1,"errmsg":"unauthorized"}` | — |
| 空消息 | 400 | `{"ret":-1,"errmsg":"empty message"}` | — |
| 路由不存在 | 404 | `{"ret":-1,"errmsg":"not found"}` | — |
| 请求体非法/超限 | 500 | `{"ret":-1,"errmsg":"…"}` | — |
| 渠道会话失效 | — | `ChannelPollResult.failure.code = "session_expired"` | 清 cursor + 5s 重连；cursor 已空则 30s 退避并告警 |
| 可重试失败 | — | `code = "transient"` | 2s 重试；连续 5 次 → 30s 退避 |
| 配置错误 | — | `code = "fatal"` | 重试无意义（当前实现按 transient 处理） |

> v1 的 `HttpChannel` 不会主动产生 `failure`（本地网络异常由 Bot 的 try/catch 覆盖）。
> 保留该字段是为了承接上游「HTTP 200 但业务报错」这一层防护，后续接入外网网关/多设备
> 鉴权失效场景时启用。

---

## 6. 客户端实现要点（鸿蒙 ArkTS）

1. **必须用长轮询超时 + 余量**：`@ohos.net.http` 的 `connectTimeout`/`readTimeout` 需 >
   `IM_LONG_POLL_TIMEOUT_MS`（建议 40s），否则长轮询会被客户端主动掐断。
2. **循环**：`sync` 返回（无论有无消息）→ 更新 cursor → 立即再发。空响应不要 sleep，否则有延迟。
3. **本地持久化 cursor**：写入 `preferences`，冷启动恢复 → 实现离线补投。
4. **发送**：`/im/send` 用本地生成的 `clientMsgId`（UUID）；超时重试可安全重发（幂等）。
5. **乐观 UI**：本地先插入 `pending` 气泡（带 `clientMsgId`），`sync` 收到对应回复后替换。
6. **通知**：`kind === "proactive"` 的消息在应用内以「主动关心」样式展示，并可触发本地通知。

---

## 7. P2 增量（未实现）

- **WebSocket 推送通道**：`/im/ws`，消除长轮询的 35s 空转；协议帧沿用本规范 §3.3 的 `msgs` 结构。
- **端到端加密**：当前仅 TLS（部署时由反向代理提供）+ Bearer 鉴权。
- **多设备 / 多用户**：`IM_OWNER_USER_ID` 单用户模式 → `deviceId → userId` 映射表 + per-user token。
- **消息撤回 / 已读回执 / 输入中状态**。
- **富媒体上传**：当前图片走 base64 内联（≤8MiB）；后续改为「预签名 URL + 独立上传端点」。

---

## 8. 部署

```
[鸿蒙 app] ──TLS──> [反向代理 nginx/caddy] ──> [im server:8081]
                                                     │
                                     ┌───────────────┼───────────────┐
                                     ▼               ▼               ▼
                              LLM (OpenAI 兼容)  SiliconFlow     SQLite (WAL)
```

- 服务端默认 `IM_BIND_HOST=0.0.0.0`，**生产必须置于 TLS 反向代理之后**（Bearer token 明文传输不可接受）。
- 健康检查：`GET /im/health`（免鉴权，便于探活）。
- 进程守护：`systemd` 或 `tmux`；`SIGTERM` 触发 graceful shutdown（summarizer flush + 关通道 + 关 DB）。
