# im 能力规格 —— 承接 wx-robot-ilink 全功能面

> 本文档是 `im` 项目的**功能规格基线**：把上游 `wx-robot-ilink`（Node 22 + TS 5.8，
> ~5000 LOC）已经实现的全部能力逐项固定下来，作为鸿蒙 app + 服务端重写的验收参照。
>
> 上游源码：`projects/wx-robot-ilink/claude_workspace/wx-robot-ilink`（HEAD `a1fc284`，v1.1.2）
> 本文档不含任何密钥明文。

---

## 0. 一句话定位

上游 = **微信 iLink 长轮询渠道** + **OpenAI 兼容多模型对话** + **SQLite 向量记忆系统** +
**可切换 SOUL 人格** + **LISA 主动关怀** 的极简私人 chatbot。

im = 同一套内核，**渠道层由微信换成自研 IM 协议**（服务端 HTTP 长轮询 + 鸿蒙 app 客户端）。

---

## 1. 运行时架构（已承接）

| 项 | 上游实现 | im 状态 |
|---|---|---|
| 入口 | `src/index.ts`：解析 `--env-file` / `--soul` / `--logout` → 渠道登录 → 初始化 DB → 自检 → 构造 AIChat/Bot → `bot.start()` | ✅ 已改：`login()` 换成 `HttpChannel.start()` |
| 主循环 | 单线程 `while(running)` 长轮询，串行处理同一批消息 | ✅ 原样保留，`getUpdates` → `channel.poll(cursor)` |
| 并发 | 同批消息 `for … await handleMessage` 串行；care 用独立 `setInterval` | ✅ 原样保留 |
| 容错常量 | `MAX_CONSECUTIVE_FAILURES=5`、`RETRY_DELAY_MS=2000`、`BACKOFF_DELAY_MS=30000`、`SESSION_EXPIRED_DELAY_MS=5000` | ✅ 原样保留 |
| 失败判定 | `isIlinkFailure`（`ret`/`errcode` 任一非 0）；`errcode=-14` 清 buf + 5s 重连 | ✅ 抽象为 `failure.code==="session_expired"` |
| 优雅退出 | SIGINT/SIGTERM → `summarizer.flushAllActiveSessions()` → `bot.stop()` → 关 DB | ✅ 增加 `channel.stop()` |
| 外部依赖 | ① 微信 iLink 网关 ② OpenAI 兼容 LLM ③ SiliconFlow embedding | ① 换成自研 IM 服务端；②③ 不变 |
| 存储引擎 | `better-sqlite3`，WAL + `foreign_keys=ON` | ✅ 不变 |

### 启动自检（必须保留）

1. SOUL 文件必须存在（`SYSTEM_PROMPT_FILE`）。
2. SOUL 文件 `trim()` 后 ≥ 50 字符，否则抛错。
3. shared DB 与 SOUL DB 的 `users` 表必须对齐，缺失自动补齐（`INSERT OR IGNORE`）。

---

## 2. 渠道层

上游 `src/weixin/`（3 文件 515 行）职责 → im 等价物：

| 上游能力 | 上游函数 | im 对应 |
|---|---|---|
| 扫码登录 + 凭证持久化 | `auth.ts: login/fetchQRCode/pollQRStatus/saveCredentials/clearCredentials` | ❌ 废弃（改为静态 `IM_APP_TOKEN`） |
| 长轮询收消息 + 增量游标 | `api.ts: getUpdates(baseUrl, token, buf, timeout)` | ✅ `HttpChannel.poll(cursor)` |
| 发文本消息 | `api.ts: sendTextMessage(baseUrl, token, to, text, contextToken?)` | ✅ `HttpChannel.send(to, {text, replyContext})` |
| 业务错误判定 | `isIlinkFailure` / `IlinkApiError.isSessionTimeout` | ✅ `ChannelPollResult.failure.code` |
| 文本提取（含引用块） | `extractTextFromMessage` | ✅ 渠道层归一化为 `InboundMessage.text` |
| 图片列表 / 下载 / AES 解密 | `extractImageItems` / `downloadImage`（`aes-128-ecb` + PKCS7） | ✅ 渠道层归一化为 `InboundMessage.images[{mime,dataBase64}]` |
| 消息类型常量 | `MessageType{USER:1,BOT:2}`、`MessageItemType{TEXT:1,…}` | ❌ 不再需要（协议自研） |
| 回复上下文 token | `context_token`（按 from_user_id 内存 Map） | ✅ `replyContext` 字段，语义一致 |
| 幂等键 | `external_msg_id` → `UNIQUE(channel, external_msg_id)` | ✅ `clientMsgId` |
| 游标落盘 | `data/getupdates_buf_<accountId>.json` | ✅ `data/sync_cursor_im.json` |

