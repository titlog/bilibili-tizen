# 三星电视上的 bilibili

给三星 Tizen 电视做的 bilibili 客户端,全程遥控器操作。纯 ES5,没有构建步骤,
**不需要后端,不需要代理,不需要服务器** —— 电视直连 bilibili。

一台电视上可以同时登多个账号,各自的观看记录互不干扰。

> LG webOS 有一个很好的 [bili-webos](https://github.com/asdf17128/bili-webos),
> 三星这边一直是空的。这个项目补的是这个位置。
>
> **与 bilibili、三星均无关联。** 个人项目。

## 现在能用的

推荐 / 热门 / 排行 / 四个分区 / 动态 / 用电视自带输入法搜索,扫码登录(任意多个
账号),多分 P,跨设备续播(接着手机上的进度),自动播下一集,拖动时有缩略图预览和
章节刻痕。

播放走两条路:渐进式交给 AVPlay,DASH 交给
[Shaka Player](https://github.com/shaka-project/shaka-player)。

从按下确认键到出画面约 **2.5–3.5 秒**,1080P H.265。

## 安装

三星商店不收第三方客户端 —— 2019 年非官方的 Twitch 应用就是因为「不是官方出的」
被下架的 —— 所以只能侧载。需要一台和电视同网段的电脑,**只需要一次**。

```bash
git clone <本仓库> && cd bilibili-tizen
zsh tools/setup.sh      # 问几个问题,签证书。只跑一次
zsh tools/deploy.sh     # 检查、签名、安装、启动
```

`setup.sh` 会引导你打开电视的开发者模式、自动找到电视、读出 DUID、签发证书。
需要:Node、Python 3,以及
[Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
的命令行工具(**不需要装 IDE**)。

> ### 证书是所有人卡住的地方
>
> Tizen 自带的分发证书在 2023 年以后的机器上**一律** `Invalid certificate chain`
> —— 2022 年过期的那套和有效期到 2032 的 `-new` 那套都一样,所以这是信任链问题,
> 不是过期问题。必须用三星签发的那一套。
>
> `setup.sh` 会自动搞定。如果你只是想拿证书、和本项目无关,它已经拆成了独立工具:
>
> **[samsung-tv-cert](https://github.com/titlog/samsung-tv-cert)**
> [![npm](https://img.shields.io/npm/v/samsung-tv-cert.svg)](https://www.npmjs.com/package/samsung-tv-cert)
> —— `npx samsung-tv-cert --duid <你的DUID>`
>
> 不需要 Eclipse、不需要 sudo、不需要 Tizen 的证书管理器。**对任何要往三星电视上
> 侧载东西的项目都有用**(Jellyfin、Twitch 社区版、你自己写的应用)。

## 两条登录路径 —— 一个需要你自己判断的取舍

这个项目**默认走 TV 登录**,因为多账号是电视上的刚需:客厅那台机器是全家共用的,
观看记录混在一起没人能忍。但这条路有代价,而且这个代价该由每个使用者自己权衡,
所以两条路都实现了、都能用,下面把差别摊开讲。

| | **TV 登录**(默认) | **网页扫码** |
|---|---|---|
| 端点 | `passport-tv-login` | `passport-login/web` |
| 需要 appkey 签名 | **是** —— 用官方 TV 客户端的 appkey | 否 |
| 对 bilibili 表现成 | 官方电视客户端 | 网页 |
| 返回凭证 | SESSDATA / bili_jct / access_token / refresh_token,**JSON,可读** | **读不到** |
| 多账号 | ✅ 任意多个,可随时切换 | ❌ 只能一个 |
| 观看记录回传 bilibili | ✅ | ❌ |
| 断电重启后还在 | ✅ | ⚠️ 靠引擎的全局 cookie jar |

**为什么网页扫码做不了多账号 —— 这是结构性的,不是没写。** 它的轮询响应不携带
凭证,只返回一个跨域跳转地址;会话是那一跳的 `Set-Cookie`,被引擎收进它自己的**全局**
cookie jar,XHR 永远看不到。所以那样登进来的账号**存不下、恢复不了、也不能和别人
共存** —— jar 里只装得下一个,而且没有任何办法把上一个放回去。

**appkey 那两个值不是秘密**,在 bilibili API 社区是公开文档化的。公开它们不构成
泄密。但**用**它们是一个决定:你的客户端会以官方 TV 客户端的身份对 bilibili 发请求。
这是 ToS 层面的判断,不是技术问题。

**想去掉 TV 登录怎么做:** 删掉 `app/js/auth.js` 顶部那两个常量,让 `login()` 直接
调 `startWeb`。单账号一切照常。代价是:第二次登录会顶掉第一个账号
(`Accounts.needsRelogin` 会把失去 jar 的那位标记出来要求重新扫码),以及电视上的
观看进度不再回传 bilibili —— `/x/v2/history/report` 只认 `access_key`,不认 `csrf`,
而 `access_key` 只有 TV 登录路径给。

网页扫码路径**现在也是自动兜底**:TV 路径不可用时会回落过去,而且回落发生在**任何
二维码到达屏幕之前** —— 在别人已经举着手机对准的时候把码换掉,比直接失败更糟。

## 这个仓库真正值钱的部分

客户端能用,但真正花时间的是搞清楚这个平台到底能干什么。
[`CLAUDE.md`](CLAUDE.md) 记录了每一条测量,**包括那些推翻了先前结论的**。
几条动辄花掉一整天的:

- **bilibili 不需要 `Referer`。** 它会拒绝一个不认识的 `Referer`,却接受完全不带
  的请求;同时对 `curl/*` 这类 UA 返回 403。所以用裸 `curl` 试探,每个响应都读起来
  像「需要 Referer」—— 这个假信号差点让整个项目上马一个根本不需要的局域网代理。
- **AVPlay 只开放 `COOKIE` 和 `USER_AGENT` 两个流属性。** 任何需要第三个请求头的
  设计,都得换形状。
- **把 `COOKIE` 设成空字符串会直接搞坏播放** —— AVPlay 会发出畸形的 `Cookie` 头,
  CDN 拒绝一切。表现和「这个流坏了」一模一样,而且**只在用户登录之后才开始出现**。
- **AVPlay 能播 DASH,但清单必须走 HTTP 到达。** `data:` 和 `file://` 都被拒,
  而 widget 没法监听端口 —— 这就是 DASH 走 MSE 的原因。
- **单文件形式(`durl`)封顶 720P**,而且对有高码率片源的视频会被直接拒绝:接口
  照样返回地址,CDN 在每个镜像、每个画质上都 403。
- **换 CDN 节点在这条链路上行不通。** 签名是绑主机的,八个候选里七个 403,唯一能
  用的那个慢三十倍。
- **每个 AVPlay 回调都要加世代计数器。** `setListener` 注册在单例上,`close()`
  不解绑,于是一个已经拆掉的会话的 `onerror` 会打进当前正在播的东西里。这件事曾经
  让一个结论**完全反了**。
- **这个 widget 可以自己更新自己** —— `new Function`、`blob:` 脚本、远程 `script`
  标签、`wgt-private` 读写,五条路设备实测全通。

文档里还记着一套排查纪律:**说得通的机制不等于诊断**。有五次,一个错误被第一个能
自圆其说的机制解释、据此设计、然后发布出去,后来被测量推翻。每一次上一个解释都
仍然成立,也仍然不是原因。

## 目录

```
app/          客户端(ES5,IIFE,无构建步骤)
  vendor/     Shaka Player,预编译入库
spike/        当初摸清平台事实的工装
tools/
  setup.sh            只跑一次:你的电视、你的证书
  deploy.sh           检查、签名、安装、启动
  samsung-cert.mjs    无 GUI 签发三星证书
  collect.mjs         :8099 上的诊断收集器
  lint.mjs            抓「调用了不存在的东西」
  *-verify.mjs        清单 / 账号 / md5 / 二维码 —— 任何一个失败都拒绝发布
CLAUDE.md     全部发现、坑,以及怎么在零售机上调试
```

## 怎么调试

零售机把一切方便的手段都关了:`dlog` 什么都不返回,Web Inspector 的端口从不打开,
`sdb shell` 直接 `closed`。所以应用自己上报 —— `tools/collect.mjs` 在 8099 端口
监听,`deploy.sh` 自动把地址写进构建。

**先开收集器,再部署。** 应用连续五次上报失败后会永久关闭上报,直到重启 —— 顺序
反了就白等。

```bash
zsh tools/deploy.sh --selftest
```

会在电视上无人值守地走一遍全流程:网格、播放、面板、滚动、拖动、跨缓冲区远距离
跳转、暂停、恢复、退出、账号页,并逐步上报。**这是唯一能在无人值守下检验一个构建
的办法。**

## 协议

MIT。bilibili 是其所有者的商标,本项目与之无关联。
