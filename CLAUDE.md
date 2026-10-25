# 三星电视（Tizen）上的 bilibili 客户端

给客厅那台三星电视做的 bilibili 客户端。`app/` 是客户端本体：浏览、搜索、扫码
登录、播放。`spike/` 是当初摸清平台能力的诊断工装，不参与发布，但要重新验证一个
媒体层的问题时，它仍然是最快的路径。

**这份文件只放现在成立的结论和每次都要的操作。** 排查经过、现象、测量表格在 `docs/`
（见「文档地图」）；每条规矩后面的「→」指向它的出处。改了行为，就改这里的结论，把经过
写进对应的 docs 文件 —— 不要再往这里追加流水账。**不要凭直觉重新推导，也不要相信任何
没有附带测量的说法**：这个项目好几次被「说得通的机制」带偏，见「踩过的坑」。

## 目标设备

这份文档里所有的测量都来自同一台参考机。**换一台电视之前，先怀疑数字，别怀疑
结论** —— 平台行为（哪些 API 存在、哪条投递路径能用）在同代机型上是一致的，而带宽、
到画面时间这类数字是这一台的。

| | |
|---|---|
| 型号 | 三星 2023 年款 65 吋（`CU7090` 系列） |
| 固件 | **Tizen 9.0，Chromium 120** —— 已经升级过，不是出厂那一版，见「约定」 |
| Wi-Fi | 5 GHz，协商速率 433 Mbit（1×1 天线），RSSI −43 —— 全屋信号最好的一台，也是链路最慢的一台 |

具体的电视地址、型号串、DUID 和网卡**不写在这里,也不写在脚本里** ——
`zsh tools/setup.sh` 问一次，写进 `~/.bilibili-tizen.conf`（仓库外，权限 600），
`deploy.sh` 每次读取。

开发者模式要开，并且把开发机地址登记进去。sdb 连不上时先查这条登记 —— 电视只接受
那一个地址，而且改完要**完整断电重启**才生效。

## 文档地图

| 文件 | 里面是什么 |
|---|---|
| `docs/播放与CDN.md` | 播放路径实测表、Referer/UA、Shaka 配置为什么是这些数、换节点为什么不行、限流、传输形状、网页端参照、按文件/稿件的歧视、强令牌（含 10-20 的三处提速和换令牌的边界）、两个悬案 |
| `docs/播放流令牌-app端点根治.md` | `platform` 决定令牌强度的完整排查 |
| `docs/播放-启动与编码.md` | 到画面时间去哪了、预取预热、默认编码族 H.265 / AV1 的来回 |
| `docs/调试与日志.md` | 日志通道、启动行、**播放日志对照表**（每行日志回答什么问题）、无人值守自测 |
| `docs/踩过的坑.md` | 下面「踩过的坑」每一条的原始经过 |
| `docs/账号与登录.md` | 多账号、`Cookie` 头被丢、access_key、写接口、Token 续期；另见 `docs/登录路径.md` |
| `docs/界面与交互.md` | 浏览、搜索、UP 主页、返回栈、面板（三个按钮、排法、合集分 P 折叠、关注）、顶栏 |
| `docs/历史续播与唤醒.md` | 观看记录合并与上报、继续观看、下架稿件、续播点、关机再开机 |
| `docs/功能-弹幕直播画质投屏.md` | 投屏为什么做不了、稍后再看、4K / 画质上限、弹幕、直播 |
| `docs/自动更新.md` | 可行性探测、签名与信任根、坏了怎么退回、发布一版的步骤 |
| `docs/部署与发布.md` | 部署脚本、发布包（签名、读回验证）、证书 |
| `docs/约定.md` | 「约定」一节的原文 |
| `docs/平台坑.md` | 平台层面的坑（space 接口被 IP 闸等） |

## 部署