**协议细节**见 `docs/protocol/im-protocol.md`。

---

## 3. AI 对话层（`src/ai/`）

### 3.1 AIChat

- 依赖 `openai` SDK，构造参数：`apiKey / baseURL / model / contextLimit / name / systemPrompt`。
- 会话状态：`Map<userId, ChatSession>`（内存），`history` 存 `{role, content}`。
- `chat()` 组装顺序：`[system] + history.slice(0,-1) + liveUserMsg`。
- 图片：live 消息用 `data:<mime>;base64,…`；**history 只存文本标记** `[用户发送了一张图片]`。
- 请求带 `thinking:{type:"disabled"}`（兼容推理模型的思考块开关）。
- 回复后处理：剥离 `/<think>[\s\S]*?<\/think>/g`，压缩空行；为空则回 `（AI 未返回内容）`。
- `getSessionStats()`：`estimatedTokens = ceil(totalChars/3)`（CJK 偏低估）。

### 3.2 多模型 registry（`ai/config.ts`）

- 模式 A（单模型）：`OPENAI_API_KEY/_BASE_URL/_MODEL/_CONTEXT_LIMIT`，别名为 `default`。
- 模式 B（多模型）：扫描 `MODEL_<NAME>_API_KEY`（`NAME` 匹配 `^[A-Z0-9_-]+$`），
  配 `_BASE_URL`/`_MODEL`/`_CONTEXT_LIMIT`；**keys 排序保证确定性**。
- `contextLimit` 默认值：模型名匹配 `deepseek*` / `minimax*` → `1048576`，否则 `16384`。
- 只要出现任一 `MODEL_<NAME>_API_KEY` 即启用多模型模式；两种模式可并存。

### 3.3 历史与截断

- 内存 history 不主动截断；真正截断在 `loadHistoryFromDB` 与 `v2Chat` 的
  `SHORT_TERM_WINDOW_SIZE=20` 切片。
- 冷启动首条消息前会 `loadHistoryFromDB`（daemon 重启后 AI 仍能看到历史）。

### 3.4 错误处理

LLM 调用异常 → 回复固定文案「抱歉，AI 暂时无法回复，请稍后再试。」

---

## 4. 记忆系统（`src/memory/`）

### 4.1 表结构

**shared DB**（`users` 表权威）与 **per-SOUL DB** 分离。

| 表 | 关键字段 | 约束 / 索引 |
|---|---|---|
| `users` | `id PK, wechat_user_id UNIQUE, internal_user_id, display_name, created_at, last_seen_at` | — |
| `sessions` | `id, user_id FK, channel, started_at, last_active_at, is_active, summary_status` | `summary_status ∈ {pending,summarized,flushed}` |
| `dialogues` | `id, session_id FK, user_id, channel, role, content, external_msg_id, tokens, latency_ms, related_summary_id FK, created_at, created_date, initiator` | `UNIQUE(channel, external_msg_id)` 防重投；`role ∈ {user,assistant,system}`；`initiator` 默认 `user`；索引 `(session_id, created_at DESC)` |
| `summaries` | `id, session_id FK, user_id, summary_text, memory_type, importance=5, source_dialogue_ids(JSON), embedding BLOB, embedding_model, created_at, evidence(JSON)` | 索引 `(user_id, created_at DESC)` |
| `memories` | `id, user_id, memory_type, fact, key, importance, embedding, embedding_model, refer_count, last_refer_at, metadata_json, created_at, expires_at, evidence` | `UNIQUE(user_id, key)`；`importance ∈ 1..10`；索引 `(user_id, importance DESC, created_at DESC)` |
| `care_log` | `id, user_id FK, triggered_at, trigger_type, event_type, event_summary, event_signature, severity, message_sent, user_responded=0` | 索引 `(user_id, triggered_at)`、`(user_id, event_signature, triggered_at)` |
| `user_state` | `user_id PK FK, rejection_count=0, permanently_disabled=0, updated_at` | — |

