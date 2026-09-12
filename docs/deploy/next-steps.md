# 下一步:从当前状态到"手机上能聊天"

> 项目现在处于 **v0.2**:服务端已通过类型检查与端到端验证,app 工程已补全到可编译,
> 扫码登录可用。**本文是从这一刻开始、一步步做到真机能聊的完整操作清单。**
>
> 每一步都给了命令、预期输出,以及失败时怎么定位。按顺序做即可。

---

## 阶段 0:先备齐东西

| 需要 | 说明 | 必需? |
|---|---|---|
| 生产机 **112**(`10.168.3.112`) | 常开小主机;服务端生产环境(systemd + cloudflared 隧道),路径 `/opt/im/server` | ✅ |
| 开发机(`10.168.3.180` 容器 `fanny`) | 服务端开发/联调,容器内路径 `/.openclaw/team-shared/projects/im` | ✅ |
| MacBook + **DevEco Studio** | 编译 HAP 用;需登录华为开发者账号(个人实名,免费) | ✅ |
| 一台鸿蒙手机 | HarmonyOS NEXT(API 12+) | ✅ |
| LLM API key | 任意 OpenAI 兼容(DeepSeek / 智谱 / MiniMax…) | ✅ |
| SiliconFlow API key | 记忆检索的 embedding | ✅ |
| 一个域名 | 托管到 Cloudflare 后可走隧道;先用局域网也行 | 建议 |

先想清楚你要哪种连接方式:

```
方案 A(先跑通,最快)   开发机 10.168.3.180 ←──同一局域网──→ 手机   # 不需要隧道、不需要域名
方案 B(最终形态)       112(10.168.3.112) + cloudflared ──→ https://你的域名
```

**建议先走 A 把端到端跑通,再升级到 B。** 这样出问题时变量少。

---

## 阶段 1:服务端跑起来(约 10 分钟)

### 1.1 把项目放到目标机器

三台机器的角色与路径(完整版见 `DEPLOY.md §机器拓扑`):

| 机器 | 地址 | 服务端代码路径 |
|---|---|---|
| 开发机 | `10.168.3.180`(容器 `fanny`) | 容器内 `/.openclaw/team-shared/projects/im` |
| 生产机 **112** | `10.168.3.112` | `/opt/im/server` |
| MacBook | — | 只编译鸿蒙 app,不跑服务端 |

生产机(112)首次落代码:

```bash
# 从 MacBook / 开发机把 server/ 同步过去(**不要带 data/**)
rsync -a --exclude data/ server/ <user>@10.168.3.112:/opt/im/server/
# 或直接在 112 上:
#   git clone git@github.com:elliotchen40/im.git /opt/im-src \
#     && sudo mkdir -p /opt/im && sudo cp -r /opt/im-src/server /opt/im/
ssh <user>@10.168.3.112 'cd /opt/im/server && npm install'
cd /opt/im/server
```

### 1.2 生成 token 并填 .env

```bash
cp .env.example .env
openssl rand -hex 32      # 复制输出,填到 IM_APP_TOKEN
vi .env
```

必填项:

```env
IM_APP_TOKEN=<上一步生成的随机串>
IM_HTTP_PORT=8787
IM_BIND_HOST=0.0.0.0              # 局域网方案要手机能连,填这个
                                  # 隧道方案改成 127.0.0.1(公网入口交给 cloudflared)

MODEL_DSF_API_KEY=sk-xxx          # 你的 LLM key
MODEL_DSF_BASE_URL=https://api.deepseek.com
MODEL_DSF_MODEL=deepseek-chat

SILICONFLOW_API_KEY=sk-xxx        # 记忆检索必需,缺失会直接抛错
```

### 1.3 装依赖并启动

```bash
npm install          # 期望:added N packages
npm run dev          # 期望:看到 [channel/im] HTTP 长轮询通道已启动 / [bot] 机器人已启动
```

### 1.4 自测(另开一个终端)

```bash
curl http://127.0.0.1:8787/im/health
```

期望:

```json
{"ret":0,"channel":"im","outboxSeq":0,"inboundAck":0,"pendingInbound":0}
```

**❌ 如果启动就退出了**,看日志:

| 日志 | 原因 |
|---|---|
| `IM_APP_TOKEN 未配置 —— 拒绝以无鉴权方式启动` | `.env` 里 token 是空的(这是有意的安全设计) |
| `[startup] SOUL 文件不存在` | 工作目录不对,要在 `server/` 下启动 |
| `SILICONFLOW_API_KEY 缺失或为占位符` | embedding key 没填 |

### 1.5 (可选)没有真实 key 也想验证链路

```bash
npm run mock         # 终端 1:本地假 LLM + 假 embedding,零费用零外网
npm run dev:verify   # 终端 2:用 .env.verify 起 daemon(独立 DB data/verify_im.db)
```

---

## 阶段 2:让手机能连上

### 方案 A:局域网(先跑通,推荐第一步)

