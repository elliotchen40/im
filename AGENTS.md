# AGENTS.md —— im 项目开发规范

> 本项目承接 `wx-robot-ilink`（`projects/wx-robot-ilink`）的架构与全部功能，
> 把渠道层从微信 iLink 换成自研 IM 协议 + 鸿蒙客户端。
> 规则继承上游 AGENTS.md 的核心约定（快照、守门、留档），并按 im 的现实调整。

---

## 1. 项目边界

| 目录 | 职责 | 语言/栈 |
|---|---|---|
| `server/` | 服务端：对话、记忆、人格、主动关怀、IM 协议实现 | Node 22 + TypeScript 5.8（ESM） |
| `app/` | 鸿蒙客户端：聊天 UI、协议客户端、本地持久化 | ArkTS / ArkUI（Stage 模型） |
| `docs/spec/` | **能力规格**：上游能力逐项锚定，重写的验收依据 | Markdown |
| `docs/protocol/` | 协议规范：改动协议必须先改这里 | Markdown |
| `docs/architecture/` | 架构决策与迁移映射 | Markdown |

**铁律：协议以 `docs/protocol/im-protocol.md` 为准。** 改行为先改文档，再改两端代码。

---

## 2. 架构不变量（改代码前必读）

1. **Bot 不感知渠道**。`server/src/bot.ts` 只依赖 `channel/types.ts` 的 `Channel` 接口。
   新增渠道 = 新增一个实现类，**不得**在 Bot 里写 `if (channel === "im")` 这类分支。
2. **记忆系统的阈值与触发语义是对外契约**。改动 `TOP_K` / `SIMILARITY_THRESHOLD` /
   summarizer 触发条件 / fact 门控，属于行为变更，必须同步 `docs/spec/capability-spec.md`
   并在提交说明里写明理由（上游曾因阈值 0.35→0.60 的调整单独留档）。
3. **per-SOUL DB 隔离不可破坏**。`sessions/dialogues/summaries/memories/care_log/user_state`
   每 SOUL 一套；`users` 表以 shared DB 为权威，跨库写入前必须 `ensureOneUserInSoulDb` 兜底 FK。
4. **幂等键不可省**。所有入站消息必须有 `clientMsgId`，落库走
   `UNIQUE(channel, external_msg_id)` 去重 —— 这是「至少一次投递」安全的前提。
5. **游标只能单调前进**。`poll` 返回的 cursor 必须持久化后回传；不要用 wall-clock 或自增内存计数替代。
6. **配对端点可免鉴权，但不得连带放宽受保护端点**。`POST /im/pair` **故意**排在
   `authorized(req)` 之前（它的用途就是换 token），其安全性完全依赖配对码的三重约束
   （一次性 / 5 分钟有效 / 失败限次，见 `server/src/pair/pairing.ts`）。
   改动路由顺序或配对逻辑后，必须回归验证：`/im/sync`、`/im/send` 不带 Bearer 仍返回 **401**。

---

## 3. 代码约定

- **ESM**：`package.json` 的 `"type": "module"`；相对导入必须带 `.js` 后缀（`Node16` 解析）。
- **TypeScript strict**：`strict: true`，不允许隐式 any；新增代码不得用 `any` 逃逸
  （历史遗留的 `this.summarizer: any` 是上游债，改到再收敛）。
- **注释语言**：中文。保留上游 `P<编号>` 出处标记**仅在被改动的行**上，
  用于说明「这行是为了修什么」，新代码不要发明新的 P 编号。
- **错误处理**：非致命失败一律 `try/catch` + `console.warn` 并继续（daemon 不允许因单条消息崩溃）；
  致命配置问题启动时直接 `throw`（如 `IM_APP_TOKEN` 为空、SOUL 文件缺失）。
- **日志前缀**：`[bot]` / `[channel/im]` / `[memory]` / `[care/...]`，便于 grep 定位。

---

## 4. 验证要求

**服务端**（可本地验证，必须真跑）：

```bash
cd server
npm run typecheck      # tsc --noEmit，必须零错误
npm run dev            # 启动后 curl /im/health 探活
```

**鸿蒙端**（已在装有 DevEco Studio 26.0.0 的 Mac 上验证，完整命令见 `app/README.md §一`）：

```bash
cd app
JAVA_HOME=<DevEco>/Contents/jbr/Contents/Home PATH="$JAVA_HOME/bin:$PATH" \
NODE_HOME=<DevEco>/Contents/tools/node DEVECO_SDK_HOME=<DevEco>/Contents/sdk \
<DevEco>/Contents/tools/hvigor/bin/hvigorw assembleHap --no-daemon
```

- 产物 `entry/build/default/outputs/default/entry-default-unsigned.hap`（**未签名**，
  装机需在 DevEco 里配置自动签名）。
- 提交前仍须人工核对：`module.json5` 权限声明、`oh-package.json5` 依赖、
  ArkTS 语法（不允许 `any`、不允许**无类型对象字面量**、不允许动态属性访问）。

**协议改动**：两端都要改，且必须提供一段 curl 复现（写进 PR/提交说明）。

---

## 5. 数据与密钥

- `.env` **绝不入库**（`.gitignore` 覆盖）。`.env.example` 只放变量名与占位值。
- 日志里不得打印 token、API key、完整消息体（截断到 100 字符）。
- 真实用户数据（`server/data/`）不入库；需要迁移时从上游 `data/` 复制，不提交。

---

## 6. 快照与留档（继承上游 C4.4）

- 重大改动前对 `server/src` 做快照，并在 `docs/architecture/versions.md` 登记：
  版本名 / 时间 / 核心改动 / **已知限制**。
- 版本命名：`v<major>.<minor>.<patch>`，如 `v0.1.0`。
- 每个阶段产出 `P<n>_DONE` 类似的交付说明（放 `docs/architecture/`），
  写清：做了什么 / 没做什么 / 怎么验证的。

---

## 7. 当前阶段与未决

**已完成（v0.2）**：渠道抽象层、IM 协议实现、入口改造、能力规格、协议规范、
**扫码配对**（`/im/pair` + `npm run pair`）、鸿蒙工程补全到可编译、部署物（systemd + cloudflared）与部署文档。

**未决**：

| 项 | 说明 |
|---|---|
| ~~鸿蒙工程实编~~ | ✅ v0.2.1 已在 DevEco Studio 26.0.0 下 `hvigorw assembleHap` 通过（未签名 HAP）；**签名 + 真机安装**仍需在 DevEco 里登录华为账号完成 |
| ScanKit 权限 | 默认扫码 UI 通常不需要相机权限；若某 SDK 版本报权限错误，在 `module.json5` 加 `ohos.permission.CAMERA` |
| 命名债务 | DB 列 `wechat_user_id`、`channel` 默认 `'wechat'`、SOUL DB 文件名 `wx_bot_*.db` 保留上游命名 |
| 真实 key 端到端 | 全链路必须用真实 LLM + SiliconFlow key；无 key 时用 `npm run mock` + `npm run dev:verify` |
| 未做 UAT | 主动关怀链路（D→C→B / 静默 / 凌晨跳过）、`/soul` 切换隔离、summarizer 触发与 fact 门控 |
| 多用户 | 当前单用户（`IM_OWNER_USER_ID`）；**`/im/sync` 未按用户过滤 outbox**，多人/多设备前必须先改这里 |
| WS 推送 / E2E 加密 / 图片消息 | 见 `docs/protocol/im-protocol.md` §7 |

**下一步详细步骤**：见 `docs/deploy/next-steps.md`。