```bash
zsh tools/setup.sh              # 只跑一次：这台电视、这台电脑、证书
node tools/collect.mjs | tee /tmp/bili.log   # 终端 1，一直开着（收集器不落盘，要回读就 tee）
zsh tools/deploy.sh             # 终端 2：检查、签名、安装、启动（约 15 秒）
zsh tools/deploy.sh --selftest  # 同上，构建自己走一遍全流程并上报（约 4 分钟，会自己放视频）
zsh tools/deploy.sh --tokenswap # 只测「播放中 web 令牌被拒 → 换强令牌」（约 1 分钟，给 CDN 一个坏请求）
zsh tools/deploy.sh --dmperf    # 弹幕帧耗时
zsh tools/deploy.sh --diag      # 诊断日志上传：设置里手动传一次、造一次出事自动传（先开 node tools/diag-local.mjs）
node tools/diag-logs.mjs        # 读别人电视传上来的诊断日志（--device 编号 / <id>）
zsh tools/release.sh            # 给陌生人的发布包 → dist/
```

- 开发机要 **Node 22.13 以上**（`diag-verify` 用 `node:sqlite`；18、20、22.12 在那一步崩）和 `tools/` 的依赖（`setup.sh` 会装；`mpd-verify` 要
  `fast-xml-parser`）。`check.sh` 开头先问这两样，缺了直接说缺什么（issue #4 里 Node 18、旧 clone 各撞了一次）。
- `tools/check.sh` 是 deploy 和 release 共用的门禁：`node --check`、`lint.mjs`（调用了不存在的东西、
  `el("…")` 的 id 不在 index.html）和一串 `*-verify.mjs`，**任何一个失败就拒绝安装**。
- 环境变量覆盖配置文件（`BILI_TV_IP=… zsh tools/deploy.sh`）；自己在证书管理器里建的签名档写
  `BILI_PROFILE="<名字>"`。→ `docs/部署与发布.md`
- `deploy.sh` 把开发机地址写进 `config.js` 的 `REPORT_TO`、按需写 `SELFTEST`，打完包、任何退出都改回去 ——
  **地址和 `SELFTEST=true` 都不能进提交**。换了网络要重新部署，否则电视往旧地址报。
- **测试构建不能留在电视上**：`--selftest` / `--tokenswap` / `--dmperf` / `--diag` 跑完马上 `zsh tools/deploy.sh` 装回正常构建。
- 应用编号 `BiliTvApp0.Bilibili`；签名档 / 证书目录叫 `BiliSpike` 是证书的名字，和编号无关。
- 分发证书大约 **2027-08 过期**，重签：`node tools/samsung-cert.mjs`。这一代电视必须用三星签发的
  分发证书，Tizen 自带的一律 `Invalid certificate chain`。证书、密码都在仓库外。→ `docs/部署与发布.md`

### 发版

1. 改 `app/config.xml` 的版本号和 `app/js/boot.js` 的 `PACKAGED_FALLBACK`（要一致，update-verify 卡着），提交。
2. `node tools/update-release.mjs`（取自 `git archive HEAD`，`app/` 有未提交改动就拒绝），
   `git add update && git commit -m "更新包 x.y.z" && git tag vx.y.z && git push origin master vx.y.z`
   —— tag 要一起推：manifest 从 master 取，bundle 从 tag 取。
3. `zsh tools/release.sh` 出 wgt，`gh release create`，说明中英双份（照前几版的格式）。
4. 装着 1.2.0 以后版本的电视会自己更新。**发布包绝不能用 `SamsungBili` 签**（里面有账号邮箱、真名、DUID），
   `release.sh` 用一次性作者证书并读回验证。→ `docs/自动更新.md`、`docs/部署与发布.md`
5. 不用管 Apps2Samsung 的社区目录（README 里推荐的装法）：它每天按 `releases/latest` 自己取新的 wgt
   （`Apps2Samsung/tizen-community-packages` 的 `packages/titlog__bilibili-tizen.json`，按 `bilibili-tizen-.*[.]wgt$` 挑资产），
   所以 wgt 要一直叫 `bilibili-tizen-<版本>.wgt`。

## 调试

零售机上 `dlog`、Web Inspector、`sdb shell` 全是关的，**应用自己往 8099 的 `collect.mjs` 报日志**。新会话第一件事
就是把通道建起来。→ `docs/调试与日志.md`

- 8099 被占用时收集器直接崩，而电视照常往那个孤儿进程报 —— 先 `lsof -nP -iTCP:8099`。
- 通道连撞五次失败会睡五分钟再试；重新部署立刻恢复。`engine:` / `account:` 几秒内自己出现，才说明通道是好的；
  `curl -X POST .../report` 落不落盘，分开「收集器死了」和「电视不发了」。
