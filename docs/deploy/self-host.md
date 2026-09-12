# 自托管部署（单机自用 + Cloudflare 隧道）

> 目标：**一台手机自己用**。服务端跑在一台你控制的机器上，
> 不需要公网 IP，通过 Cloudflare Tunnel 暴露成 `https://` 域名，app 侧载安装。
>
> 本项目的实际机器：开发机 `10.168.3.180`（容器 `fanny`，容器内 `/.openclaw/team-shared/projects/im`）、
> 生产机 **112** = `10.168.3.112`（`/opt/im/server`）；**MacBook 只用来编译 HAP**，不跑服务端
> （详见 `DEPLOY.md §机器拓扑`）。
>
> 全程不需要应用市场审核。

---

## 0. 最终形态

```
┌──────────────────────────── 你控制的机器 ────────────────────────────┐
│  im server  (127.0.0.1:8787)                                         │
│     ├── LLM API（OpenAI 兼容）      ← 出网                             │
│     ├── SiliconFlow embedding       ← 出网（记忆检索）                 │
│     └── SQLite data/                ← 本地落盘                        │
│                                                                      │
│  cloudflared ──主动出网──> Cloudflare 边缘 ──> https://im.example.com │
└──────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ HTTPS + Bearer token
                          ┌─────────┴─────────┐
                          │  鸿蒙 app（侧载）  │
                          └───────────────────┘
```

> 放在**常开的机器**上（本项目是生产机 112）。MacBook 合盖休眠时 app 会连不上，所以服务端不放在 MacBook。

---

## 1. 服务端跑起来

### 1.1 准备配置

```bash
cd server
cp .env.example .env
```

`.env` 里最小必填：

```env
IM_APP_TOKEN=<openssl rand -hex 32>     # 两端共享密钥，必须与 app 端一致
IM_BIND_HOST=127.0.0.1                  # 只监听本机，公网入口交给隧道
IM_HTTP_PORT=8787

MODEL_DSF_API_KEY=sk-xxx                # 模型 key（任意 OpenAI 兼容 provider）
MODEL_DSF_BASE_URL=https://api.deepseek.com
MODEL_DSF_MODEL=deepseek-chat

SILICONFLOW_API_KEY=sk-xxx              # 记忆检索 embedding（必填，缺失会直接抛错）
```

### 1.2 本机先自测（不经过隧道）

```bash
npm install
npm run dev
# 另开一个终端：
curl http://127.0.0.1:8787/im/health
```

看到 `{"ret":0,"channel":"im",...}` 就说明服务端活着。

**没有真实 key 也想验证链路**（零费用、零外网）：

```bash
npm run mock        # 终端 1：本地假 LLM + 假 embedding
npm run dev:verify  # 终端 2：用 .env.verify 起 daemon（独立 DB：data/verify_im.db）
```

### 1.3 常驻运行（Linux）

```bash
# 编译成 js（生产不必带 tsx）
npm run build

# 按 deploy/im-server.service 顶部注释的 7 步安装
sudo cp deploy/im-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now im-server
systemctl status im-server
journalctl -u im-server -f
```

macOS 上用 `launchd` 或 `brew services` 均可；最简单的临时方案是 `nohup`：

```bash
nohup npm start > /tmp/im-server.log 2>&1 &
```

---

## 2. Cloudflare 隧道

