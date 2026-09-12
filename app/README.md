# im 鸿蒙客户端

> HarmonyOS NEXT / Stage 模型 / ArkTS。
> **本工程当前未在 DevEco Studio 中编译验证过**（开发机无 SDK），首次打开请按下面步骤自检。

---

## 一、打开与运行

1. DevEco Studio（5.0 及以上）→ `Open Project` → 选择本目录 `im/app`。
2. 首次打开会提示同步 `hvigor`；若报 `compatibleSdkVersion` 不匹配，
   改 `app/build-profile.json5` 里的 `compatibleSdkVersion` 为本机已安装的 SDK 版本。
3. Run → 模拟器或真机。
4. 首次启动会显示「连接 im 服务端」面板，填入地址与 token（见下一节）。

---

## 二、连到自己的服务器

连接只需要**两端对齐两个值**：地址 与 token。

| | 位置 | 值 |
|---|---|---|
| 服务端 | `server/.env` | `IM_APP_TOKEN=<一串随机 hex>` |
| app 端 | 应用内配置面板 | 地址 + **同一个** token |

token 不一致 → 服务端返回 `401 {"ret":-1,"errmsg":"unauthorized"}`。

### 第 1 步：服务端起起来

```bash
cd server
cp .env.example .env
```

编辑 `.env`，这几项是必须的：

```env
IM_APP_TOKEN=<用 openssl rand -hex 32 生成>
IM_HTTP_PORT=8787
IM_BIND_HOST=0.0.0.0          # 允许外部（含手机）访问；只给本机用就填 127.0.0.1
MODEL_DSF_API_KEY=sk-xxx      # 模型 key（任意 OpenAI 兼容 provider）
SILICONFLOW_API_KEY=sk-xxx    # 记忆检索用的 embedding key
```

```bash
npm install
npm run dev
```

本机自测：

```bash
curl -fsS http://127.0.0.1:8787/im/health
# {"ret":0,"channel":"im","outboxSeq":0,"inboundAck":0,"pendingInbound":0}
```

### 第 2 步：场景 A —— 局域网联调（最快）

服务端在局域网机器上（`IM_BIND_HOST=0.0.0.0`），手机与它同一 Wi-Fi：

1. 查服务端局域网 IP：`ip addr | grep 'inet '`（形如 `192.168.1.10`）
2. 确认防火墙放行：`sudo ufw allow 8787/tcp`
   （或临时：`sudo iptables -I INPUT -p tcp --dport 8787 -j ACCEPT`）
3. 先用手机浏览器验证一次：访问 `http://192.168.1.10:8787/im/health`，能看到 JSON 就通了
4. app 配置面板填：
   - 地址：`http://192.168.1.10:8787`
   - token：与服务端 `IM_APP_TOKEN` 一致

> **明文 HTTP 的坑**：鸿蒙默认拦截明文流量。本工程已加
> `entry/src/main/resources/base/profile/network_config.json`（`cleartextTrafficPermitted: true`）放行。
> 但按华为官方文档，该配置项是从 **6.1.0(23)** 才支持 —— 若你的 SDK 更老且请求仍被拦
> （报错含 `CLEARTEXT ... not permitted`，或错误码 **2300998**），只有两条路：
> 升级 SDK，或直接走场景 B 的 HTTPS。

### 第 3 步：场景 B —— 公网生产（推荐，也是唯一安全的做法）

**不要把 8787 裸暴露到公网** —— `Authorization: Bearer <token>` 在明文 HTTP 下可被中途截获，
拿到 token 的人就能读写你的全部对话与记忆。

用反向代理加 TLS（以 Caddy 为例，自动申请并续期证书）：

```caddyfile
im.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

服务端改成只监听本机（由 Caddy 转发）：

```env
IM_BIND_HOST=127.0.0.1
```

app 配置面板填：

- 地址：`https://im.example.com`
- token：同上

上线时把 `network_config.json` 的 `cleartextTrafficPermitted` 改回 `false`（不该再放行明文）。

> **没有公网 IP / 域名？** 用 Cloudflare Tunnel（`cloudflared`）即可，还自带 HTTPS ——
> 完整步骤与「35s 长轮询 vs 100s 静默超时」的兼容性分析见
> [docs/deploy/hosting-and-distribution.md](../docs/deploy/hosting-and-distribution.md) §2。
> 另外，这个 app 走**侧载自用**最省事：
> [同文档 §3/§4](../docs/deploy/hosting-and-distribution.md) 说明了上架审核为什么基本过不了、
> 以及 DevEco 调试签名直接装手机的步骤。

