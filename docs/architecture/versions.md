# 版本登记

> 规范见 `AGENTS.md` §6：重大改动前快照 `server/src`，并在此登记「核心改动 / 已知限制」。

| 版本 | 时间 | 描述 | 已知限制 |
|---|---|---|---|
| `v0.1.0` | 2026-09-12 | **骨架 + 渠道抽象 + 端到端验证**：im 项目建立；上游 wx-robot-ilink 内核（ai/memory/care/soul）全套移植；新增 `channel/` 抽象层与 `HttpChannel` 自研 IM 协议实现；`bot.ts` 14 处渠道耦合清零并拆分为 `commands.ts` + `care/scheduled_tick.ts`；能力规格与协议规范落盘；鸿蒙 ArkTS 工程骨架；服务端通过类型检查与端到端闭环验证（含重启保持），并修复 1 个启动期缺陷 | ① 鸿蒙工程未经 DevEco 编译 ② 无 WS 推送 / E2E 加密 / 多设备 ③ DB 命名债务未清（`wechat_user_id` / `channel='wechat'`）④ 主动关怀 / SOUL 切换 / summarizer 未做端到端 UAT |

| `v0.2.1` | 2026-09-12 | **鸿蒙工程实编通过**：在 DevEco Studio 26.0.0（hvigor 6.26.4 / SDK API 26）上执行 `hvigorw assembleHap` 成功；修复 `Pairing.ets` 的无类型对象字面量（`arkts-no-untyped-obj-literals`）；补 `app/hvigor/hvigor-config.json5` 使命令行也能构建 | ① 产物未签名（装机需 DevEco 自动签名 + 华为账号）② 10 条 ArkTS WARN 未清（deprecated API / may-throw）③ 未做真机联调 ④ 无 WS 推送 / E2E 加密 / 多设备 ⑤ DB 命名债务未清 |

| `v0.2.0` | 2026-09-12 | **扫码登录 + 工程可编译 + 部署物**：新增扫码配对（`/im/pair` + `npm run pair` 二维码 CLI，一次性 / 5 分钟 / 失败限次）；鸿蒙工程补上 AppScope 等硬阻塞项（原先缺失导致 DevEco 打不开工程）、图标改真实 PNG、ImClient 按 ArkTS 约束加固、新增扫码登录面板与 Pairing 服务；服务端部署物（systemd 单元 + cloudflared 模板）与四份部署文档 | ① 鸿蒙工程仍未在 DevEco 实编 ② 无 WS 推送 / E2E 加密 / 多设备 ③ DB 命名债务未清 ④ 主动关怀 / SOUL 切换 / summarizer 未做端到端 UAT |

---

## v0.2.1 明细

### 核心改动

1. **ArkTS 编译阻塞修复**：`app/entry/src/main/ets/services/Pairing.ets` 的
   `const body: Record<string, string> = {...}` 改为显式 `interface PairBody` ——
   ArkTS 禁止无类型对象字面量（`arkts-no-untyped-obj-literals`，错误码 10605038）。
2. **补 `app/hvigor/hvigor-config.json5`**（`modelVersion: 5.0.0`）：DevEco 首次打开工程会生成，
   命令行构建同样需要；缺失时 hvigor 直接报 `00304004 Not Found`。
3. **构建环境事实（留档）**：hvigor 的 `PackageHap` 用 `java -jar app_packing_tool.jar` 打包 ——
   本机 `java` 不可用（macOS 未装 JDK）时会报 `00308018 Unknown Error / Tools execution failed.`；
   把 `JAVA_HOME` 指向 DevEco 自带 JBR（`<DevEco>/Contents/jbr/Contents/Home`）即可。

### 验证记录

| 项 | 结果 |
|---|---|
| `hvigorw assembleHap --no-daemon`（DevEco 26.0.0 / hvigor 6.26.4 / SDK API 26） | ✅ BUILD SUCCESSFUL |
| 产物 `entry/build/default/outputs/default/entry-default-unsigned.hap` | ✅ 94 KB：`module.json` + `resources.index` + `ets/modules.abc` 等 10 项齐备 |
| ArkTS 编译 | ✅ 0 ERROR / 10 WARN（deprecated API、may-throw 提示；不影响构建） |
| 签名 HAP / 真机安装 | ❌ 未做（需在 DevEco 中登录华为开发者账号生成调试签名） |

