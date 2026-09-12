# Cloudflare Tunnel 搭建（可照做）

> 目的：让手机在外面（4G/5G）也能连到你家/机房里那台没有公网 IP 的服务器。
>
> 本项目的用法很确定：**只给生产机 112（`10.168.3.112`）建隧道**；开发机 180（`10.168.3.180`）
> 永远在局域网内联调（手机连同一 Wi-Fi 直连 `http://10.168.3.180:8787`），**不建隧道**。
>
> 本文覆盖：域名托管 → 建隧道 → 凭证分发 → **开发机 / 生产机双环境** → 常驻与验证 → 排错。

---

## 0. 先想清楚:你要几条隧道?

这是最容易踩坑的地方。

**关键约束**：`cloudflared tunnel route dns` 做的事是给主机名建一条 CNAME
（`im.example.com` → `<隧道UUID>.cfargotunnel.com`）。
**一个主机名的 CNAME 只能有一个目标**，所以：

> **一个域名(主机名)只能指向一个隧道。**
> 想让开发机和生产机都能从外网访问，就必须用**两个不同的主机名**。

由此有三种做法：

| 做法 | 隧道数 | 适用 |
|---|---|---|
| **A. 只给生产机建隧道**（推荐先这样） | 1 条 | 开发机（`10.168.3.180`）就在同一局域网里联调，用 `http://10.168.3.180:8787` 直连，根本不需要隧道 |
| **B. 开发 + 生产各一条，用不同子域名** | 2 条 | `im-dev.example.com` → 开发机；`im.example.com` → 生产机 |
| C. 多台机器跑**同一个隧道** | 1 条 | ⚠️ 这是**高可用**语义：Cloudflare 会把请求轮流打到各台机器。**不能**用来区分开发/生产 |

所以回答你的问题：**是的，要分两个环境就建两条隧道**，但要配两个子域名；
如果只是自己用，**开发机完全可以不建隧道**。

推荐路线：

```
阶段 1（联调）   开发机 10.168.3.180 跑 server ←──同一局域网──→ 手机   # 不用隧道，最快
阶段 2（生产）   112（10.168.3.112）+ 隧道 + im.example.com            # 手机随时可用
阶段 3（可选）   开发机也建一条隧道 + im-dev.example.com                # 出差也要连开发机时
```

---

## 1. 前置:把域名托管到 Cloudflare

隧道用的是 Cloudflare 的 DNS 与边缘网络，所以域名必须在 Cloudflare 托管（**免费计划就够**）。

1. 在 Cloudflare 控制台 `Add a site`，填入你的域名，选 Free 计划
2. Cloudflare 给你两个 NS（形如 `xxx.ns.cloudflare.com`）
3. 到你的**域名注册商**后台，把域名的 NS 改成这两个
4. 等 NS 生效（通常几分钟到几小时，最长 24h）
5. Cloudflare 控制台上该域名显示 **Active** 才算好

> ⚠️ NS 没生效前，`cloudflared tunnel route dns` 会失败。

**没有域名？** 先用临时隧道试水（见 §8），别为试功能去买域名。

---

## 2. 建隧道(一次性操作)

在**任意一台**机器上做（本项目用的是 MacBook；凭证是**账号级**的，与目标机无关），只需要做一次：

```bash
# macOS 安装
brew install cloudflared

# 1) 登录：会打开浏览器让你选域名并授权
#    凭证写到 ~/.cloudflared/cert.pem（这是"账号级"凭证，用于创建/管理隧道）
cloudflared tunnel login

# 2) 创建隧道：输出 Tunnel ID(UUID)，并生成 ~/.cloudflared/<UUID>.json
cloudflared tunnel create im-prod

# 3) 把主机名指到这条隧道（会建 CNAME + 一条代理记录）
cloudflared tunnel route dns im-prod im.example.com

# 4) 顺手看一眼
cloudflared tunnel list
```

如果你也要开发机那条，**同机再做一次 create**：

```bash
cloudflared tunnel create im-dev
cloudflared tunnel route dns im-dev im-dev.example.com
```

产物清单（记下来，后面要用）：