1. 服务端 IP:生产机 112 = `10.168.3.112`,开发机 = `10.168.3.180`(同一局域网,手机连同一 Wi-Fi 即可直连)
2. 放行端口:`sudo ufw allow 8787/tcp`
3. **先用手机浏览器**打开 `http://<服务器IP>:8787/im/health`
   - 能看到 JSON → 网络通了,继续
   - 打不开 → 防火墙/不同网段,先把这步解决
4. `.env` 里设 `IM_PUBLIC_URL=http://<服务器IP>:8787`,重启 daemon

> 此时 `IM_BIND_HOST=0.0.0.0`。
> 明文 HTTP 需要 app 侧放行 —— 仓库已配好 `network_config.json`。

### 方案 B:Cloudflare 隧道(最终形态)

完整步骤见 **[cloudflare-tunnel.md](cloudflare-tunnel.md)**,这里只列要点:

```bash
cloudflared tunnel login
cloudflared tunnel create im-prod
cloudflared tunnel route dns im-prod im.example.com
# 凭证 + config.yml 装到服务器,sudo cloudflared service install
```

然后服务端侧**必须**改两项并重启:

```env
IM_BIND_HOST=127.0.0.1
IM_PUBLIC_URL=https://im.example.com
```

> ⚠️ 这一步最容易漏。`IM_PUBLIC_URL` 会被写进配对二维码 ——
> 不改的话扫码后 app 会拿到局域网地址,手机一出门就连不上。

验证:

```bash
curl https://im.example.com/im/health      # 在服务器上
# 再用手机浏览器打开同一个地址
```

---

## 阶段 3:在 Mac 上编译并装到手机(约 20 分钟)

### 3.1 装 DevEco Studio

从华为开发者官网下载 macOS 版,安装时勾选 **HarmonyOS SDK**,首次启动登录华为开发者账号。

### 3.2 打开工程

`Open Project` → 选 **`im/app`**(不是仓库根目录)。

首次打开会自动同步 hvigor,并生成 `hvigorw`、`hvigor/hvigor-config.json5`、
`oh-package-lock.json5` —— **这是正常的**,仓库里刻意没有提交这些本地文件。

> 若报 `compatibleSdkVersion` 不匹配:打开 `app/build-profile.json5`,
> 把 `"compatibleSdkVersion": "5.0.0(12)"` 改成你本机装的版本
> (`File → Project Structure → SDK` 可查)。

### 3.3 配置自动签名

`File → Project Structure → Signing Configs` → 勾 **Automatically generate signature** →
用华为账号授权。DevEco 会生成调试证书与 Profile 并回写到 `build-profile.json5`
(仓库里 `signingConfigs` 是空数组,就是为了让这一步写入)。

### 3.4 装到真机

1. 手机:`设置 → 关于本机` 连点版本号 → 进开发者模式 → 打开 **USB 调试**
2. USB 连接 Mac,DevEco 顶部选中该设备
3. 点 **Run** ▶ —— 编译、签名、安装、启动一气呵成

**只产出 HAP 文件**(不直接装):

```
Build → Build Hap(s)/APP(s) → Build Hap(s)
产物: entry/build/default/outputs/default/entry-default-signed.hap
```

> ⚠️ 这个 HAP 只能装在签名 Profile 授权的设备上(就是这台手机)。

**❌ 编译报错怎么办**:把完整错误贴给我。最可能的两个点:
- ArkTS 类型约束(`scanBarcode` / `preferences` 的调用签名)
- ScanKit 权限 —— 默认扫码 UI 通常不需要相机权限,若报权限错误,
  在 `entry/src/main/module.json5` 的 `requestPermissions` 里加 `ohos.permission.CAMERA`

---

## 阶段 4:配对并开始聊天

### 4.1 服务器出二维码

```bash
cd /opt/im/server
npm run pair
```

期望输出:

```
──────────────────────────────────────────────────
  用 im app 的「扫码登录」扫下面的二维码
──────────────────────────────────────────────────
        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
        █ ▄▄▄▄▄ █▀▄▀██▀▄▀▀█▄▄██ ▄▄▄▄▄ █
        …（二维码）
  服务端地址：https://im.example.com
  配对码：    MZ2CCGNQ
  有效期：    5 分钟（一次性，用过即废）
──────────────────────────────────────────────────
```

> 若提示 `未设置 IM_PUBLIC_URL`,说明 `.env` 里没配 —— 它会退回局域网地址。
> 若提示 `端口没有响应`,说明 daemon 没在跑,配对会成功但 app 连不上。

### 4.2 手机上扫码

app 首次启动 → 「绑定 im 服务端」面板 → 点 **扫码登录** → 对准终端二维码。

成功后:面板自动进入聊天界面,终端那侧打印 `✅ 配对成功` 并退出。

### 4.3 验证清单

| # | 检查 | 期望 |
|---|---|---|
| 1 | app 顶栏状态 | 「已连接」 |
| 2 | 发一条消息 | 收到 AI 回复 |
| 3 | 服务端日志 | `[channel/im] ← owner (...)` 与 `[bot] AI 回复 to=owner: ...` |
| 4 | 落库 | `data/soul/wx_bot_ASHLEY.db` 的 `dialogues` 新增 user + assistant 两条 |
| 5 | 试试命令 | 发 `/status`、`/help`、`/memory` 有回执 |