---

## v0.2.0 明细

### 核心改动

1. **扫码登录 / 绑定**（取代手填地址 + token）
   - `server/src/pair/pairing.ts`：一次性配对码状态机 —— 生成（8 位、剔除 `I/O/0/1` 易混字符）、
     原子写（`.tmp` + rename）、校验（未过期 / 未使用 / 失败计数）、一次性消费；
     `data/pairing.json` **只存 `sha256(code)`**，不落明文。
   - `server/src/pair/pair_cli.ts`：`npm run pair` 渲染终端二维码
     （`im://pair?u=<地址>&c=<码>`），地址优先取 `IM_PUBLIC_URL`、否则探测局域网 IP；
     启动时先探测 daemon 是否在跑；轮询到配对成功即打印结果并退出。
   - `server/src/channel/http_channel.ts`：新增 `POST /im/pair`，**故意置于鉴权之前** ——
     它的目的就是换 token，保护靠配对码本身；返回 `{ baseUrl, token, userId }`。
   - `app/.../services/Pairing.ets`：ScanKit 扫码 → 解析载荷 → 换 token → 落盘（换绑会清游标）。
   - `app/.../pages/Index.ets`：绑定面板以「扫码登录」为主路径，手填降为备选；顶栏加「重新配对」。

2. **鸿蒙工程补全到可编译**
   - 新增 `app/AppScope/app.json5`（bundleName / versionCode / versionName / icon / label）
     与 `AppScope/resources/` —— 原先 **AppScope 整个缺失**，DevEco 无法打开该工程。
   - `build-profile.json5`：移除 `products[0]` 里引用了空 `signingConfigs` 的无效
     `"signingConfig": "default"`，留给 DevEco 自动签名写入。
   - 图标由文本 svg 占位改为**真实 PNG**（216×216，python3 生成），并删除同名 svg
     以消除 `$media:app_icon` 的歧义。
   - `ImClient.ets`：删除未使用导入、`header` 改内联字面量（对齐官方 `HttpRequestOptions` 示例）、
     补全类型标注；`Pairing.ets` 特意避开 ArkTS 运行时不保证提供的 `URLSearchParams`。

3. **部署物与文档**
   - `server/deploy/im-server.service`：systemd 单元（`Restart=always`、SIGTERM 下 30s 优雅退出、
     日志入 journald、`ProtectSystem=strict` + 仅放开 `data/`）。
   - `server/deploy/cloudflared-config.yml`：命名隧道配置模板。
   - 文档：`next-steps.md`（步骤清单）、`self-host.md`、`cloudflare-tunnel.md`、
     `hosting-and-distribution.md`；README / AGENTS / overview / app/README 同步。

### 验证记录

| 项 | 结果 |
|---|---|
| `tsc --noEmit`（含新增 pair 模块） | ✅ 零错误 |
| `npm run pair` | ✅ 终端出二维码 + 配对码；配对成功后自动退出并打印「✅ 配对成功」 |
| `/im/pair` 正确码 | ✅ 200 → `{baseUrl, token, userId}` |
| 同一个码第二次 | ✅ 403 `used`（一次性生效） |
| 过期码 | ✅ 403 `expired` |
| 失败次数用尽 | ✅ 403 `too_many_attempts` |
| 无进行中配对 / 缺 code | ✅ 403 `no_pairing` / 400 `missing code` |
| `/im/sync` 不带 Bearer | ✅ 401（配对端点**没有**放宽受保护端点） |
| 鸿蒙 `hvigorw assembleHap` | ❌ 未执行（无 DevEco Studio / HarmonyOS SDK） |

---

## v0.1.0 明细

### 核心改动

1. **渠道抽象**（`server/src/channel/`）
   - `types.ts`：`Channel` / `InboundMessage` / `OutboundMessage` / `ChannelPollResult`，
     字段与 iLink 语义一一对应（`channelUserId↔from_user_id`、`clientMsgId↔external_msg_id`、
     `replyContext↔context_token`、`cursor↔get_updates_buf`、`failure.code↔ret/errcode`）。
   - `http_channel.ts`：零第三方依赖（`node:http`）的 IM 协议服务端 —— 三个端点、
     Bearer 鉴权（`timingSafeEqual`）、inbox/outbox JSONL 持久化、长轮询唤醒、
     至少一次投递 + ack 压缩、outbox 保留 1000 条。