| 产物 | 位置 | 作用 |
|---|---|---|
| `cert.pem` | `~/.cloudflared/cert.pem` | 账号级凭证，只用于创建/管理，**不需要**分发 |
| `<UUID>.json` | `~/.cloudflared/<UUID>.json` | **隧道级**凭证，目标机器必须有它（可分发） |
| Tunnel ID | `cloudflared tunnel list` 或文件名 | 写进 config.yml |

---

## 3. 分发到目标机器

以生产机 **112**（`10.168.3.112`）为例：

```bash
# 在 Mac 上：把生产隧道的凭证与配置推过去
scp ~/.cloudflared/<生产隧道UUID>.json  <user>@10.168.3.112:/tmp/
# 在目标机上：
sudo mkdir -p /etc/cloudflared
sudo mv /tmp/<生产隧道UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<生产隧道UUID>.json
```

> `cert.pem` **不要**拷过去 —— 目标机只需要跑隧道，不需要创建/管理权限。

---

## 4. 每台机器的 config.yml + 常驻

仓库里已经有模板：[`server/deploy/cloudflared-config.yml`](../../server/deploy/cloudflared-config.yml)。
复制到目标机并替换两处：

```yaml
# /etc/cloudflared/config.yml
tunnel: <生产隧道UUID>
credentials-file: /etc/cloudflared/<生产隧道UUID>.json

ingress:
  - hostname: im.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

生产机 **112** 这么配（若开发机也要隧道，把 hostname 换成 `im-dev.example.com`，其余一样）。

常驻（systemd，官方脚本会装好单元并读 `/etc/cloudflared/config.yml`）：

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
journalctl -u cloudflared -f
```

只想临时联调可以不用常驻：

```bash
cloudflared tunnel run im-dev      # 前台跑着，Ctrl+C 结束
```

---

## 5. 服务端侧:这一项必须改 ⚠️

隧道通了还不够 —— 服务端得知道"自己的公网地址是什么"，否则扫码配对时会把**局域网地址**写进二维码，
手机一出门就连不上。

```env
# 生产机 112：/opt/im/server/.env
IM_BIND_HOST=127.0.0.1            # 只监听本机，公网入口交给 cloudflared
IM_PUBLIC_URL=https://im.example.com   # ← 必须改成隧道域名（写进配对二维码）
```

改完**重启服务端**，然后重新配对（或 app 右上角「重新配对」）。
因为配对码里带的就是这个 URL，地址变了旧的绑定就失效了。

---

## 6. 验证:由内到外，逐层排查

按这个顺序做，出问题时能立刻定位是哪一层：

| # | 命令 | 通过意味着 |
|---|---|---|
| 1 | `curl http://127.0.0.1:8787/im/health`（在服务器上） | 服务端活着 |
| 2 | `curl https://im.example.com/im/health`（在服务器上） | 隧道 + DNS + 边缘都通 |
| 3 | 手机浏览器打开 `https://im.example.com/im/health` | 手机能到（外网链路 OK） |
| 4 | app 点「扫码登录」扫 `npm run pair` 的二维码 | 端到端完成 |

第 1 步就失败 → 跟隧道无关，看服务端日志。
第 2 步失败 → 看 cloudflared 日志（`journalctl -u cloudflared -f`）。
第 3 步失败但第 2 步成功 → 手机网络问题（或运营商拦截）。

---

## 7. 排错

| 现象 | 原因 |
|---|---|
| 浏览器 **1033** | 隧道进程没跑（`systemctl status cloudflared`） |
| 浏览器 **502 / 530** | 隧道在跑，但 `service:` 指向的服务端没起（或端口写错） |
| 浏览器 **404**（Cloudflare 页面） | 请求的 hostname 没匹配上 config.yml 的 `ingress` |
| **1016** | DNS 记录有问题：`tunnel route dns` 没执行或 NS 未生效 |
| 改完 `.env` 后手机连不上 | 忘了重启服务端，或没重新配对（`IM_PUBLIC_URL` 变了） |
| 长轮询约 100s 断一次 | 把 `IM_LONG_POLL_TIMEOUT_MS` 调到了 ≥100s，撞 Cloudflare 硬超时（我们默认 35s，安全） |
| 约 60s 断一次 | 中间还有一层 Nginx，其 `proxy_read_timeout` 默认 60s |
| 页面要求登录 / 403 | 给域名开了 **Cloudflare Access** —— 关掉它（app 只发 Bearer token，过不了浏览器登录） |

