# im

> 用**鸿蒙 app** 取代微信作为聊天渠道，承接 `wx-robot-ilink` 的全部架构与能力。
>
> 状态：**v0.2** —— 服务端通过类型检查与端到端闭环验证（含重启保持）；
> 鸿蒙工程已补全到可在 DevEco 直接打开编译（AppScope 等硬阻塞已修）；
> 支持**扫码登录**绑定；部署物（systemd + cloudflared 隧道）与文档就绪。
>
> **要动手部署？直接看 [docs/deploy/next-steps.md](docs/deploy/next-steps.md) —— 保姆级步骤清单。**

---

## 这是什么

上游 `wx-robot-ilink` 是一个极简私人 chatbot：微信 iLink 长轮询 + OpenAI 兼容多模型 +
SQLite 向量记忆 + 可切换 SOUL 人格 + LISA 主动关怀。

**im 把它从微信里搬出来**：内核（对话 / 记忆 / 人格 / 关怀）原样承接，
渠道层换成自研协议 + 自建鸿蒙客户端。这样消息渠道、数据、体验都归自己掌控。

```
┌────────────────────┐        ┌──────────────────────────────┐
│  鸿蒙 app (ArkTS)  │        │  im server (Node 22 + TS)    │
│                    │        │                              │
│  聊天 UI           │  HTTP  │  channel/im  ← 自研协议       │
│  ImClient 长轮询   │◀──────▶│  ├─ /im/sync  (下行长轮询)   │
│  Pairing 扫码配对  │ Bearer │  ├─ /im/send  (上行)         │
│  preferences 游标  │ token  │  └─ /im/pair  (扫码配对)     │
└────────────────────┘        │                              │
                              │  bot.ts   ← 主循环 + 命令    │
                              │  ai/      ← 多模型对话        │
                              │  memory/  ← SQLite 向量记忆   │
                              │  care/    ← 主动关怀          │
                              │  soul/    ← 人格 prompt       │
                              └──────────────────────────────┘
```

---

## 目录

```
im/
├── docs/
│   ├── spec/capability-spec.md      # 能力规格（承接上游全功能面）★先读这个
│   ├── protocol/im-protocol.md      # 自研 IM 协议规范（取代 iLink）
│   ├── architecture/                # 架构总览、迁移映射、版本与验证记录
│   └── deploy/
│       ├── next-steps.md            # ★下一步详细步骤（动手就从这里开始）
│       ├── self-host.md             # 端到端自托管（含 DevEco 编译 HAP）
│       ├── cloudflare-tunnel.md     # 隧道搭建专篇（含开发/生产双环境）
│       └── hosting-and-distribution.md  # 无公网 IP / 上架合规 / 侧载
├── server/                          # 服务端（从 wx-robot-ilink 移植 + 渠道抽象）
│   ├── src/
│   │   ├── channel/                 # ★新增：渠道抽象层
│   │   │   ├── types.ts             #   Channel 接口 / Inbound / Outbound
│   │   │   └── http_channel.ts      #   自研 IM 协议实现 + /im/pair 配对端点
│   │   ├── pair/                    # ★新增：扫码配对
│   │   │   ├── pairing.ts           #   一次性配对码状态机
│   │   │   └── pair_cli.ts          #   npm run pair 的二维码 CLI
│   │   ├── index.ts                 # 入口（渠道启动 + DB + 自检）
│   │   ├── bot.ts                   # 主循环 + 命令分发
│   │   ├── commands.ts              # 命令与文本格式化
│   │   ├── ai/                      # 对话层（多模型 registry）
│   │   ├── memory/                  # 记忆系统（6 表 + 向量检索 + summarizer）
│   │   └── care/                    # 主动关怀（D-C-B 优先级）
│   ├── deploy/                      # ★新增：systemd 单元 + cloudflared 配置模板
│   ├── scripts/                     # 静态守门 / mock provider / 一键验证
│   ├── soul/                        # SOUL 人格 prompt
│   └── .env.example
└── app/                             # 鸿蒙客户端（ArkTS / ArkUI, Stage 模型）
    ├── AppScope/                    # ★应用级配置（bundleName / versionCode / 图标）
    ├── entry/                       # 主模块：聊天页 + 扫码登录 + 协议客户端
    └── README.md                    # ★连到自己的服务器：见这里
```

---

## 快速开始

### 服务端

```bash
cd server
cp .env.example .env
# 填 IM_APP_TOKEN（openssl rand -hex 32）、模型 key、SILICONFLOW_API_KEY
npm install
npm run dev
```

自测：

```bash
# 探活
curl localhost:8787/im/health

# 假装是 app 发一条消息
curl -X POST localhost:8787/im/send \
  -H "Authorization: Bearer $IM_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"你好"}'

# 长轮询收回复
curl -X POST localhost:8787/im/sync \
  -H "Authorization: Bearer $IM_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cursor":""}'
```

命令系统与上游一致：`/help`、`/model`、`/status`、`/clear`、`/new`、`/memory`、`/soul`。

