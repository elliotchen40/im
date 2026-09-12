# im 架构总览与迁移映射

> 上游：`projects/wx-robot-ilink/claude_workspace/wx-robot-ilink`（Node 22 + TS 5.8，HEAD `a1fc284`）
> 目标：保留内核（对话 / 记忆 / 人格 / 关怀），把「微信 iLink 渠道」换成「自研 IM 协议 + 鸿蒙客户端」

---

## 1. 分层

```
┌────────────────────────────────────────────────────────────┐
│ 鸿蒙 app（app/entry/src/main/ets/）                        │
│   pages/Index.ets      聊天 UI（气泡 / 主动关怀 / 扫码登录）│
│   services/ImClient.ets 协议客户端（长轮询 + 发送）         │
│   services/Pairing.ets 扫码配对（ScanKit + /im/pair）      │
│   services/AppConfig.ets preferences（地址/token/cursor）   │
│   model/Message.ets    消息模型                             │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTP + Bearer token
                            │ POST /im/sync（长轮询，游标）
                            │ POST /im/send（幂等键）
                            │ POST /im/pair（扫码配对，免 Bearer）
┌───────────────────────────▼────────────────────────────────┐
│ 服务端（server/src/）                                       │
│   channel/http_channel.ts  ★自研 IM 协议（取代 weixin/）    │
│   channel/types.ts         Channel / Inbound / Outbound     │
│   pair/pairing.ts          一次性配对码状态机               │
│   pair/pair_cli.ts         npm run pair（终端二维码）       │
│   index.ts                 启动装配（渠道 → DB → 自检 → Bot）│
│   bot.ts                   主循环 + 消息分发 + 命令路由      │
│   commands.ts              /model /memory /status 等格式化   │
│   care/scheduled_tick.ts   主动关怀调度（独立 setInterval）  │
│   ─────────── 以下与上游同构 ───────────                    │
│   ai/chat.ts               OpenAI 兼容对话（多模型）        │
│   memory/db.ts             SQLite 6 表 + per-SOUL 隔离      │
│   memory/retrieve.ts       向量检索（Top-K / 阈值 / fallback）│
│   memory/summarize.ts      摘要 + fact 抽取 + 门控          │
│   memory/embed.ts          SiliconFlow bge-m3              │
│   memory/soul_handshake.ts /soul 握手状态机                 │
│   care/{detector,trigger,guard,generator,scheduler,...}.ts  │
└────────────────────────────────────────────────────────────┘
   部署：server/deploy/{im-server.service, cloudflared-config.yml}
```

**关键约束**：`bot.ts` 只依赖 `channel/types.ts` 的 `Channel` 接口。
新增渠道（例如以后想再接回微信、或接 Telegram）= 新增一个实现类，内核零改动。

---

## 2. 迁移映射（上游 → im）

| 上游文件/能力 | im 处理 | 说明 |
|---|---|---|
| `weixin/auth.ts`（扫码登录 125 行） | ❌ 删除 | 改为静态 `IM_APP_TOKEN`；`--logout` 参数改为提示 |
| `weixin/api.ts: getUpdates` | ✅ `HttpChannel.poll(cursor)` | 保留增量游标语义 → `ChannelPollResult.cursor` |
| `weixin/api.ts: sendTextMessage` | ✅ `HttpChannel.send(to, msg)` | `context_token` → `replyContext` |
| `weixin/api.ts: isIlinkFailure` / `IlinkApiError` | ✅ `ChannelPollFailure.code` | `errcode -14` → `"session_expired"` |
| `weixin/api.ts: extractTextFromMessage` | ✅ 渠道层归一化 | → `InboundMessage.text` |
| `weixin/api.ts: downloadImage`（CDN + AES-128-ECB） | ✅ 渠道层归一化 | → `InboundMessage.images[{mime,dataBase64}]` |
| `weixin/types.ts`（MessageType 等） | ❌ 删除 | 协议自研，不再需要 iLink 常量 |
| `bot.ts` 的 14 处渠道耦合 | ✅ 全部改走 `Channel` | `credentials` → `channel`；`getUpdatesBuf` → `syncCursor` |
| `index.ts: login()` | ✅ `new HttpChannel(...).start()` | 关机增加 `channel.stop()` |
| `ai/` `memory/` `care/` `soul/` | ✅ 原样移植 | 与上游同构，仅注释中文化 |
| `bot.ts`（826 行） | ✅ 拆分 | 命令/格式化 → `commands.ts`；care tick → `care/scheduled_tick.ts`；现 621 行 |
| `package.json` | ✅ 改名 `im-server` | 移除 `qrcode-terminal`、`@types/qrcode-terminal` |
| `WX_BOT_DB_PATH` | ✅ `IM_BOT_DB_PATH` 优先 + 回落 | 可直接接管上游既有 DB |

---

## 3. 数据兼容

| 项 | 上游 | im | 兼容性 |
|---|---|---|---|
| shared DB | `data/wx_bot.db` | `data/im_bot.db`（可由 `WX_BOT_DB_PATH` 指向旧文件） | ✅ schema 完全一致 |
| per-SOUL DB | `data/soul/wx_bot_<NAME>.db` | 同名 | ✅ 直接复用 |
| 会话游标 | `getupdates_buf_*.json`（`get_updates_buf` 字段） | `sync_cursor_im.json`（`cursor` 字段） | ✅ `loadSyncCursor()` 兼容旧字段名 |
| 渠道 inbox/outbox | — | `data/im/{inbox.jsonl,inbox.ack,outbox.jsonl}` | 新增 |
| 凭证 | `data/credentials.json` | — | 删除（改用静态 token） |

