# 诊断日志的接收端

电视上的 `app/js/diag.js` 出事时（或在设置里手动）把最近的运行日志传到这里；三个应用的自更新也从这里取一份 GitHub 的中转（见「接口」）。一个
Cloudflare Worker（`diag-worker.mjs`）加一个 D1 数据库（`schema.sql`），免费额度够用。
bilibili-tizen、douyin-tizen、telegram-tizen 共用，按 `app` 字段分开。

## 为什么是这样

- **挂在自己的域名上，不用 `*.workers.dev`**：`workers.dev` 在有的网络里连不上，而第一个要靠它
  诊断的电视（#5）就在这样的网络里。
- **谁都能写**：地址就在公开的应用里，放什么密钥都藏不住。限住的是形状和大小、同一台电视
  一小时 20 份、全站一天 2 万份，以及 30 天的寿命。读要令牌（Worker 的 secret `READ_TOKEN`）。
- **不存 IP**，只存 Cloudflare 解析出的国家或地区和机房：「这台电视在哪个地区、拿的是哪批
  CDN 节点」正是 #5 回答不了的问题。
- **http 也收**：老电视的根证书可能和这边的证书链对不上，`diag.js` 在 https 连不上时用 http
  再试一次，记录里的 `via` 写明走的哪条。挂成 Worker 自定义域名的子域名上 http 照收
  （10-21 实测：同一份 POST，https、http 都是 200），哪怕那个域名本身的 http 会跳 https。
  换域名时重测这一条：被跳转的话 POST 变成 GET，等于没退路。

## 接口

| | |
|---|---|
| `POST /v1/upload` | `text/plain` 的 JSON：`{v:1, app, device, version, running, reason, manual, tvAt, tz, ua, lines:[…]}`，回 `{id}` |
| `GET /v1/list?device=&app=&since=&limit=` | 带 `Authorization: Bearer <令牌>`；只有元数据 |
| `GET /v1/get?id=` | 带令牌；整份，`body` 是按行拼起来的日志 |
| `GET /v1/update/<应用>/manifest.json` | 自更新的清单，转 GitHub 上 master 的那份，缓存 5 分钟；不要令牌 |
| `GET /v1/update/<应用>/bundle-<版本>.json` | 自更新的包，转 `v<版本>` 这个 tag 上的，缓存 30 天 |

后两个是给连不上 GitHub 的电视用的（有的网络里 raw.githubusercontent.com 解析不了，jsDelivr 时通时断）。中转不需要被信任：清单有签名，
里面写着包的 sha256，改过的电视不收。三个应用的 `update.js` 都先问这里，再问 GitHub、jsDelivr。

每天的定时触发（cron）删掉 30 天前的记录。

## 部署

Worker 和 D1 库都叫 `tizen-diag`（2026-10-21 建）。
**它没有自己的域名了（10-25 起）**：域名挂在另一个收所有应用诊断报告的 Worker 上，那个 Worker 把 `/v1/upload`、`/v1/list`、
`/v1/get`、`/v1/update/…` 原样转给这个（service binding）。`wrangler.toml` 里别再加 `routes`，否则下次部署会把域名抢回来，
那边的应用就断了（10-25 反过来发生过一次：那边一部署，这三个应用的上传、读日志、更新中转全成了 404，断了八小时）。
配置都在 `wrangler.toml`（D1 绑定、每天 04:00 UTC 的清理、关掉请求日志），在这个目录里：

```bash
npx wrangler@4 d1 create tizen-diag                                   # 只第一次；id 填进 wrangler.toml
npx wrangler@4 d1 execute tizen-diag --remote --file=schema.sql       # 幂等，加了表或索引再跑一次
npx wrangler@4 deploy                                                  # 改了 diag-worker.mjs 之后只跑这条
(umask 077; openssl rand -hex 24 > ~/.bilibili-tizen-diag-token)       # 只第一次
npx wrangler@4 secret put READ_TOKEN < ~/.bilibili-tizen-diag-token
```

接收地址写在 `app/js/diag.js` 的 `ENDPOINT` 里（douyin-tizen、telegram-tizen 的 `diag.js` 同理）；
`release.sh` 在它不是 https 地址时拒绝发布。

## 读

```bash
node tools/diag-logs.mjs                      # 最近 30 份
node tools/diag-logs.mjs --device K7QM-3XTA   # 一台电视（设置页里那个编号）
node tools/diag-logs.mjs <id>                 # 一份，全部行
```

本机冒充接收端（`zsh tools/deploy.sh --diag` 默认往它传）：`node tools/diag-local.mjs`，
读的时候 `BILI_DIAG_URL=http://localhost:8097 BILI_DIAG_TOKEN=local`。