**不想用真实 API key 也想跑通链路**（零费用、零外网、独立 DB）：

```bash
npm run mock        # 终端 1：本地假 LLM + 假 embedding
npm run dev:verify  # 终端 2：用 .env.verify 起 daemon
```

### 鸿蒙 app → 连到你的服务器

一句话：**两端对齐地址与 token**。

**推荐扫码登录**（不用手抄地址和 token）：

1. 服务端 `.env` 里设 `IM_PUBLIC_URL`（走隧道就填 `https://你的域名`）
2. 服务器上运行 `npm run pair` —— 终端出现二维码 + 一次性配对码（5 分钟有效，用过即废）
3. app 首次启动点「**扫码登录**」，对准终端二维码 → 自动拿到地址与 token 并进入聊天

也可以手填（面板下方「或手动填写」）：地址 + `.env` 里的 `IM_APP_TOKEN`。
连不上时，先用**手机浏览器**访问 `/im/health` —— 能分清是网络问题还是 app 问题。

完整步骤（含防火墙、明文 HTTP 限制、Caddy TLS 反代、排查表）见
**[docs/deploy/next-steps.md](docs/deploy/next-steps.md)** 与
**[app/README.md §二 连到自己的服务器](app/README.md)**。

> ⚠️ **不要**把 8787 裸暴露到公网：`Authorization: Bearer <token>` 在明文 HTTP 下可被截获，
> 拿到 token 就等于拿到你的全部对话与记忆。生产请走 TLS 反向代理。

---

## 从 wx-robot-ilink 迁移

im 有意保持与上游**同构**，以便直接接管既有数据：

- DB 路径：`IM_BOT_DB_PATH` 优先，未设置时回落上游的 `WX_BOT_DB_PATH`。
- 数据库 schema、表名、SOUL 目录结构、SOUL DB 文件名（`wx_bot_<NAME>.db`）全部不变。
- 会话游标：新增 `data/sync_cursor_im.json`（原 `getupdates_buf_*.json`），
  `loadSyncCursor()` 兼容读取旧字段名。

即：把上游的 `data/` 拷过来 + 配好渠道 token，历史会话与记忆即可继续使用。

---

## 验证状态

| 项 | 结果 |
|---|---|
| `npm install` / `tsc --noEmit` | ✅ 通过（零错误） |
| 静态守门（22 个 `.ts` / 88 条 import） | ✅ 零断链、零 `weixin` 残留 |
| 端到端 `/im/health` + `/im/send` + `/im/sync` | ✅ 通过 |
| 落库 `users`/`sessions`/`dialogues` | ✅ 双写成对 |
| 重启保持（cursor / outbox / session） | ✅ 通过（并修复 1 个启动期缺陷） |
| 扫码配对 `/im/pair`（换 token / 一次性 / 过期 / 限次 / 未放宽鉴权） | ✅ 全部按预期 |
| 鸿蒙 `hvigorw assembleHap` | ❌ 未执行（无 DevEco Studio / HarmonyOS SDK） |

细节与缺陷记录见 [docs/architecture/overview.md §5](docs/architecture/overview.md) 与
[docs/architecture/versions.md](docs/architecture/versions.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/deploy/next-steps.md](docs/deploy/next-steps.md) | ★**下一步详细步骤**：从备料到手机上能聊天的五阶段清单（含预期输出与四层定位法） |
| [docs/spec/capability-spec.md](docs/spec/capability-spec.md) | 上游全部能力逐项规格化（表结构 / 阈值 / 触发条件 / 注入格式） |
| [docs/protocol/im-protocol.md](docs/protocol/im-protocol.md) | 自研 IM 协议：端点（含 §3.4 扫码配对）、游标、投递语义、错误模型、客户端要点 |
| [docs/architecture/overview.md](docs/architecture/overview.md) | 分层、迁移映射、数据兼容、一致性债务、验证状态与缺陷记录 |
| [docs/architecture/versions.md](docs/architecture/versions.md) | 版本登记与验证记录（v0.1.0 / v0.2.0） |
| [app/README.md](app/README.md) | 鸿蒙客户端：打开工程、连服务器、协议契约、排查 |
| [docs/deploy/self-host.md](docs/deploy/self-host.md) | 端到端自托管：服务端配置与 systemd → cloudflared 隧道 → MacBook 上用 DevEco 编译签名 HAP → 运维 |
| [docs/deploy/cloudflare-tunnel.md](docs/deploy/cloudflare-tunnel.md) | 隧道搭建专篇：域名托管 → 建隧道 → 凭证分发 → 开发/生产双环境（两个子域名）→ 排错 |
| [docs/deploy/hosting-and-distribution.md](docs/deploy/hosting-and-distribution.md) | 无公网 IP 方案对比；上架审核的硬门槛与结论；AGC 内测时效；不上架的侧载路径 |
| [AGENTS.md](AGENTS.md) | 项目开发规范 |