落库自查:

```bash
sqlite3 data/soul/wx_bot_ASHLEY.db \
  "SELECT id, role, substr(content,1,40) FROM dialogues ORDER BY id DESC LIMIT 4;"
```

---

## 阶段 5:上线后(按需)

### 5.1 常驻运行(别再用 npm run dev)

```bash
npm run build
sudo cp deploy/im-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now im-server
journalctl -u im-server -f
```

(安装细节见 `deploy/im-server.service` 顶部注释)

### 5.2 备份

```bash
tar czf im-backup-$(date +%F).tgz -C /opt/im/server data/
```

要备份的都在 `data/`:`im_bot.db`(用户)、`soul/wx_bot_*.db`(会话/记忆)、`im/`(渠道队列)。

### 5.3 观察主动关怀是否按预期工作

主动关怀(D→C→B 触发)默认 4 小时跑一次。上线头几天看一眼日志:

```bash
journalctl -u im-server | grep "care tick"
# care tick: 跳过（无 careChannelUserId…）        → 还没收到过消息,正常
# care tick skipped: <reason>                     → 有原因地跳过
# care tick triggered: type=… summary=…           → 触发了,检查是否真的发了消息
```

---

## 出问题时:四层定位法

按顺序打这三个地址,**在哪一层挂就知道问题在哪**:

| # | 在哪 | 命令 | 挂了说明 |
|---|---|---|---|
| 1 | 服务器上 | `curl http://127.0.0.1:8787/im/health` | 服务端本身没起 |
| 2 | 服务器上 | `curl https://im.example.com/im/health` | 隧道 / DNS / Cloudflare 边缘 |
| 3 | 手机浏览器 | 打开 `https://im.example.com/im/health` | 手机网络 / 路由 |
| 4 | app | 扫码登录 | 只有这一层挂,才是 app 的问题 |

常见对应关系:

| 现象 | 大概率是 |
|---|---|
| 浏览器 **1033** | 隧道进程没跑 |
| 浏览器 **502 / 530** | 隧道在跑,但服务端没起或端口错 |
| 浏览器 **404** | hostname 没匹配 config.yml 的 ingress |
| 浏览器 **1016** | DNS 没配对(`tunnel route dns` 没执行 / NS 未生效) |
| 要求登录 | 给域名开了 Cloudflare Access,**关掉**它 |
| app 返回 401 | token 不一致(重新配对最省事) |
| app 一直「连接断开」 | 第 3 层没通,或 `IM_PUBLIC_URL` 与当前访问地址不一致 |

---

## 你需要在 Mac 上确认的两件事

1. **app 已实编通过**(DevEco Studio 26.0.0 / hvigor 6.26.4,`hvigorw assembleHap` ✅)。
   实测唯一的编译阻塞是 `Pairing.ets` 里的 `Record<string, string>` 对象字面量
   (ArkTS 不允许无类型对象字面量,已改为显式 `interface PairBody`)。
   ArkTS 告警也已清零(`getContext`/`showToast` 改走 `UIContext` 版本,
   `preferences`/`http` 调用补 try/catch)。
2. **ScanKit 的相机权限** —— 默认扫码 UI 由系统提供,通常不需要声明权限;
   若你的 SDK 版本报错,在 `module.json5` 加 `ohos.permission.CAMERA`。

---

## 之后可以做的事(按价值排序)

| 优先级 | 事项 | 说明 |
|---|---|---|
| 高 | **多用户/多设备** | 当前是单用户(`IM_OWNER_USER_ID`)。**关键前提: `/im/sync` 目前不按用户过滤 outbox** —— 多人用会互相看到消息,必须先改这里 |
| 中 | **本地消息历史库** | 现在消息只在内存,退出 app 后靠服务端 outbox 补齐;补本地库可离线看历史 |
| 中 | **图片消息** | 服务端已支持 base64 入站,客户端未接选择器 |
| 中 | **本地通知** | 主动关怀到达时提醒 |
| 低 | **WS 推送** | 取代 35s 长轮询,更省电;协议见 `im-protocol.md` §7 |
| 低 | **开发机第二条隧道** | `im-dev.example.com`,只在"出差也要连开发机"时需要 |
| 低 | **清命名债务** | `wechat_user_id` 列名、`channel='wechat'` 默认值 |
| 低 | **未做的 UAT** | 主动关怀链路、`/soul` 切换隔离、summarizer 触发与 fact 门控 |

---

## 相关文档

| 文档 | 用途 |
|---|---|
| [cloudflare-tunnel.md](cloudflare-tunnel.md) | 隧道搭建专篇(含开发/生产双环境、排错表) |
| [self-host.md](self-host.md) | 端到端自托管(服务端 → 隧道 → DevEco → 运维) |
| [hosting-and-distribution.md](hosting-and-distribution.md) | 无公网 IP 方案对比、上架合规现实、AGC 内测时效 |
| [../protocol/im-protocol.md](../protocol/im-protocol.md) | 协议规范(端点、游标、配对 §3.4) |
| [../../app/README.md](../../app/README.md) | 客户端细节与排查 |