- 每次启动必有：`engine:`（UA、ES6、MSE、各编码能不能解、封面格式、`布局=现代/无flex-gap/无grid`）、`account:`、
  三行 `whoami:`（判据是 **mid 对不对得上**，不是「认不认得出人」）、`update:`。
- **读启动时间先读 `到画面 按下起=…`**：从按下确认键算，是观众真等的时间；后面那串刻度是这一段播放器自己的，
  走过强令牌会从重建重起。
- 每条播放日志都带 bvid 和一段标题；流地址只打能区分情况的字段（`summariseStreamUrl`），`upsig`/`hdnts` 是凭证。
- 判别实验常驻：AVPlay 失败时 `probe:`（XHR 再要一次：403 是被拒、206 是 AVPlay 的问题）；DASH 卡住时
  `判别探测`、`分段请求 发出/回来/在飞`、`传输形状`。日志对照表在 `docs/调试与日志.md`。
- **别人的电视**（2026-10-21 起，`diag.js`）：出事（播放全部失败、页面加载失败、js 报错、更新包被标坏……调 `trouble()` /
  `Diag.incident()` 的地方）时把最近 600 行传到 `server/diag-worker.mjs`（Cloudflare Worker + D1，挂自己的域名，`workers.dev`
  在有的网络里连不上），设置里能手动传、能关，默认开。`node tools/diag-logs.mjs --device <设置页里的编号>` 读。**往 `report()` 里放标题、
  用户名、UP 主名、收藏夹名、搜索词，一律包 `Diag.priv()`**（`diag-verify` 卡着 `.title` / `.uname` / `.author`），mid、签名参数
  和 IP 由 `scrub()` 兜底（接收端存之前再去一遍）。新的失败出口用 `trouble(文字)` 而不是 `toast()`。**从源码装的构建也传**（1.4.1 起：#7 那台源码构建出了事，一行都没到我们这）；
  自测构建不传，`BILI_DIAG_TO=off` 不传（**这台开发机的 `~/.bilibili-tizen.conf` 里写着**，换电脑要补上），`BILI_DIAG_TO=<地址>` 传到那里。
  **桌面浏览器（UA 里没有 Tizen）一律不传**（10-23：抖音的桌面测试台没拦接收端，写到一半的代码报的错传上去两条，像两台新电视）。→ `server/README.md`
- 无人值守：`--selftest` 派发和遥控器一样的按键走全流程（现在 138 步），最后一行 `SELFTEST 结束，全部通过 / N 步失败`。
  **能靠按键复现的 bug，就给它加一步。** 等网络的步骤返回 `WAIT` 轮询，不写死等待；每次放的视频是推荐流里随手拿的，
  一步失败先看是不是只对那一部片子成立。

## 约定

- `app/js/` 是包在 IIFE 里的纯 ES5，没有构建步骤；`tools/` 是 Node ESM。唯一的依赖是预编译的
  `app/vendor/shaka-player.compiled.js`。
- **最老要跑在 Chromium 47**（`required_version="3.0"`，Tizen 3.0；4.0 是 56、5.5 是 69）：不能用 ES6 语法、
  CSS 变量、CSS grid（`compat.js` 加 `legacy-no-grid`）、flex 的 `gap`（加 `legacy-flex-gap`）。**`app.css` 每加一个
  带 `gap` 的 flex 容器，都要在 `legacy-layout.css` 里补替身**（`legacy-css-verify` 卡着）。**`play()` 在 Chromium 50 以前返回
  `undefined`**，不能接 `.then` / `.catch`，用 `startPlaying()`（`lint.mjs` 卡着）。Tizen 3.0 有人用过（issue #5）：点播能放，直播的 MSE
  解码失败、改走 AVPlay（见「播放」）。Tizen 4.0（2018 款 NU7100）有人从源码装了 1.4.0，说正常（issue #4）；5.0 还没人试过。