**迁移步骤**：把上游 `data/` 拷到 `server/data/`，`.env` 里把 `WX_BOT_DB_PATH` 指向
`data/wx_bot.db`（或把文件改名为 `im_bot.db`），配好 `IM_APP_TOKEN` 即可继续使用历史记忆。

---

## 4. 一致性债务（有意保留）

| 项 | 原因 | 计划 |
|---|---|---|
| DB 列名 `users.wechat_user_id` | 改列名需数据迁移，破坏既有 DB 兼容 | P2 做迁移时一并改 |
| `dialogues.channel` 默认值 `'wechat'` | 同上；验证已实测新写入仍为 `'wechat'` | P2：改为渠道名 `'im'` |
| SOUL DB 文件名 `wx_bot_<NAME>.db` | 复用既有数据 | 保留 |
| `care/scheduler.ts` 的 `wechatUserId` 字段名 | care 模块内部接口，改名会扩散改动 | P2 统一为 `channelUserId` |
| `bot.ts: this.summarizer: any` | 上游为测试 stub 留的口子 | 引入 `SummarizerLike` 接口收敛 |

---

## 5. 验证状态与方式

| 项 | 状态 |
|---|---|
| 规格与协议文档 | ✅ 已完成 |
| `npm install` | ✅ 通过（46 个包） |
| `tsc --noEmit` | ✅ **零错误通过** |
| 静态一致性守门 `scripts/check_imports.mjs` | ✅ 22 个 `.ts` / 88 条相对 import，零断链、零 `weixin` 残留 |
| 端到端 `/im/health` + `/im/send` + `/im/sync` | ✅ 通过（本地 mock provider，零费用零外网） |
| 落库校验 `users` / `sessions` / `dialogues` | ✅ 双写成对（user + assistant） |
| 重启保持（cursor + outbox + session 延续） | ✅ 通过（并借此项验证发现并修复 1 个启动期缺陷，见下） |
| **扫码配对** `/im/pair`：正确码 | ✅ 200 → `{baseUrl, token, userId}` |
| 扫码配对：重复 / 过期 / 限次 / 无配对 / 错码 / 缺参 | ✅ 403 `used` / `expired` / `too_many_attempts` / `no_pairing` / `bad_code`；400 `missing code` |
| 配对**未**放宽受保护端点（`/im/sync` 无 Bearer） | ✅ 401 |
| 鸿蒙 `hvigorw assembleHap` | ✅ 通过（v0.2.1 在装有 DevEco Studio 26.0.0 的 Mac 上实编，见 `versions.md`） |

### 验证中发现并修复的真实缺陷

`HttpChannel.loadState()`：inbox 被 ack 压缩后文件里没有行，于是重启后 `inboundSeq` 从 0 重算，
新消息拿到 `seq=1`；而 Bot 的游标已从 `sync_cursor_im.json` 恢复为 `2`，
`poll()` 的 `seq > since` 判为假 → **重启后所有新消息被静默丢弃**（入队有日志、但 Bot 永远取不到）。

修复：以 ack 作为下界，保证上行序号跨重启单调递增 ——

```ts
this.inboundSeq = Math.max(this.inboundSeq, this.inboundAckSeq);
```

修复前后实测对比：

| | 重启后发消息 | `/im/sync` | dialogues |
|---|---|---|---|
| 修复前 | `seq=1` | `msgs: []`（消息丢失） | 仍为 4 条 |
| 修复后 | `seq=3` | 正常返回回复 | 4 → 6 条，session 仍为 1 |

> 这个缺陷只有「真重启一次」才能暴露 —— 单跑一次接口测不出来。

### 如何复现本验证

验证环境完全自包含（本地 mock LLM/embedding，不访问外网、不产生费用）：

```bash
cd server
npm install

# 终端 1：本地 mock provider（假 LLM + 假 embedding，1024 维归一化向量）
npm run mock

# 终端 2：用验证专用配置起 daemon（独立 shared DB：data/verify_im.db）
npm run dev:verify

# 终端 3：跑三项接口
T=verify-token-0123456789abcdef
curl -fsS http://127.0.0.1:8787/im/health
curl -fsS -X POST http://127.0.0.1:8787/im/send -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"text":"你好"}'
curl -fsS -X POST http://127.0.0.1:8787/im/sync -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"cursor":""}'
```

生产环境（真实模型 key）用 `.env` + 一键脚本：

```bash
cd server
cp .env.example .env   # 填 IM_APP_TOKEN / 模型 key / SILICONFLOW_API_KEY
./scripts/verify.sh
```

**验收基线**（等价上游 v3.0 UAT）见 `docs/spec/capability-spec.md` §11。

---

## 6. 验证产物的清理

`.env.verify` 把 shared DB 指到了 `data/verify_im.db`，但 **per-SOUL DB 仍落在默认的
`data/soul/wx_bot_ASHLEY.db`**（`SOUL_DATA_DIR` 未在 `.env.verify` 中隔离）。
如果这台机器之后要正式使用，先清掉验证产生的 `data/`，
或在 `.env.verify` 里补 `SOUL_DATA_DIR=./data/verify_soul` 做完全隔离。