2. **Bot 改造**（`server/src/bot.ts`，826 → 621 行）
   - 删除 14 处 `weixin/*` 直连；`credentials` → `channel`；`getUpdatesBuf` → `syncCursor`。
   - 保留上游全部容错逻辑：连续失败 5 次退避、`session_expired` 清游标重连、
     不可自愈时单次告警。

3. **入口改造**（`server/src/index.ts`）
   - `login()` / `clearCredentials()` → `HttpChannel.start()`；关机增加 `channel.stop()`。
   - `resolveStoragePaths()`：`IM_BOT_DB_PATH` 优先、回落 `WX_BOT_DB_PATH`（接管既有 DB）。

4. **模块拆分**：`commands.ts`（命令与格式化，窄依赖注入）、`care/scheduled_tick.ts`（主动关怀 tick）。

5. **鸿蒙客户端**（`app/`）：Stage 模型工程 + 聊天页 + 长轮询客户端 + preferences（地址/token/cursor）。

6. **验证工具链**：
   - `server/scripts/check_imports.mjs` —— 零依赖静态守门（import 断链 / `weixin` 残留 / 关键导出）。
   - `server/scripts/mock_provider.mjs` —— 本地 mock LLM + embedding，端到端验证零费用零外网。
   - `server/.env.verify` + `npm run dev:verify` —— 验证专用配置（独立 shared DB）。
   - `server/scripts/verify.sh` + `npm run verify` —— 一键验证（生产 key 场景）。

### 验证记录

| 项 | 结果 |
|---|---|
| `npm install` | ✅ 通过（46 包） |
| `tsc --noEmit` | ✅ **零错误** |
| 静态守门（22 个 `.ts` / 88 条相对 import） | ✅ 零断链、零 `weixin` 残留 |
| `bot.ts` 完整读回、`weixin` 残留检查 | ✅ 无残留（仅注释提及出处） |
| 端到端 `/im/health` → `/im/send` → `/im/sync` | ✅ 200 / `{"ret":0,"seq":1}` / 回复正常返回 |
| LLM `<think>` 剥离 | ✅ 生效（响应里不含 think 块） |
| 落库 `users` / `sessions` / `dialogues` | ✅ user + assistant 双写成对，`initiator='user'` |
| 重启保持（cursor / outbox / session） | ✅ `已恢复 sync cursor (2)`、`outbox=2 条(seq=2)`、session 仍为 1、dialogues 4 → 6 |
| 鸿蒙 `hvigorw assembleHap` | ❌ 未执行（无 DevEco Studio / HarmonyOS SDK） |

### 验证中发现并修复的缺陷

**`HttpChannel` 重启后新消息被静默丢弃**（启动期缺陷，只有真重启才暴露）

- 现象：重启后 `POST /im/send` 返回 `seq=1`（应为 3）；`/im/sync` 永远返回 `msgs: []`；
  `dialogues` 不再增长。daemon 日志有入队记录（`[channel/im] ← owner (seq=1)`），但 Bot 从未处理。
- 根因：inbox 经 ack 压缩后文件为空 → `loadState()` 里 `inboundSeq` 重算为 0 → 新消息 `seq=1`；
  而 Bot 的游标已从 `sync_cursor_im.json` 恢复到 `2` → `poll()` 的 `seq > since` 为假 → 全部判为已投递。
- 修复：`this.inboundSeq = Math.max(this.inboundSeq, this.inboundAckSeq);`（以 ack 作下界，保证单调）
- 复验：`seq` 变 3、回复正常返回、dialogues 4 → 6、session 仍为 1。

### 未做的验证（下一版）

- 主动关怀链路（D→C→B 触发、静默规则、02:00–06:00 跳过）
- `/soul` 切换后的 DB 隔离与 summarizer 重建
- summarizer 触发（空闲 5min / 硬性 20 条）与 fact 门控的端到端表现
- 图片消息（服务端已支持 base64 入站，鸿蒙端未接入）
- 鸿蒙端 `hvigorw assembleHap` 与真机联调