- **一切由 D-pad 驱动**，焦点是几何的（`nav.js` 挑方向上最近的 `.focusable`）；横向同一行优先、纵向同一列优先。
  **新加的东西必须能这样够到**；滚动容器靠 `scroll` 这个词识别，横排用 `hscroll`；兜底的「真溢出了」只认能滚的（`overflow-y` 不是
  `visible`）—— Chromium 56 上设置页走到半路一个自称溢出的盒子就停了，焦点往下走、页面不动（#8）。→ `docs/界面与交互.md`
- **屏幕上的字只给观众要用的信息**：观众看了会做出不同的事吗？不会就进日志。留下的：打不开的原因、自救时的
  「网络不顺，正在自动重试…」。提示框（`#toast`）在**屏幕正中**，四秒。成功不弹提示，按钮变化就是回答。
- 设置属于这台电视（`settings.js`），观看记录、搜索历史属于人（`Accounts.scope()`）。
- 提交信息不带 Claude 落款（见用户记忆）。

## 规矩：现在成立的结论

### 网络与 CDN → `docs/播放与CDN.md`

- **bilibili 不需要 Referer**：不发 Referer（`<meta name="referrer" content="no-referrer">`），发浏览器形状的 UA。
  **永远别用裸 `curl` 试探**，它的 UA 在黑名单里，每个响应都像「需要 Referer」。电视直连，不需要代理和后端。
- AVPlay 只有 `COOKIE` 和 `USER_AGENT` 两个流属性；**`COOKIE` 不设**（空字符串搞坏一切，有值则把账号凭证发给 CDN）。
- 单文件（`durl`）封顶 720P，DASH 给到 1080P+；**两种形式并行请求，打平时 DASH 胜**。DASH 只能走 MSE（Shaka，
  清单以 `blob:` 交给它）：AVPlay 只肯从 HTTP 拿 MPD，而 widget 不能监听端口。
- **换 CDN 节点不行**（签名绑主机）。**镜像只排序、不丢弃**（哪台是死的是当天的天气）；Shaka 对 401/403 不做
  BaseURL 转移，所以 403 过的主机按视频拉黑、清单重建前 `preferGoodHosts`。
- CDN 按 IP 对突发请求限流，冷却以秒计：Shaka 重试跨度约十秒、首次加载被网络类错误拒了隔几秒重来一次；
  **从开发机探测要节制**，电视和开发机是同一个出口 IP。
- **令牌强度由 playurl 的 `platform` 决定**：web 端点（`pc`）的令牌常被 403，app 端点（`android`，带 access_key）
  的强令牌被接受。撞 403 就换强令牌，缺 aid 先用 bvid 换。→ `docs/播放流令牌-app端点根治.md`
- 强令牌（2026-10-20 起）：文件头**沿用 web 清单的分段索引**（同一路径即同一文件），不再现读；**播放中被拒不拆播放器**，
  后台铸好之后改写之后的分段请求、`retryStreaming`，换上后播放器的清单也换成强令牌那份；在用的文件对不全就整个重建一次；
  **任何视频被拒后 15 分钟内**，新视频开播直接铸强令牌。`--tokenswap` 测这条路。
- 哪台镜像、哪份文件、哪个编码族坏，都是**分钟级的天气**：坏文件 5 分钟过期，按视频的教训 6 小时过期，教训只当软偏好。
- 流地址约两小时过期（`deadline`）：任何重建前先验，过期就重取 playurl；签名过期之后的网络错误按过期处理，不记坏主机。
- 传输「排队」是和播放器竞争，不是链路上限；电视的 HTTP 栈本身慢（同链路开发机 12 MB/s，电视最好 5.8 MB/s）。

### 播放 → `docs/播放与CDN.md`、`docs/播放-启动与编码.md`

- **DASH 是 Shaka 的事**：分段索引、请求大小、缓冲回收、跳转中止、重试、自适应全交给它，**不要重写库已经做好的事**。
  它的配置是量出来的（`defaultBandwidthEstimate 6e6`、`rebufferingGoal 1`、`bufferingGoal 72` / `bufferBehind 30`、重试约十秒），
  动之前先读 `到画面`。播放器只建一次、反复复用，`load()` / `unload()` 串在一个 promise 上。
- 编码族序 `hev1 → hvc1 → av01 → avc1`（hev1、hvc1 都是 H.265）；**av01 在这块芯片上绿过屏、卡死过画面**
  （有声音没画面），只作换族档的逃生路，**不记成任何视频的教训**。够不到 avc1 那一档的族不要。
