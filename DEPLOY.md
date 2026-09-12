# DEPLOY.md — im 项目部署

> 规范：`PROJECTS.md` 开头第 6 条 —— **项目级部署信息一律记在项目目录的 `DEPLOY.md`**；
> 详细步骤本文不重复（避免双份维护），只做**单一入口 + 关键事实速查**。

---

## 机器拓扑（现行）

| 机器 | 地址 | 角色 | 服务端代码路径 |
|---|---|---|---|
| MacBook（本机） | — | **只做鸿蒙客户端**：DevEco 编译 / 签名 / 装机 | ❌ 不跑服务端 |
| 开发机 | `10.168.3.180`（容器 `fanny`） | 服务端**开发 / 联调**（日常开发在这里） | 容器内 `/.openclaw/team-shared/projects/im` |
| 生产机（**112**） | `10.168.3.112` | 服务端**生产**：systemd 常驻 + cloudflared 隧道 | `/opt/im/server` |

分工是有意的：服务端**不在 MacBook 上跑**（合盖休眠手机就连不上），
MacBook 只负责出 HAP；开发机在容器里迭代，生产机只跑稳定版本。

## 代码怎么过去（只记路径与同步方式，代码本身不入文档）

| 方向 | 方式 |
|---|---|
| 唯一的代码事实源 | GitHub `origin` = `git@github.com:elliotchen40/im.git` |
| MacBook ⇄ 开发机 | 各自 `git pull` / `git push`；开发机在容器 `fanny` 内的 `/.openclaw/team-shared/projects/im` 操作 |
| 开发机 → 生产机 112 | `rsync -a --exclude data/ server/ <user>@10.168.3.112:/opt/im/server/`，或直接在 112 上 `git clone` |
| 首次落生产机 | `sudo mkdir -p /opt/im && sudo cp -r server /opt/im/ && cd /opt/im/server && npm install && npm run build` |

> **绝不跨越 `data/`**：`server/data/` 属于运行它的那台机器（112 有自己的 `im_bot.db` + `soul/wx_bot_*.db`）。

## 当前部署状态

| 项 | 状态 |
|---|---|
| 开发机 `10.168.3.180`（容器 `fanny`） | ✅ 服务端开发环境在此运行 |
| 生产机 112（`10.168.3.112`） | ⬜ 待部署：`/opt/im/server` 尚未建、systemd 未装 |
| cloudflared 隧道 | **未创建** —— 隧道要装在生产机 **112** 上（见下） |
| 域名 | 未绑定 |
| 首次配对 | 未执行 |

---

## 部署物（已在仓库里）

| 文件 | 作用 |
|---|---|
| `server/deploy/im-server.service` | systemd 单元（`Restart=always`、SIGTERM 下 30s 优雅退出、journald 日志、`ProtectSystem=strict` + 仅放开 `data/`）—— 顶部注释有 7 步安装流程 |
| `server/deploy/cloudflared-config.yml` | cloudflared 命名隧道配置模板（替换两处 `REPLACE_WITH_*`） |
| `server/scripts/verify.sh` | 一键验证（守门 → 安装 → 类型检查 → 端到端），用真实 key 场景 |
| `server/scripts/mock_provider.mjs` | 本地假 LLM + 假 embedding，**零费用零外网**跑通链路 |

---

## 步骤入口（详细步骤看这些文档）

| 目标 | 文档 |
|---|---|
| **从零到手机上能聊天**（推荐先看） | `docs/deploy/next-steps.md` |
| 服务端配置 + systemd + DevEco 编译 HAP | `docs/deploy/self-host.md` |
| Cloudflare 隧道（含开发/生产双环境、排错） | `docs/deploy/cloudflare-tunnel.md` |
| 无公网 IP 方案对比 / 上架合规 / 侧载 | `docs/deploy/hosting-and-distribution.md` |

---

## 关键事实（速查）

| 项 | 值 |
|---|---|
| **端口** | `8787`（`IM_HTTP_PORT`） |
| **机器** | 开发机 `10.168.3.180`（容器 `fanny`）· 生产机 **112** = `10.168.3.112` · MacBook 只编译 app |
| **cloudflared** | ✅ **需要**，隧道装/指向**生产机 112**（`10.168.3.112`）—— 手机在外网要连服务端；im 是 HTTP API（不是 iLink 主动连出，与 hitch/wx-robot 不同） |
| 运行形态 | `npm run build` → `node --env-file=.env dist/index.js`（生产不必带 tsx） |
| 必填环境变量 | `IM_APP_TOKEN`（`openssl rand -hex 32`）、`MODEL_<NAME>_API_KEY`、`SILICONFLOW_API_KEY` |
| **隧道场景必改两项** | `IM_BIND_HOST=127.0.0.1` + `IM_PUBLIC_URL=https://你的域名`（后者会被写进配对二维码，**漏改会导致手机出门连不上**） |
| 数据目录 | `server/data/` —— `im_bot.db`（users）+ `soul/wx_bot_*.db`（会话/记忆）+ `im/`（渠道队列） |
| 备份 | `tar czf im-backup-$(date +%F).tgz -C server data/` |
| 接管上游数据 | `IM_BOT_DB_PATH` 指向 wx-robot 的 `wx_bot.db` 即可（schema 完全一致，per-SOUL DB 同名） |
| 配对（无需手填 token） | 服务器跑 `npm run pair` 出二维码 → app「扫码登录」 |
| 健康检查 | `curl http://127.0.0.1:8787/im/health` |

---

## 部署铁律（继承 `LEARNINGS.md` L-2026-0911-5 · `AGENTS.md` C4.7）

```
✅ 推：src/ · deploy/ · scripts/ · soul/*.md · package.json · tsconfig.json · .env · systemd unit
❌ 绝对不动：data/*.db · data/soul/
```

首次部署到无生产数据的机器时，可留 `data.bak.v<version>_pre_<ts>` 备份；
大版本 schema 不兼容时提前写 migration 脚本，**绝不 mv/rm data/**。

---

## 部署待办

- [x] 选机器：开发机 `10.168.3.180`（容器 `fanny`）已在跑；生产机 **112** = `10.168.3.112`
- [ ] 把 `server/` 同步到 112 的 `/opt/im/server`（`rsync` 或 git，**不带 `data/`**）
- [ ] `npm install && npm run build`，装 `im-server.service`
- [ ] `cloudflared tunnel create` + `route dns` + 装 service
- [ ] `.env` 设 `IM_PUBLIC_URL`，重启，四层验证（本机 curl → 隧道 curl → 手机浏览器 → app）
- [ ] `npm run pair` + app 扫码，跑通首次对话
- [ ] 观察 24h 日志（主动关怀 tick / summarizer 触发）