`memories.memory_type` 枚举：`preference / recurring_pattern / milestone / emotional_state /
life_event / action_commitment / safety_flag`。

老库自动迁移：启动时 `ALTER TABLE` 补 `dialogues.initiator` 与 `summaries/memories.evidence`。

### 4.2 embedding

- SiliconFlow `POST {SILICONFLOW_BASE_URL}/embeddings`，模型 `BAAI/bge-m3`，dim `1024`，
  `encoding_format:"float"`，输出 **L2 归一化** `Float32Array`。
- 重试：3 次指数退避（200/400/800ms），30s 超时；4xx（429 除外）不重试。
- Key 缺失或为占位符 `__FILL_IN_BY_LEADER_AFTER_P7__` → 直接抛错。

### 4.3 summarizer（4 种触发）

| 触发 | 条件 | 常量 |
|---|---|---|
| 空闲 | 每条消息后重置 timer | `SUMMARY_IDLE_TIMEOUT_MS=300000` |
| 硬性 | `unsummarized_count ≥ N`（幂等，in-flight 丢弃） | `SUMMARY_HARD_TRIGGER_THRESHOLD=20` |
| `/new` | 同步 flush | — |
| SIGTERM | `flushAllActiveSessions()` | — |

算法：取 `recentDialogues(sessionId, 1000).reverse()` → 过滤 `related_summary_id IS NULL`
→ 调 LLM（`response_format:json_object`，输出 `{summary, facts[{type,fact,key,importance,confidence,evidence_dialogue_id}]}`）
→ **7 项门控（`gate()`）**：

1. `fact` 非空
2. `fact.length ≤ FACT_MAX_LEN=200`
3. `type` ∈ 6 类合法枚举
4. `importance` 夹到 `1..10`
5. `confidence ≥ FACT_CONFIDENCE_GATE=0.6`
6. `evidence_dialogue_id` 必须 ∈ 本轮 user dialogue ids
7. （批次内）cosine `>0.85` 去重，同批次新插入也纳入去重集

→ `insertSummary(evidence=本轮全部 user dialogue ids)` → `markDialoguesSummarized` → 写 memories。

### 4.4 retrieve（检索）

- `TOP_K=5`，`SIMILARITY_THRESHOLD=0.60`（上游 v3.0 收紧；旧模板 0.35 已过松）。
- cosine = 已归一化向量的点积。
- **无 evidence 的 summary/memory `finalScore ×0.5`**（幻觉防护，v1.1 引入）。
- 每组内 `dedupeByCosine`（`DEDUP_THRESHOLD=0.85`）后取 Top-K。
- fallback：`RAW_DIALOGUE_RETRIEVAL=fallback` 且 summaries 命中 `<3` →
  `recentDialogues(sessionId,50)` 重新 embed 检索 `RAW_FALLBACK_TOP_K=10`，返回前按
  `created_at ASC` 重排（`off/always` 可配）。
- 返回值含 `evidenceWeightedCount{withEvidence,withoutEvidence}`。

### 4.5 记忆注入格式（`v2Chat`）