- 自救阶梯：同族重载（换镜像出发）→ 换 avc1 → 换 av01 → 逐级压档；坏文件剔出清单；预算按事故计，真实前进后回血。
- **看门狗是每秒一跳的常驻心跳**，不靠媒体事件叫醒；播放头和缓冲末端两个水位线各记各的；首帧前 10 秒、播放中
  15 秒、字节在而首帧出不来 4 秒。**「画面卡住、时间在走」从网页这一侧看不出来**：`requestVideoFrameCallback`、
  `getVideoPlaybackQuality` 在这台电视上都不报帧。
- **任何会启动新播放的入口，第一件事是拆掉旧的**（`Player.stop()`，世代计数器让旧回调闭嘴）；每个视频的状态在
  `play()` 顶部清，不在拆除时清；`lastKnownPosition` 不是「已经看到哪」，进度要相对 `playing.startMs`。
- 两种卡顿要分开：通道空着（我们自己不要字节了 → 立刻重建）和请求吊着没回（连接或 CDN → 才轮到退避）。
- **直播**走 Shaka + HLS-fMP4，音视频混在一路里（点播是分开的）。**MSE 解不了（`3016`、`data[0]=3`）是这一路流的事，不是整台电视的**
  （#7，10-24：Tizen 4.0 上编码串、尺寸都一样，一个直播间放得了、下一个解不了）：这个直播间先降一档还是 MSE（最多两次），哪档都不行才这个
  直播间改走 AVPlay；只有这次运行 MSE 还没放出过一个直播（Tizen 3.0 那样）才整次运行改走。整次运行在 AVPlay 上、AVPlay 放不了的直播间，
  再用 MSE 试一次，放出来了之后的直播间又先走 MSE —— 那台 Tizen 4.0 的 AVPlay 什么都放不了，一次解码失败曾经把后面所有直播间连同刚放过的都带走；
  两个直播间 MSE 哪档都解不了、又一个都没放出来过，就不再试（Tizen 3.0 上 1.4.3 每个直播间白试三次）。
  AVPlay 依次给 **HTTP-FLV → TS → fMP4**（每种都取两台主机里第一个 4 秒内答了的，10-24）：只有原画的小直播间只给 TS 和 FLV，它们的 TS
  两台主机 20 秒都不回、FLV 一两秒就来（Tizen 3.0 那台一上午 65 个直播间就这样关掉，所有电视都一样）；FLV 在 `ov-gotcha05` 上答 403 的直播间，
  TS 是通的。Tizen 9 的 AVPlay 放得了 FLV（原画 1080p，到画面后 0.5 秒时间就走）；Tizen 3.0 的还不知道，一个直播间起不来就这次运行不再给 FLV。
  Tizen 3.0 的 AVPlay 放得了 TS、**放不了 fMP4**（停在 prepare 里不报错）。
  TS 是天气，所以 15 秒不出画面当失败；**AVPlay 的「到画面」只是 prepare 完**，之后它的时钟 10 秒不走也当失败（原画 TS 会「准备好了」
  然后一直缓冲，不报错 —— #5 那句「部分直播不能播放」却一份日志都没有）；还没走起来、AVPlay 说在缓冲的，给 20 秒。直播给 AVPlay
  `setBufferingParam` 3 秒（起播和恢复）：不设时 fMP4 原画 prepare 完要缓冲 6–9.5 秒才走，设了 ~1 秒。时钟走起来之前失败：prepare 不回 /
  格式不支持 → TS 降一档、fMP4 这次运行不再用（Tizen 3.0 的 AVPlay 放不了 fMP4）；prepare 完但不走 → 这一档太重，**两种都降一档**（每个直播间最多三次）。
  `ov-gotcha105` 那台 TS 主机从这边几乎都不回，降档在这台电视上走不到。`--selftest` 里四步强制走这条路（一步是 FLV），另有三步造解码失败 / 让 AVPlay 什么都不给。
  **按直播间改走 AVPlay**（任何电视，issue #7）：只给了 TS 没给 fMP4 的；Shaka 报 `4032`（清单里没有这个引擎放得了的一路，10-23 一个竖屏
  1080x1920 原画）的 —— 重连拿回来的是同一路，不重连。Shaka 加载失败的日志带「清单里」每一路的编码和尺寸。→ `docs/功能-弹幕直播画质投屏.md`