```bash
# macOS
brew install cloudflared

# 登录 + 建隧道 + 绑域名
cloudflared tunnel login
cloudflared tunnel create im                     # 记下 Tunnel ID
cloudflared tunnel route dns im im.example.com   # 换成你的域名

# 配置：把两处 REPLACE_WITH_* 换成上面的 Tunnel ID
sudo mkdir -p /etc/cloudflared
sudo cp server/deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo vi /etc/cloudflared/config.yml

# 常驻
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

验证：

```bash
curl https://im.example.com/im/health
```

> ⚠️ 两点（详见 `docs/deploy/hosting-and-distribution.md` §2）：
> - **不要**给这个域名开 Cloudflare Access —— 它要求浏览器登录，会把只发 Bearer token 的 app 挡在门外。
> - 免费版对「源站静默」约 100s 硬超时（524）。我们的长轮询是 **35s**，安全；
>   但别把 `IM_LONG_POLL_TIMEOUT_MS` 调到 ≥100s。

**要分「开发机 / 生产机」两个环境？** 一个主机名只能指向一条隧道，所以得用两个子域名
（`im-dev.example.com` → 开发机，`im.example.com` → 生产机）。
分步流程、凭证分发、四层验证与排错见
**[docs/deploy/cloudflare-tunnel.md](cloudflare-tunnel.md)**。

---

## 3. MacBook 上把 app 编译成 HAP

### 3.1 装 DevEco Studio

从华为开发者官网下载 **DevEco Studio**（macOS 版，支持 Intel 与 Apple Silicon），
安装时勾选 **HarmonyOS SDK**。

首次启动需登录**华为开发者账号**（个人账号实名认证后即可，免费）。

### 3.2 打开工程

`Open Project` → 选择本仓库的 **`im/app`** 目录（不是仓库根目录）。

首次打开会自动同步 hvigor（可能生成 `hvigorw`、`hvigor/hvigor-config.json5`、`oh-package-lock.json5`），
等进度条跑完。

> 若提示 `compatibleSdkVersion` 与本机 SDK 不匹配：
> 打开 `app/build-profile.json5`，把 `"compatibleSdkVersion": "5.0.0(12)"`
> 改成你本机已装的版本（DevEco 里 `File → Project Structure → SDK` 可查）。

### 3.3 配置自动签名

`File → Project Structure → Signing Configs` → 勾选 **Automatically generate signature** →
用刚才的华为账号登录授权。

DevEco 会自动生成调试证书与 Profile，并回写到 `build-profile.json5` 的 `signingConfigs`
（本仓库刻意留空，就是为了让这一步写入）。

### 3.4 绑定服务端（推荐扫码）

**方式 A（推荐）：扫码登录** —— 不用手抄地址和 token。

1. 服务器 `.env` 里设好 `IM_PUBLIC_URL`（走隧道就填 `https://im.example.com`）
2. 运行 `npm run pair`，终端出现二维码与一次性配对码：

```bash
npm run pair
# ──────────────────────────────────────────────────
#   用 im app 的「扫码登录」扫下面的二维码
# ──────────────────────────────────────────────────
#   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
#   █ ▄▄▄▄▄ █▀▄▀██▀▄▀▀█▄▄██ ▄▄▄▄▄ █
#   █ █   █ █▀  ▄ █  ▄▀▀▄▄█ █   █ █
#   …（终端里的二维码）
#
#   服务端地址：https://im.example.com
#   配对码：    MZ2CCGNQ
#   有效期：    5 分钟（一次性，用过即废）
```

3. app 首次启动的「绑定 im 服务端」面板点 **扫码登录**，对准终端里的二维码
4. 配对成功后 app 自动拿到地址与 token 并进入聊天；终端那侧打印 `✅ 配对成功` 后退出

> 配对码**一次性 + 5 分钟过期 + 错 5 次作废**；二维码里**不含** token ——
> token 是扫码后单独换取并落盘的（见 `docs/protocol/im-protocol.md` §3.4）。
> 所以二维码被人截到也不会直接泄露 long-term 凭证。

**方式 B：手动填写** —— 面板下方「或手动填写」，填服务端地址 `https://im.example.com`
与 `.env` 里的 `IM_APP_TOKEN`。

**方式 C：改编译期默认值** —— `entry/src/main/ets/services/AppConfig.ets`：

```ts
const DEFAULT_BASE_URL: string = 'https://im.example.com';
const DEFAULT_TOKEN: string = '<你的 token>';
```

