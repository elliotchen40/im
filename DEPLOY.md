# DEPLOY.md — im 项目部署

> 规范：`PROJECTS.md` 开头第 6 条 —— **项目级部署信息一律记在项目目录的 `DEPLOY.md`**；
> 详细步骤本文不重复（避免双份维护），只做**单一入口 + 关键事实速查**。

---

## 当前部署状态（2026-09-12 · 已部署到 112）

| 项 | 值 |
|---|---|
| **生产机** | `10.168.3.112`（ARM64 / Armbian 25.11.2 jammy，node v22.22.1） |
| **代码路径** | `/opt/im/server` |
| **systemd** | `im-server.service` ✅ **active (running)** · **enabled**（开机自启） |
| **监听** | **`127.0.0.1:8787`**（仅本机 —— 对外靠 cloudflared 隧道） |
| **数据目录** | `/opt/im/server/data/` |
| **日志** | `/var/log/im-server.log` |
| **配置** | `/opt/im/server/.env`（权限 600；模型 / embedding key 复用同机 `/opt/wx-robot/.env`） |
| **端到端** | ✅ 已实测：发消息 → **真实 DeepSeek 回复**（ASHLEY 人格）→ 落库 user+assistant 双写 |
| cloudflared 隧道 | ⏳ **待接入**（由 Elliot 在 112 上建，方案见下） |
| `IM_PUBLIC_URL` | ⏳ 待域名确定后设置（不设会导致配对二维码回落到局域网地址） |
| 首次配对 | ⏳ 未执行 |

### 112 上的邻居（部署时需避让）

| 项目 | 端口 | 服务 | 需要隧道? |
|---|---|---|---|
| ourworld | 8000 | `ourworld.service`（active） | ✅ 用**现有** cloudflared（`aplacecalledus.top`） |
| hitch | — | `hitch.service`（active） | ❌ 不需要（iLink 主动连出） |
| wx-robot | — | `wx-robot.service`（**当前 inactive**） | ❌ 不需要 |
| **im** | **8787** | **`im-server.service`**（active） | ✅ **需要**（HTTP API） |

- 现有 cloudflared 是**单隧道多 hostname** 模式：隧道 `ourworld`(`9b522f12-…`)，配置在
  **`/root/.cloudflared/config.yml`**（注意：**不是** `/etc/cloudflared/`）
- 端口 8787 与三者都不冲突；改 cloudflared 时**只新增 im 的 ingress，别动已有那 5 条**

### 部署命令（复现用）

```bash
# 本机 → 112：本机容器**没有 rsync**，用 tar + ssh 管道
tar czf - --exclude='server/node_modules' --exclude='server/data' --exclude='server/.env' \
  --exclude='server/dist' server | \
  sshpass -p '<password>' ssh -o StrictHostKeyChecking=no root@10.168.3.112 \
  "mkdir -p /opt/im && tar xzf - -C /opt/im"

# 112 上：装依赖 → 构建 → 装服务
cd /opt/im/server && npm install --no-audit --no-fund && npm run build
cp deploy/im-server.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now im-server
```

---

## 隧道接入（待做，避免与 ourworld 冲突）

**方案 A：复用现有隧道 + 加一条 ingress**（省一个进程）

```bash
# 1) 给现有隧道加 DNS 记录
cloudflared tunnel route dns ourworld im.example.com

# 2) 编辑 /root/.cloudflared/config.yml，在最后的 http_status:404 之前插入：
#      - hostname: im.example.com
#        service: http://localhost:8787

# 3) 重启（会有几秒影响到 ourworld 的隧道）
systemctl restart cloudflared
```

**方案 B：独立隧道 + 独立服务**（互不影响，生产更稳）

```bash
cloudflared tunnel create im
cloudflared tunnel route dns im im.example.com

# 写独立配置 /root/.cloudflared/im-config.yml，再建 cloudflared-im.service：
#   ExecStart=/usr/local/bin/cloudflared tunnel --config /root/.cloudflared/im-config.yml run
```

> ℹ️ 隧道列表里已有一条**今天新建的 `echomindim`**（无连接）——
> 若那是为 im 准备的，方案 B 直接复用它的凭据即可。

**接好后必做**：

```bash
# 1) 设 IM_PUBLIC_URL 并重启（漏了这步：扫码后 app 拿到的是局域网地址，出门连不上）
echo "IM_PUBLIC_URL=https://你的域名" >> /opt/im/server/.env
systemctl restart im-server

# 2) 四层验证
curl http://127.0.0.1:8787/im/health          # 在 112 上
curl https://你的域名/im/health               # 在 112 上
#   再用手机浏览器打开同一个 https 地址
#   最后 app 扫码

# 3) 出配对二维码
cd /opt/im/server && npm run pair
```

> ⚠️ **不要**给这个域名开 Cloudflare Access —— 它要求浏览器登录，
> 会把只发 Bearer token 的 app 挡在门外。

---

## 部署物（仓库里）

| 文件 | 作用 |
|---|---|
| `server/deploy/im-server.service` | systemd 单元（`Restart=always`、SIGTERM 下 30s 优雅退出、日志 `/var/log/im-server.log`；风格与同机 `hitch.service` 一致） |
| `server/deploy/cloudflared-config.yml` | 独立隧道场景的配置模板 |
| `server/scripts/verify.sh` | 一键验证（守门 → 安装 → 类型检查 → 端到端），真实 key 场景 |
| `server/scripts/mock_provider.mjs` | 本地假 LLM + 假 embedding，**零费用零外网**跑通链路 |

---

## 关键事实（速查）

| 项 | 值 |
|---|---|
| **端口** | `8787`（`IM_HTTP_PORT`）；112 上仅听 `127.0.0.1` |
| **cloudflared** | ✅ **需要** —— 方向与 iLink 相反（手机主动连服务端），**必须有 TLS** |
| 运行形态 | `npm run build` → `node --env-file=.env dist/index.js`（生产不必带 tsx） |
| 必填环境变量 | `IM_APP_TOKEN`、`MODEL_<NAME>_API_KEY`、`SILICONFLOW_API_KEY` |
| **隧道场景必改两项** | `IM_BIND_HOST=127.0.0.1` + `IM_PUBLIC_URL=https://你的域名` |
| 数据目录 | `/opt/im/server/data/` —— `im_bot.db`（users）+ `soul/wx_bot_*.db`（会话/记忆）+ `im/`（渠道队列） |
| 备份 | `tar czf im-backup-$(date +%F).tgz -C /opt/im/server data/` |
| 接管上游数据 | `IM_BOT_DB_PATH` 指向 wx-robot 的 `wx_bot.db`（schema 完全一致，per-SOUL DB 同名） |
| 配对（无需手填 token） | 服务器跑 `npm run pair` 出二维码 → app「扫码登录」 |
| 健康检查 | `curl http://127.0.0.1:8787/im/health` |
| 常用运维 | `systemctl status im-server` · `tail -f /var/log/im-server.log` · `systemctl restart im-server` |

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

- [x] 选机器（112）+ 同步代码 + `npm install && npm run build`
- [x] 装 `im-server.service` 并启动（active；未影响 hitch / ourworld / cloudflared）
- [x] 端到端实测（真实 LLM + 落库双写）
- [ ] **隧道接入**（Elliot 在 112 上建；方案 A/B 见上）
- [ ] 设 `IM_PUBLIC_URL` + 重启 + 四层验证
- [ ] `npm run pair` + app 扫码 → 首次对话
- [ ] 观察 24h 日志（主动关怀 tick / summarizer 触发）