### 账号 → `docs/账号与登录.md`

- **这个固件静默丢弃 widget 设的 `Cookie` 头**。被选中的账号靠 `access_key` 走 query（`withSession()`，只发给
  `api.bilibili.com`）；判断「请求带上了谁」看 **mid 对不对得上**。
- 默认走 TV 扫码登录（用官方 TV 客户端的 appkey 签名，**刻意的决定**），拿得到能存、能切换的凭证；网页扫码是兜底，
  它的凭证在引擎全局 cookie jar 里、看不见，`withCredentials` 只在活动账号是 jar 的主人时设。
- 写接口：点赞、投币、收藏、关注、播放进度上报都认 access_key；评论的写接口从电视发是 403，评论只读；
  **没有凭证时一个写请求都不发**（`compat-api-verify` 卡着）。
- Token 续期没做：参数没对着服务器验证过，不往保管全家凭证的路径里塞猜测；`isLogin:false` 二义，不据此销毁账号。
- 账号层的 bug 是静默的，所以在设备之外测（`accounts-verify.mjs`）。

### 界面 → `docs/界面与交互.md`、`docs/历史续播与唤醒.md`

- 播放中下键拉出面板，视频不停：一排「弹幕开关 · 点赞 · 投币 · 收藏 · 看评论 · 倍速」（和网页一样三个按钮，不弹窗；
  投币在按钮下面那行选枚数、同时点赞），UP 主旁边能关注，下面是「上一集 · 下一集」、分 P、合集、相关推荐。上一集 / 下一集
  先走分 P、再走合集，**和自动连播共用 `episode-nav.js`**，有下一集时面板开在它上面。合集和分 P **50 以内平铺，
  更长的按 50 折成段**，选一段借评论的侧栏列出。
- **从相关推荐或 UP 主页按返回，回到刚才那个视频**的那一秒，面板开着、焦点在点过的地方（`backStack`、`upReturn`、
  `returnTo`）；回 UP 主页之前那个页签只改 `state.screen`、不画它，免得它的请求回来抢走焦点。
- **播放时浏览界面是 `veiled`（`visibility: hidden`），不是 `display:none`**：返回时不用重新排版整个界面（这一步原来 70–120 ms）。
  所以「看不看得见」不能只看 `offsetParent`：`nav.js` 跳过 `.veiled` 里的 `.focusable`（`nav-verify` 卡着），app.js 用 `browseHidden()`。
  返回时网格还是这个页签画的那份就**直接用**，只更新放过的视频的进度条和「继续观看」（后者挪到第一帧之后）。
- **换掉 `#screen` 的内容一律走 `setScreen()`**：它先把当前页签完整的网格整块收起（最近三个页签，跟 `feedCache[kind].items` 绑定，
  列表一换就作废），切回来、从 UP 主页 / 我的 / 设置回来都原样放回。返回键回推荐也是恢复，不再重新拉一页。
- 慢的按键（第一帧或之后 0.6 秒里有一帧超过 100 ms）、慢的整屏绘制（超过 50 ms）、慢的返回 / 打开面板各记一行 `perf:`，
  诊断日志会带上 —— 想知道哪里卡，先跑 `--selftest` 再 `grep perf:`。→ `docs/界面与交互.md`
- 每个会绘制界面的异步回调都要视图令牌（`newView()` / `stillViewing()`）；焦点落到已脱离文档的节点上，遥控器就「失灵」，
  而日志里什么都没有。
- 首页最上面是「继续观看」（合并本机和账号的历史）；下架的稿件从这一行拿掉但记录不删；番剧入口、充电专属
  放不了时照搬 B 站给的原因。
- Tizen 常常是挂起不是杀进程：离开一分钟以上回来就重取首页，靠 `visibilitychange` 和心跳停跳两路信号，
  **两路都删不得**（后台走前者，挂起走后者）。

## 踩过的坑 → `docs/踩过的坑.md`

诊断任何问题之前先读这一节。每一条都至少花掉过一小时，多数是好几小时。