> 方式 C 的代价：token 进安装包，反编译即可拿到。自用可接受。
> 换服务器或轮换 token 后，点 app 右上角「重新配对」即可回到绑定面板。

### 3.5 编译 / 安装

**装到真机**（推荐）：

1. 手机：`设置 → 关于本机` 连点版本号进开发者模式 → 打开 **USB 调试**
2. USB 连接 Mac，DevEco 顶部选中该设备
3. 点 **Run** ▶ —— 直接编译、签名、安装、启动

**只产出 HAP 文件**：

`Build → Build Hap(s)/APP(s) → Build Hap(s)`，
产物在 `entry/build/default/outputs/default/entry-default-signed.hap`。

> ⚠️ 这个 HAP 只能装在**签名 Profile 里授权的设备**上。
> 要装到别人的手机，需要把对方设备 UDID 加进 AGC 设备列表并重新签名
> （见 `docs/deploy/hosting-and-distribution.md` §4）。

---

## 4. 验证清单

| # | 检查 | 期望 |
|---|---|---|
| 1 | 服务端本机 `curl http://127.0.0.1:8787/im/health` | `{"ret":0,...}` |
| 2 | 隧道域名 `curl https://im.example.com/im/health` | 同上（证明隧道通） |
| 3 | **手机浏览器**打开 `https://im.example.com/im/health` | 同上（证明手机能到） |
| 4 | app 配置面板填入地址 + token，点保存 | 状态变「已连接」 |
| 5 | app 里发一条消息 | 收到 AI 回复 |
| 6 | 服务端日志 | 有 `[channel/im] ← owner (...)` 与 `[bot] AI 回复 to=owner: ...` |
| 7 | 落库 | `data/soul/wx_bot_ASHLEY.db` 的 `dialogues` 有 user + assistant 两条 |

---

## 5. 排错

| 现象 | 定位 |
|---|---|
| app 一直「连接断开，重试中…」 | **先用手机浏览器**打 `/im/health`（第 3 步）。打不开 = 网络/隧道问题，与 app 无关 |
| 浏览器能开、app 不能 | 检查 token 是否一致（401）；检查是不是开了 Cloudflare Access |
| 401 | token 不一致；注意 `.env` 里有没有多余引号/空格 |
| `CLEARTEXT` / 错误码 2300998 | 明文被系统拦。生产走 https 就不会遇到；若确实要用 http，见 app/README §二 |
| 状态卡在「连接中…」 | 服务端日志有没有入队记录；确认 app 侧 readTimeout(40s) > 服务端长轮询(35s) |
| 回复延迟很久 | 正常：`/im/sync` 最长挂 35s，有消息立即返回 |
| 服务端启动即退出 | 日志找 `IM_APP_TOKEN 未配置`（有意拦截）或 SOUL 文件缺失 |

---

## 6. 日常运维

```bash
# 日志
journalctl -u im-server -f          # Linux
tail -f /tmp/im-server.log          # nohup 方式

# 重启（改完 .env 需要）
sudo systemctl restart im-server

# 备份（全部状态都在这两个地方）
#   data/im_bot.db            共享 DB（users）
#   data/soul/wx_bot_*.db     每个 SOUL 的会话/记忆
#   data/im/                  渠道 inbox/outbox
tar czf im-backup-$(date +%F).tgz -C server data/

# 轮换 token
#   1) 改 server/.env 的 IM_APP_TOKEN  2) 重启 daemon  3) app 面板同步改
```

---

## 7. 相关文档

- 协议细节：[docs/protocol/im-protocol.md](../protocol/im-protocol.md)
- 无公网 IP / 上架合规 / 侧载对比：[docs/deploy/hosting-and-distribution.md](hosting-and-distribution.md)
- 客户端说明（含明文 HTTP 与排查）：[app/README.md](../../app/README.md)
- 架构与迁移映射：[docs/architecture/overview.md](../architecture/overview.md)