```
system = EVIDENCE_GRADE_NOTICE
       + "\n\n" + SOUL_basePrompt
       + ("\n\n[Memory Retrieval]\n" + header)     # header: summaries=3, memories=2, dialogues=4 (fallback), evidence=4/5
       + PAST_EVENT_VERIFICATION_RULE
```

随后逐条：
- `[Past Summary] …`
- `[Memory:<type>] …`（无 evidence 时前缀 `[基于推断] `）
- fallback dialogues（保留原 `role`）

再拼最近 `SHORT_TERM_WINDOW_SIZE=20` 条内存 history，最后是当前 user（含多模态）。
LLM 回复后**双写 dialogues**（user + assistant）并 push 内存 session，
再 `scheduleIdleFlush` + `maybeHardTrigger`。

---

## 5. SOUL 系统

- 目录 `soul/`：`SOUL_ASHLEY.md`（默认，11975B）、`SOUL_LISA.md`、`SOUL_REVIEW.md`、`SOUL_WRITING.md`。
- 环境变量：`SOUL_DIR=./soul`、`SOUL_SELECT_TIMEOUT_MS=10000`。
- 名字解析 `parseSoulName`：严格匹配 `SOUL_([A-Z0-9_]+)\.md$`，不匹配即抛错（不静默 fallback）。
- DB 路径 `getSoulDbPath(name)`：校验 `^[a-zA-Z0-9_-]+$` → `data/soul/wx_bot_<NAME>.db`。
- `/soul` 握手（`SoulHandshake` 状态机）：
  - `enterWait(fromUser)`：扫描 `SOUL_[a-zA-Z0-9_-]+\.md`（字典序）列序号，起 10s timer。
  - `tryHandleSelection(fromUser, text)`：接受**序号**或**角色名**（大小写不敏感）。
  - 命中 → `atomicWriteEnvSoulPath(newPath)`（写 `.env.tmp` 再 `rename`，保留权限）→ 返回 newPath。
  - 切换成功后 Bot：`init_soul_db(name)` → `swapSoulDb` → `onNewInternal` 自动重启对话。
- **多 SOUL 隔离**：每个 SOUL 一个独立 SQLite（`sessions/dialogues/summaries/memories/care_log/user_state`）；
  `users` 在 shared DB 权威，通过 `ensureUsersInSoulDb` / `ensureOneUserInSoulDb` 复制进各 soul DB 保 FK。
- LISA DB 常驻打开，专供主动关怀，不随 `swapSoulDb` 变化。

---

## 6. 主动关怀（`src/care/`）

| 模块 | 职责 |
|---|---|
| `detector.ts` | 真 LLM 检测（`response_format=json_object`）；5 类事件 + `severity`；解析失败 → `{hasEvent:false}`；输入窗口多档 fallback（当天 ≥10 条用当天，否则最近 10 条 + 长程窗口 merge） |
| `trigger.ts` | 优先级 **D→C→B**：`tryMoodEvent`（`severity≥3`）→ `tryDateEvent`（扫 memories `metadata_json.date` ∈ 未来 7 天，severity=4）→ `tryIdle`（`IDLE_THRESHOLD_MS=4h`，severity=2） |
| `scheduler.ts` | `runCareTick`：全局静默/永久禁 → 24h 频控 → D→C→B 首个命中 → 7 天签名去重 → 切 LISA → 生成 → 发送 → `recordCareLog` → `writeCareDialogue` → push `memSession.history` |
| `generator.ts` | embed `eventSummary` 检索（`sessionId:0`、阈值 0.60）→ 拼 SOUL_LISA + 事件 + 历史材料 → 要求 **≤50 字**、不引用原话；`temperature 0.8`、`max_tokens 200`；失败 fallback 固定文案 |
| `guard.ts` | 常量：`QUIET_HOUR_START=2`、`QUIET_HOUR_END=6`、`DAILY_LIMIT_MS=24h`、`DEDUP_WINDOW_MS=7d`、`REJECTION_THRESHOLD=3`；`hashSignature` = 32 位 hash → `"<eventType>:<base36>"` |
| `dialogue_writer.ts` | 直插 `dialogues(role='assistant', initiator='assistant_initiated', channel='wechat')` |