- **说得通的机制不等于诊断。** 至少五次，一个错误被第一个能自圆其说的机制解释、据此设计、然后发布（「CDN 需要
  Referer」「AVPlay 看不到 cookie 所以只能 MSE」「AVPlay 做不了 DASH」……），每次都错。上一个解释仍然成立，也仍然
  不是原因。
- **真正管用的是判别实验**：一个实验，两种结果分别指向不同的原因。**下笔之前先问：如果我的结论是错的，这个测量会给出
  不同的结果吗？** 不会，它就不是证据 —— 不具备区分能力的「实测」会以权威的名义把错误钉进文档（`Cookie` 头那条错了七天）。
- **在围绕一个约束做设计之前，先让它自证。**「设备是 Tizen 7、引擎老」从没测过，却决定了不用现成播放器；测它只要十行代码。
- **一个错误码可能意味着好几件事**（`CONNECTION_FAILED` 同时覆盖被拒、没路由、拿不到 socket），找能把它们分开的东西。
- **一个只会在已知选项里挑的分类器，就是一个会撒谎的分类器**：给它「不属于已知的任何一种」这个出口。
- **静默的空操作才是最贵的故障**：焦点落在脱离文档的节点、滚动容器丢了 class、回调重绘了已离开的屏幕 —— 都不抛异常。
  症状是「它什么都没做」时，怀疑状态，不是错误。`if (x !== session) return` 这种出口也要说一句话。
- **自救路径的入口条件不能依赖只有「不需要自救」时才拿得到的东西**（强令牌要 aid，而起不来的视频恰恰没有 aid，漏了五天）。
- **永远不要靠记忆替换文本，先读那一段再编辑**；改动本该改变行为时，去日志里找它生效的证据。`node --check` 证明不了应用可用
  （一次块删除带走了 `playVideo`，每个文件都能解析）。
- **每个 AVPlay 回调都要世代计数器**：`setListener` 在单例上，`close()` 不解绑；两条播放路交接的地方（`downgrade`、原地重启、
  换集）也算拆除。
- **为某个机制写的文案会比那个机制活得更久**：机制换了，检查为它写的提示还在声称什么。
- **截断会把答案藏起来**：日志只打能区分情况的字段，不打前 N 个字符。
- **测量本身也要合格**：配对错了的仪表（一个全局槽记 range）、从一个 t0 起算的并发探测，都曾把自己的错读当成发现。

## 目录结构

