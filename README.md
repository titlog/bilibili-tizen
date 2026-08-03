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
> `tools/samsung-cert.mjs` 无 GUI 完成这件事:不需要 Eclipse、不需要 sudo、
> 不需要 Tizen 的证书管理器。**这个脚本对任何 Tizen 项目都有用**,不限于本项目。

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