**事件类型**：`health / emotional / work / relationship / date`，`severity 1-5`，`≥3` 才触发。

**静默规则**：同一事件 7 天去重；用户拒收关键词累计 ≥3 → 永久禁主动
（`RESUME_PATTERNS` 命中「恢复主动通知」可重置）；凌晨 `02:00-06:00` wall-clock 硬跳过。

**拒收检测**（`handleMessage` 内）：`REJECT_PATTERNS = [/别发(了|吧)?/i, /让我静静/i, /够了/i]`。

**调度来源**：`setInterval(CARE_TICK_INTERVAL_MS=4h)`，tick 内再按 `care_log.MAX(triggered_at)` 做 4h 节流；
无 `careChannelUserId`（从未收消息）则跳过。

---

## 7. 命令系统（全部承接）

| 命令 | 语义 |
|---|---|
| `/help` | 列出全部命令 |
| `/model [name]` | 列模型 / 切换（保留历史） |
| `/status` | 当前模型 + 上下文用量 + 消息数 + 会话 ID |
| `/clear` | 清内存 session + 关旧开新 session（落盘数据保留） |
| `/new` | flush summarizer → 关旧开新 session → 重载 `.env` 与模型 |
| `/memory` | 列出记忆 |
| `/memory search <q>` | 向量检索（打印 summaries/memories/dialogues 命中） |
| `/memory del <id>` | 删除某条记忆 |
| `/memory edit <id> <new fact>` | 修改某条记忆（截断 200 字符） |
| `/soul` | 10s 内选序号或角色名切换人格 |

命令处理顺序（`handleMessage`）：`/model` → `/status` → `/clear` → `/new` → `/memory` →
`/help` → `/soul` → **SOUL 握手等待态** → 主对话路径。

CLI 参数：`--logout`（im 已改为提示）、`--soul <NAME>`、`--env-file[=]<path>`。

---

## 8. 配置项清单

**模型**：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`(默认 `gpt-4o`) /
`OPENAI_CONTEXT_LIMIT`；`MODEL_<NAME>_API_KEY` / `_BASE_URL` / `_MODEL` / `_CONTEXT_LIMIT`。

**Prompt**：`SYSTEM_PROMPT`、`SYSTEM_PROMPT_FILE`（默认 `soul/SOUL_ASHLEY.md`，优先）。

**Embedding**：`SILICONFLOW_API_KEY`（必填）、`SILICONFLOW_BASE_URL`（默认
`https://api.siliconflow.cn/v1`）、`SILICONFLOW_EMBEDDING_MODEL`（`BAAI/bge-m3`）、
`SILICONFLOW_EMBEDDING_DIM`（`1024`）。

**检索/记忆**：`TOP_K`(5)、`SIMILARITY_THRESHOLD`(0.60)、`DEDUP_THRESHOLD`(0.85)、
`RAW_DIALOGUE_RETRIEVAL`(fallback)、`SHORT_TERM_WINDOW_SIZE`(20)、
`SUMMARY_HARD_TRIGGER_THRESHOLD`(20)、`SUMMARY_IDLE_TIMEOUT_MS`(300000)、`FACT_CONFIDENCE_GATE`(0.6)。

**路径**：`WX_BOT_DB_PATH`（上游名，默认 `./data/wx_bot.db`）；im 新增 `IM_BOT_DB_PATH`（首选）。
`SOUL_DIR`(./soul)、`SOUL_DATA_DIR`(./data/soul)、`SOUL_SELECT_TIMEOUT_MS`(10000)。

**关怀**：`CARE_TICK_INTERVAL_MS`(14400000)。

**im 新增**：`IM_APP_TOKEN`（必填）、`IM_HTTP_PORT`(8787)、`IM_BIND_HOST`(0.0.0.0)、
`IM_LONG_POLL_TIMEOUT_MS`(35000)、`IM_OWNER_USER_ID`(owner)、`IM_DATA_DIR`。