### 连不上怎么排查

| 现象 | 检查 |
|---|---|
| app 一直「连接断开，重试中…」 | 先用**手机浏览器**访问 `/im/health` —— 打不开就是网络/端口/防火墙问题，与 app 无关 |
| 返回 401 | token 不一致（注意 `.env` 里有没有多余引号或空格） |
| 立即失败并报 `CLEARTEXT` / `2300998` | 明文被网络策略拦（见场景 A 的说明） |
| 状态卡在「连接中…」 | 看服务端日志有没有 `[channel/im] ← owner (...)`；确认 app 侧 `readTimeout` > 服务端 `IM_LONG_POLL_TIMEOUT_MS`（本实现取 40s） |
| 回复要等一会儿才到 | 正常：`/im/sync` 是长轮询，最长挂 35s，有消息则立即返回 |
| 服务端日志报 `IM_APP_TOKEN 未配置` | 服务端拒绝启动（有意的安全设计），把 `.env` 的 token 填上 |

### 改默认值（可选）

不想每次手填，可改编译期默认值 —— `entry/src/main/ets/services/AppConfig.ets`：

```ts
const DEFAULT_BASE_URL: string = 'https://im.example.com';
const DEFAULT_TOKEN: string = '<你的 token>';
```

> 把 token 写进源码意味着它会进安装包，反编译即可拿到。
> 个人自用可接受；要分发给别人就保留运行时填写。

---

## 三、目录

```
entry/src/main/ets/
├── entryability/EntryAbility.ets   应用入口
├── pages/Index.ets                 聊天页（气泡 / 主动关怀 / 扫码登录面板）
├── services/ImClient.ets           协议客户端（/im/health /im/sync /im/send）
├── services/Pairing.ets            ★扫码配对（ScanKit 扫码 → /im/pair 换 token）
├── services/AppConfig.ets          preferences：地址、token、sync cursor
└── model/Message.ets               消息模型

entry/src/main/resources/base/profile/
├── main_pages.json                 页面路由
└── network_config.json             网络安全策略（明文放行，仅联调用）

AppScope/                           ★应用级配置（缺了 DevEco 打不开工程）
├── app.json5                       bundleName / versionCode / versionName / icon / label
└── resources/base/{element,media}/ app_name 字符串、应用图标 PNG（216×216）
```

---

## 四、与服务端的契约

| 行为 | 端点 | 要点 |
|---|---|---|
| 长轮询收消息 | `POST /im/sync {cursor}` | `readTimeout` 必须 > 服务端长轮询超时（本实现取 40s） |
| 发消息 | `POST /im/send {clientMsgId,text}` | `clientMsgId` 为幂等键，超时重发安全 |
| 探活 | `GET /im/health` | 免鉴权 |

详细报文见 [`docs/protocol/im-protocol.md`](../docs/protocol/im-protocol.md)。

---

## 五、已实现 / 未实现

**已实现**

- 长轮询会话循环（含指数退避：失败 <5 次重试 2s，≥5 次退避 30s）
- 游标持久化（`preferences`）→ 冷启动补齐离线消息
- **扫码登录**（ScanKit 扫码 → `/im/pair` 换取地址 + token → 自动落盘并连接；顶栏可「重新配对」）
- 乐观 UI（本地先插「发送中…」气泡，收到回复后落定；失败标红）
- 主动关怀消息特殊样式（`kind === "proactive"` 显示「主动关心」徽标）
- 手动填写地址 + token（扫码不可用时的兜底）

**未实现（见 docs/protocol/im-protocol.md §7）**

- 本地消息历史库（当前仅内存 + 服务端 outbox 补齐；重启后需从 cursor 重新同步）
- 图片消息（服务端已支持 base64 入站，客户端未接入选择器）
- 本地通知（主动关怀到达时提醒）
- 多设备 / 多用户（服务端仍是单用户设计，且 `/im/sync` 未按用户过滤 outbox）
- 端到端加密

---

## 六、代码约定（ArkTS）

- **禁止 `any`**；所有跨函数的数据结构先定义 `interface` 或 `class`。
- 状态用 `@State`；数组内元素变更后需 `splice` 回写才能触发刷新（见 `settleOldestPending`）。
- 网络一律 `@kit.NetworkKit` 的 `http.createHttp()`，用完 `destroy()`。
- 持久化一律 `@kit.ArkData` 的 `preferences`。