```
app/          客户端
  vendor/shaka-player.compiled.js   DASH 播放器；预编译，不需要打包工具
  js/compat.js   量引擎有没有 flex gap，没有就给 <html> 加 legacy-flex-gap；连 grid 都没有（Chromium 56 及以前）再加 legacy-no-grid
  css/legacy-layout.css  只在这两个类下生效，用 margin / grid-gap 顶替 flex gap
  js/config.js   UA、首选画质、上报地址
  js/md5.js      TV 登录接口的签名摘要
  js/mpd.js      写出交给 Shaka 的 DASH 清单
  js/api.js      bilibili 接口与响应归一化
  js/accounts.js 这台电视上登录的人，以及各自的存储命名空间
  js/auth.js     两条扫码登录流程，以及它们产出的会话
  js/qr.js       二维码编码器，由 tools/qr-verify.mjs 验证
  js/nav.js      基于几何位置的 D-pad 焦点
  js/player.js   两条路：渐进式走 AVPlay，DASH 走 Shaka
  js/boot.js     启动时跑哪份代码（安装包的，还是下载过、验过签名的新版本）；自更新的信任根，永远不随更新下发
  js/update.js   查新版本、下载、验签名、存起来；本身随更新下发
  js/diag.js     诊断日志：记一圈去掉身份的日志，出事或手动时传给开发者；接收地址在这里（config.js 不随更新下发）
  js/danmaku.js  弹幕：取、解析、按轨道画
  js/episode-nav.js  上一集 / 下一集：先分 P、再合集（面板按钮和自动连播共用），由 tools/episode-nav-verify.mjs 验证
  js/resume.js   每个视频看到哪了 —— 按账号隔离，也按分 P 记录
  js/settings.js 跨会话保留的偏好（属于这台电视，不属于某个人）
  js/app.js      各屏幕与路由
  js/selftest.js 设备上的自动走查，非 --selftest 构建里关闭
spike/        当初摸清平台事实的工装；不参与发布
server/       诊断日志的接收端：Cloudflare Worker + D1 的表结构，部署步骤在 server/README.md
tools/
  setup.sh            只跑一次：把电视地址/证书写进仓库外的 ~/.bilibili-tizen.conf
  deploy.sh           一条命令完成构建 + 安装 + 启动
  release.sh          打给陌生人的发布包，见「发布包」
  check.sh            deploy 和 release 共用的检查；卡发布
  collect.mjs         :8099 上的诊断收集器
  lint.mjs            抓「调用了不存在的东西」；卡发布
  accounts-verify.mjs 用假设备驱动整个账号层；卡发布
  md5-verify.mjs      把 md5.js 对着 node 的实现回环验证；卡发布
  mpd-verify.mjs      检查清单是否合法且转义正确；卡发布
  mirrors-verify.mjs  检查镜像是排序而不是丢弃；卡发布
  legacy-css-verify.mjs  app.css 里带 gap 的 flex 容器在 legacy-layout.css 里都有替身；卡发布
  compat-api-verify.mjs  收藏、关注、评论、点赞/投币/收藏的请求去向，以及没凭证不写；卡发布
  nav-verify.mjs      长按确认键开菜单、短按照常播放、方向键跨行；卡发布
  update-verify.mjs   自更新：签名、篡改、旧版本、shell 太新、标坏，以及 boot.js 在每种本地状态下选对代码；卡发布
  update-e2e.mjs      自更新在桌面浏览器里走一遍真的启动（临时钥匙，不碰 bilibili），不在 check.sh 里
  update-release.mjs  打更新包、签名，写 update/manifest.json 和 update/bundle-<版本>.json
  readme-shots.mjs    README 的截图（首页、搜索、弹幕、面板、设置、直播、顶栏；SHOTS=01,02 只拍几张；桌面浏览器、未登录、
                      会连哔哩哔哩，跑一次就好），先出到 dist/readme-shots 挑过再放进 docs/screenshots
  update-key.mjs      生成签名钥匙（只在换钥匙时用；--show 查对不对得上）
  diag-verify.mjs     诊断日志：去隐私、什么时候传什么时候不传、worker 收什么拒什么（node:sqlite 冒充 D1）、app.js 里没包的标题；卡发布
  diag-logs.mjs       读接收端里的诊断日志（令牌在 ~/.bilibili-tizen-diag-token）
  diag-local.mjs      本机冒充接收端（:8097），给 deploy.sh --diag 用
  d1-sqlite.mjs       上面两个用的 D1 替身
  danmaku-verify.mjs  弹幕：解析、去重、轨道不重叠；--browser 在桌面浏览器里量帧耗时；卡发布（node 那部分）
                      （电视上的帧耗时用 deploy.sh --dmperf 量，见「弹幕」）
  devserver.mjs       在开发机上跑 playurl/清单那套，不碰电视
  samsung-cert.mjs    无 GUI 的三星证书签发
  qr-verify.mjs       把 qr.js 过一遍真实解码器
  probe-gating.py     从开发机重新核对 CDN/API 的门禁规则
docs/         排查经过和测量（见「文档地图」）；screenshots/ 是 README 的截图
  操作手册-原始.md    最初的方案，留作参考；其中第 3 步
                     （用 VS Code 插件搞证书）是行不通的
```

## 仍然缺失

**仍然缺失**，大致按缺失感强弱排序：（全站以外的分区 2026-10-18 做了，见「直播、自选分区页签」；UP 主页 2026-09-16 做了，见上；画质、清历史 2026-10-18 做了。）渐进式那条路的重启不验 `deadline`（DASH 侧
验）—— 要走到那一步得同时满足「这个稿件没有 DASH」加「暂停两小时后播放中出错」，
真遇到了表现仍是有声退出，不是冻屏。

还没在野外触发过的：换令牌时在用的文件对不全、整个重建那条路；Tizen 5.0 上的播放；直播 TS 出画面前失败、降一档那条路。两个悬着的观测（有的稿件
AVPlay 必然打不开而地址是好的；播放头自己往回跳）见 `docs/播放与CDN.md` 末尾。