---

## 9. 数据模型汇总

| 持久化对象 | 路径 | 说明 |
|---|---|---|
| shared DB | `data/wx_bot.db`（im: `data/im_bot.db`） | 仅 `users` 表 |
| per-SOUL DB | `data/soul/wx_bot_<NAME>.db` | 4 张业务表 + care_log + user_state |
| 会话游标 | `data/sync_cursor_im.json` | 增量游标（原 `getupdates_buf_*.json`） |
| 渠道 inbox/outbox | `data/im/{inbox.jsonl,inbox.ack,outbox.jsonl}` | im 新增 |
| 凭证 | ~~`data/credentials.json`~~ | im 不需要（静态 token） |
| SOUL 人设 | `soul/SOUL_*.md` | `/soul` 会原子改写 `.env` 的 `SYSTEM_PROMPT_FILE` 行 |

---

## 10. im 相对上游的变更

### 已改

1. **渠道抽象层** `server/src/channel/`：`types.ts`（`Channel` 接口）+ `http_channel.ts`（自研 IM 协议实现）。
   Bot 不再 import `weixin/*`；`credentials` → `channel`；`downloadImage` → `InboundMessage.images`。
2. **入口** `server/src/index.ts`：删除 `login()`/`clearCredentials()`，改为
   `new HttpChannel(...)` + `await channel.start()`；关机流程增加 `channel.stop()`。
3. **依赖**：上游的扫码登录依赖一度被移除（`qrcode-terminal` 当时只用于渲染微信登录码）；
   后又为**自研扫码配对**重新引入 `qrcode-terminal` + `@types/qrcode-terminal`
   —— 用途从「渲染微信登录二维码」变成「渲染配对二维码（`npm run pair`）」。
4. **路径兼容层** `resolveStoragePaths()`：`IM_BOT_DB_PATH` 优先，回落 `WX_BOT_DB_PATH`
   —— 目的：**可直接接管 wx-robot 既有 DB**（历史会话 / 记忆 / SOUL 数据）。
5. **新增扫码配对**（`server/src/pair/` + `POST /im/pair`）：**渠道侧新增能力，不属上游能力**。
   `npm run pair` 在终端渲染二维码（`im://pair?u=<地址>&c=<码>`），app 扫码后凭一次性配对码换回
   `{baseUrl, token, userId}` 即完成绑定；配对码一次性、5 分钟有效、错 5 次作废，
   `data/pairing.json` 只存 `sha256(code)`。协议见 `docs/protocol/im-protocol.md` §3.4。

### 保留的命名债务（P2 处理）

- DB 列名 `users.wechat_user_id`、`dialogues.channel` 默认值 `'wechat'`：
  改列名需迁移逻辑 + 破坏既有 DB 兼容，v1 保留原样（语义上等同「渠道侧用户标识」）。
- per-SOUL DB 文件名 `wx_bot_<NAME>.db`：保留以便接管既有数据。

### 未承接（设计上不需要）

- 微信 `MessageType` / `MessageItemType` / 二维码登录 / CDN 图片下载 + AES-128-ECB 解密。

---

## 11. 验收基线

移植后必须满足（等价于上游 v3.0 的 UAT）：

- [ ] 发消息 → LLM 回复 → `dialogues` 双写（user + assistant）
- [ ] daemon 重启后首条消息 AI 能看到历史（`loadHistoryFromDB`）
- [ ] 短期窗口 20 条；跨窗口内容靠 retrieve 召回（阈值 0.60）
- [ ] summarizer 空闲 5min / 硬性 20 条触发，fact 门控生效
- [ ] `/soul` 切换后 DB 隔离正确（users 补齐、summarizer 重建、对话重启）
- [ ] 主动关怀：D→C→B 优先级、7 天去重、24h 频控、02:00-06:00 跳过、拒收 ≥3 永久禁
- [ ] 关机 SIGTERM 触发 summarizer flush