---

## 8. 临时方案:还没有域名

```bash
cloudflared tunnel --url http://127.0.0.1:8787
# 输出形如 https://random-words-1234.trycloudflare.com
```

把它填进 `IM_PUBLIC_URL` 就能先跑通全链路。缺点：**URL 每次重启都变**，只适合验证。
稳定使用请按 §1 把域名托管上来。

---

## 9. 机器上**已经有隧道**时怎么接入（别把现有项目搞挂）

典型场景：这台机器已经为别的项目跑着一个 cloudflared（例如 112 上的 `ourworld`）。
你有两条路，**按是否愿意让现有服务共享故障域来选**。

### 先看清现状

```bash
systemctl cat cloudflared.service          # ExecStart 长什么样、有没有 --config
cloudflared tunnel list                    # 有几条隧道、哪条在跑
ps aux | grep -v grep | grep cloudflared    # 实际进程
```

⚠️ 一个常见坑：配置**不一定在 `/etc/cloudflared/`**。
若 `ExecStart=cloudflared tunnel run` 没带 `--config`，它会读**默认位置**，
也就是 `/root/.cloudflared/config.yml`（以 root 跑时）。先 `cat` 确认再改。

### 方案 A:复用现有隧道,只加一条 ingress（省一个进程）

适用于：现有隧道与它的 hostname 互不相关，你不介意"改配置要重启、重启会短暂影响现有服务"。

```bash
# 1) 给现有隧道加一条 DNS（<你的项目域名> 换成实际域名）
cloudflared tunnel route dns <现有隧道名或UUID> <你的项目域名>

# 2) 编辑现有 config.yml，**在最后的 http_status:404 之前**插入两条：
#      - hostname: <你的项目域名>
#        service: http://localhost:<你的端口>

# 3) 重启（会有几秒影响现有项目 —— 选低峰期做）
systemctl restart cloudflared
```

改完 `config.yml` 应当是这样（**已有规则一条都别动**）：

```yaml
tunnel: <现有隧道UUID>
credentials-file: /root/.cloudflared/<现有隧道UUID>.json

ingress:
  - hostname: 现有项目.example.com          # ← 原有，别动
    service: http://localhost:8000
  - hostname: <你的项目域名>                # ← 新增的这两行
    service: http://localhost:8787
  - service: http_status:404                # ← 兜底必须留在最后
```

### 方案 B:独立隧道 + 独立服务（互不影响,生产更稳）

适用于：想让两边的重启/故障**完全隔离**，或多一条凭据无所谓。

```bash
cloudflared tunnel create <新隧道名>
cloudflared tunnel route dns <新隧道名> <你的项目域名>

# 独立配置文件（与现有那个并存，互不覆盖）
cat > /root/.cloudflared/<新隧道名>-config.yml <<'YAML'
tunnel: <新隧道UUID>
credentials-file: /root/.cloudflared/<新隧道UUID>.json
ingress:
  - hostname: <你的项目域名>
    service: http://localhost:8787
  - service: http_status:404
YAML

# 独立 service（注意服务名不能与现有的 cloudflared.service 重名）
cat > /etc/systemd/system/cloudflared-<新隧道名>.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel (<新隧道名>)
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel --config /root/.cloudflared/<新隧道名>-config.yml run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload && systemctl enable --now cloudflared-<新隧道名>
```

> 💡 已经有别人替你建好一条空隧道的话（`cloudflared tunnel list` 里能看到、但没有连接），
> 方案 B 可以直接拿它来用，不必再 `create`。

### 两种方案的取舍

| | 方案 A（复用） | 方案 B（独立） |
|---|---|---|
| 进程数 | 1 个 cloudflared 跑所有 hostname | 2 个 |
| 改配置影响面 | 重启会**短暂影响现有项目** | 互不影响 ✅ |
| 凭据 | 复用现有 | 多一份 |
| 适用 | 小机器、省资源、能接受低峰重启 | 生产、要求故障隔离 |
| 配额 | 无额外消耗 | 隧道数量按账号配额（Cloudflare 免费版够用） |

