/* An on-device walkthrough of the whole flow.
 *
 * The television blocks both dlog and the web inspector, and the remote's
 * WebSocket needs someone standing in front of the set to approve it — so the
 * only way to exercise this build without a human is from inside it. Enabled by
 * SELFTEST in config.js, which tools/deploy.sh sets with --selftest.
 *
 * Every step dispatches the same key events the remote produces, so it walks the
 * real code path rather than calling internals directly.
 */
var SelfTest = (function () {
    "use strict";

    function post(line) {
        if (!REPORT_TO) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", REPORT_TO, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.send(JSON.stringify({ event: "log", detail: { msg: "SELFTEST " + line } }));
        } catch (e) {}
    }

    /* A press is a keydown and then a keyup, as on the remote. Since PR #2, OK on
     * a card acts on the keyup — holding it opens the action menu instead — so a
     * keydown alone was a key held forever: 650ms later the menu opened over the
     * grid, and every step after "按确认键开始播放" ran inside it (2026-10-18). */
    function key(code) {
        var types = ["keydown", "keyup"];
        for (var i = 0; i < types.length; i++) {
            var e = document.createEvent("Event");
            e.initEvent(types[i], true, true);
            e.keyCode = code;
            /* preventDefault is called by the handler; a synthetic Event tolerates it. */
            document.dispatchEvent(e);
        }
    }

    var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, RETURN: 10009 };

    /* #shell behind the player is veiled (visibility: hidden), not display:none:
     * still laid out, not on screen. */
    function visible(id) {
        var n = document.getElementById(id);
        if (!n || n.offsetParent === null) { return false; }
        for (var p = n; p && p !== document.body; p = p.parentNode) {
            if (/\bveiled\b/.test(p.className || "")) { return false; }
        }
        return true;
    }

    function count(sel) { return document.querySelectorAll(sel).length; }

    /* A set with nobody signed in opens the login page instead of the switcher,
     * and the removal walk has nothing to walk. Skipping is right; failing would
     * make the run red on a television that is behaving perfectly. */
    function onAccounts() { return count("#screen .acc") > 0; }

    /* Filled by the identity check, read by the step that waits for it. Empty
     * string means it answered and agreed; null means it never answered. */
    var identityVerdict = "凭证检查没有回应";

    /* What the PR #2 steps learn on the way: which lists were there to open,
     * which video has a subtitle track, what the server said. Steps run on
     * timers, so an asynchronous answer is parked here for the next step. */
    var probe = {};

    /* Live on AVPlay: switch the room over once, then wait for the native
     * player's clock to move a second and a half. */
    function liveNativeStep(force) {
        var k = "native_" + force;
        if (!probe[k]) {
            probe[k] = { t0: -1 };
            window.__stLiveNative(true, force === "auto" ? "" : force);
            return WAIT;
        }
        if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
        if (Player.mode() !== "avplay" || visible("player-loading")) { return WAIT; }
        var t = -1;
        try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
        if (t < 0) { return WAIT; }
        if (probe[k].t0 < 0) { probe[k].t0 = t; return WAIT; }
        return t - probe[k].t0 >= 1500 ? null : WAIT;
    }

    /* A live room is playing: on Shaka the video element moves; a room that
     * went to AVPlay by itself (4032, no fMP4) has AVPlay's clock instead. */
    function livePlaying() {
        if (visible("player-loading")) { return false; }
        if (Player.mode() === "avplay") {
            try { return webapis.avplay.getState() === "PLAYING" && webapis.avplay.getCurrentTime() > 1000; } catch (e) { return false; }
        }
        var v = document.getElementById("html5-video");
        return !!(v && v.currentTime > 1 && !v.paused);
    }

    function rect(id) {
        var n = document.getElementById(id);
        var r = n && n.getBoundingClientRect();
        return r ? [r.left, r.top, r.width, r.height].map(Math.round).join(",") : "?";
    }

    /* Walk the feed one player/v2 at a time until a video has a subtitle track.
     * One at a time, not all at once: twelve parallel calls is the kind of burst
     * the API's IP gate answers with 412. */
    function findSubtitled(items, i, done) {
        if (i >= items.length) { done(null, i); return; }
        var v = items[i];
        if (!v || !v.cid) { findSubtitled(items, i + 1, done); return; }
        API.playerV2(v.bvid, v.cid, function (r) {
            if (r.subtitles && r.subtitles.length) { done({ v: v, idx: i, tracks: r.subtitles }, i + 1); }
            else { findSubtitled(items, i + 1, done); }
        }, function () { findSubtitled(items, i + 1, done); });
    }

    /* "3:30" or "1:06:40" back into seconds, for the position readouts. */
    function secs(text) {
        var parts = String(text || "").split(":");
        var out = 0;
        for (var i = 0; i < parts.length; i++) { out = out * 60 + Number(parts[i] || 0); }
        return isFinite(out) ? out : 0;
    }

    /* Steps run on a timer rather than promises: this is ES5 on an old engine,
     * and the whole point is to be sure about what the real build does. */
    /* The decisive one: hand the very url AVPlay refuses to a plain XHR. If the
     * fetch succeeds, the url is fine and the fault is in how AVPlay asks for
     * it; if the fetch fails too, the url itself is being refused. Guessing
     * between those two cost several deploys. */
    function probeStream() {
        var card = document.querySelector("#screen .card.focused") ||
                   document.querySelector("#screen .card");
        if (!card) { post("✗ 探测：网格里没有卡片"); return; }
        var idx = Number(card.getAttribute("data-i"));
        var v = (window.__stItems || [])[idx];
        if (!v || !v.bvid) { post("✗ 探测：拿不到 bvid"); return; }

        API.playurlProgressive(v.bvid, v.cid, Settings.qnCap(), function (r) {
            var host = String(r.url).split("/")[2];
            post("探测 qn=" + r.quality + " accept=" + (r.accept || []).join(",") +
                 " 镜像数=" + (r.urls || []).length + " 主机=" + host);
            var xhr = new XMLHttpRequest();
            xhr.open("GET", r.url, true);
            xhr.setRequestHeader("Range", "bytes=0-1023");
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                post("探测 XHR 同一地址 -> HTTP " + xhr.status +
                     (xhr.status === 206 || xhr.status === 200
                        ? "（地址没问题，问题在 AVPlay 的请求）"
                        : "（地址本身被拒）"));
            };
            xhr.ontimeout = function () { post("探测 XHR 超时"); };
            xhr.onerror = function () { post("探测 XHR 传输错误"); };
            xhr.send();
        }, function (why) { post("✗ 探测：playurl 失败 " + why); });
    }

    /* The zone tabs run through the same code as 排行 with a different
     * partition id, so what can actually break is an id — and an id that
     * answers with nothing looks exactly like a network hiccup from the sofa.
     * Asking the endpoints directly is steadier than walking the tab bar with
     * the remote and trusting focus to land where the press count says. */
    var zoneProbe = null;

    function probeZones() {
        zoneProbe = {};
        var want = [["美食", 1020], ["舞蹈", 1004]];
        for (var i = 0; i < want.length; i++) {
            (function (name, rid) {
                API.ranking(rid, function (items) {
                    zoneProbe[name] = items.length;
                }, function (why) { zoneProbe[name] = "失败 " + why; });
            })(want[i][0], want[i][1]);
        }
    }

    /* A partition that answers with an empty list is the failure worth catching
     * — bilibili renumbered these once already, and a renumbered id returns
     * code 0 with nothing in it rather than an error. */
    function zoneVerdict() {
        if (!zoneProbe) { return "分区探测没有跑"; }
        var bad = [], names = ["美食", "舞蹈"], line = [];
        for (var i = 0; i < names.length; i++) {
            var v = zoneProbe[names[i]];
            line.push(names[i] + "=" + (v === undefined ? "没回来" : v));
            if (typeof v !== "number" || v === 0) { bad.push(names[i]); }
        }
        post("分区 " + line.join(" "));
        return bad.length ? ("这些分区取不到内容：" + bad.join("、")) : null;
    }

    /* 10-25: a Tizen 4.0 set's history and follows were refused by the gateway
     * for their Origin and now go through a frame on api.bilibili.com. This
     * set's never are, so the frame route is forced for one history report of
     * the video playing — a real write, of progress it is making anyway. */
    var frameWrite = null;

    function frameWriteStep() {
        if (!frameWrite) {
            var ids = window.__stPlayingIds && window.__stPlayingIds();
            if (!ids || !ids.aid || !ids.cid) { return WAIT; }   /* aid comes with view() */
            frameWrite = {};
            API._selftest.gateWrites(true);
            API.report(ids.aid, ids.cid, Math.max(5, Math.floor(Player.position() || 0)),
                       function () { frameWrite.ok = true; },
                       function (why) { frameWrite.why = why; });
            return WAIT;
        }
        if (!frameWrite.ok && !frameWrite.why) { return WAIT; }
        API._selftest.gateWrites(false);
        return frameWrite.ok ? null : "从框里上报失败：" + frameWrite.why;
    }

    /* The end-of-video chooser, checked and then immediately disarmed.
     *
     * The countdown is eight seconds and the video reaches its end somewhere
     * between five and nine seconds after the seek, so any step that *waits* a
     * fixed time and then presses a key is racing it: the 19:09 run found the
     * counter at 1, autoplay fired inside the 900ms before the next step, and
     * four later steps went red about a screen the run had already left. So the
     * press that stops the countdown happens in the same step as the check that
     * finds the screen — nothing can expire in between. */
    function checkChooser() {
        var f = document.querySelector("#nextup .focusable.focused");
        if (!f || f.id !== "nextup-go") { return "焦点没有落在排队的那个视频上"; }
        var n = document.getElementById("nextup-count");
        if (Settings.get("autoplayNext", true) === true) {
            if (!n || !/^\d+$/.test(n.textContent)) { return "倒计时没有在走"; }
        } else {
            if (n) { return "自动播放已关闭，却仍有倒计时"; }
            if (document.getElementById("nextup-hint").textContent.indexOf("自动播放已关闭") < 0) {
                return "没有提示等待手动播放";
            }
        }
        var row = document.getElementById("nextup-more");
        var cards = count("#nextup-related .card");
        if (row && row.className.indexOf("hidden") >= 0) {
            post("即将播放：这个视频没有相关推荐，只有中间那一张");
            window.__stNoRelated = true;
            return null;
        }
        post("即将播放：相关推荐 " + cards + " 张，" + (n ? "倒计时 " + n.textContent : "等待手动选择"));
        if (!cards) { return "相关推荐那一行在，但一张卡都没有"; }
        key(KEY.DOWN);
        return null;
    }

    /* A step may answer WAIT — not there yet — and is asked again every half
     * second, for up to step[3] ms after its first check; then it fails with
     * step[4] (a string, or a function for a message that needs the moment).
     * For the waits whose length is the network's, not the app's. */
    var WAIT = {};

    var rel = {};   /* the related pick that 返回 has to come back from */

    var steps = [
        ["首页加载出卡片", 3500, function () {
            return count("#screen .card") > 0 ? null : "网格里没有任何卡片";
        }],
        ["焦点落在第一张卡片", 300, function () {
            var f = document.querySelector("#screen .card.focused");
            return f ? null : "没有卡片处于选中状态";
        }],
        /* Absent is allowed — nothing half-watched is a real state. Present and
         * empty is not: that is the strip having been built from a list that
         * arrived wrong, which looks from the sofa like a heading with a hole
         * under it. */
        ["首页的继续观看那一行", 200, function () {
            var row = document.getElementById("resume-row");
            if (!row) { post("首页没有续播行（可能确实没有没看完的）"); return null; }
            var n = row.querySelectorAll(".card").length;
            post("续播行 " + n + " 张");
            return n ? null : "续播行在，但一张卡都没有";
        }],
        /* Off the resume strip and into the feed before anything is played. Two
         * reasons, both learned the hard way elsewhere in this file: the strip's
         * cards carry a `data-i` into a *different* array, so probeStream would
         * measure a video nobody is playing; and this run now watches its video
         * to the end, which would mark whatever the viewer was halfway through
         * as finished and take it out of 继续观看. A test that eats the viewer's
         * place in a series is worse than no test. */
        ["焦点从续播行移进推荐网格", 400, function () {
            var f = document.querySelector("#screen .card.focused");
            if (f && f.parentNode && f.parentNode.parentNode &&
                    f.parentNode.parentNode.id === "resume-row") {
                key(KEY.DOWN);
            }
            var now = document.querySelector("#screen .card.focused");
            return (now && now.parentNode && now.parentNode.id === "feed-grid")
                ? null : "焦点没有落在推荐网格的卡片上";
        }],
        ["探测流地址", 200, function () { probeStream(); probeZones(); return null; }],
        ["等待探测结果", 4000, function () { return null; }],
        ["分区都有内容", 100, zoneVerdict],
        ["按确认键开始播放", 200, function () { key(KEY.ENTER); return null; }],
        ["播放器接管画面", 6000, function () {
            if (visible("shell")) { return "浏览界面没有让位给播放器"; }
            if (visible("player-loading")) { return "六秒后仍停在加载画面"; }
            return null;
        }],
        ["进度在走", 4000, function () {
            var t = document.getElementById("player-pos").textContent;
            return (t && t !== "0:00") ? null : "进度停在 0:00";
        }],
        ["写操作改走 api.bilibili.com 的框：进度上报过得去", 300, frameWriteStep, 20000, "20 秒了框里的上报还没回来"],
        ["下键拉出面板", 1200, function () {
            key(KEY.DOWN);
            return null;
        }],
        ["面板可见且有内容", 900, function () {
            if (!visible("options")) { return "面板没有出现"; }
            if (!document.getElementById("panel-title").textContent) { return "面板标题为空"; }
            return null;
        }],
        /* Read, never pressed: a coin cannot be taken back (2026-10-20). */
        ["面板里点赞、投币、收藏三个按钮，状态读出来了", 500, function () {
            if (!visible("panel-like") || !visible("panel-coin") || !visible("panel-fav")) {
                return "三个按钮不全";
            }
            /* Any group about 弹幕, not one id: PR #10 brought one back as
             * #opt-dm-area and this check, written for #opt-danmaku, let it by. */
            var dmRow = !!document.getElementById("opt-danmaku"), labels = document.querySelectorAll("#options .opt-label");
            for (var li = 0; li < labels.length; li++) { if (/弹幕/.test(labels[li].textContent)) { dmRow = true; } }
            if (dmRow) { return "面板里又出现了弹幕那一排"; }
            if (!Auth.isLoggedIn()) { post("跳过：没登录，读不了点赞状态"); return null; }
            if (!API.videoActionReady() || !Accounts.active() || !Accounts.active().mid) {
                post("跳过：这个账号是网页扫码登录的（或还没有 mid），面板不读这些状态");
                return null;
            }
            var a = window.__stPanelActs && window.__stPanelActs();
            if (!a || !a.loaded) { return WAIT; }
            post("面板：" + document.getElementById("panel-like").textContent + " / " +
                 document.getElementById("panel-coin").textContent + " / " +
                 document.getElementById("panel-fav").textContent + "（收藏夹 " + a.folders + " 个）");
            return a.liked === null || a.coins === null || a.folders < 0 ? "有一项状态没读到" : null;
        }, 8000, "8 秒了点赞、投币、收藏的状态还没读出来"],
        /* 播放速度 goes through Shaka's trickPlay, not the element — written to
         * the element it reverts at the first stall. What is checked is the
         * player's own answer and the badge that tells the viewer. Put back to
         * 1x afterwards: it is sticky for the app run. */
        ["面板里选 1.5 倍速", 600, function () {
            var chip = document.querySelector('#opt-speed .opt[data-rate="1.5"]');
            if (!chip) { post("跳过：这条路没有 1.5 倍（AVPlay 只有整数倍）"); window.__stNoRate = true; return null; }
            Nav.focus(chip);
            key(KEY.ENTER);
            return null;
        }],
        ["倍速生效，角标写着 1.5x", 700, function () {
            if (window.__stNoRate) { return null; }
            var r = Player.rate();
            var badge = document.getElementById("player-quality").textContent;
            /* Back to 1x the way the viewer would, so the badge follows. */
            var one = document.querySelector('#opt-speed .opt[data-rate="1"]');
            if (one && one.onselect) { one.onselect(); } else { Player.setRate(1); }
            if (r !== 1.5) { return "选了 1.5 倍，播放器说是 " + r + " 倍"; }
            if (badge.indexOf("1.5x") < 0) { return "倍速变了但角标没写（" + badge + "）"; }
            return null;
        }],
        /* 右键必须走同一行。分P切片按自己的文字定宽，宽切片的右邻居中心能在
         * 五百像素外，而下一行只在九十像素下面 —— 纯中心距评分让「右」落进了
         * 下一行。多P稿件上焦点开在正在播的那一片，正是最宽的那种；单P稿件
         * 焦点开在相关推荐上，同样的断言照走。行尾没有右邻居就跳过，不算失败。 */
        ["面板里按右键走的是同一行", 600, function () {
            if (!visible("options")) { return "面板不见了"; }
            var cur = document.querySelector("#options .focused");
            if (!cur) { return "面板里没有焦点"; }
            var cr = cur.getBoundingClientRect();
            var all = document.querySelectorAll("#options .focusable");
            var want = null, wantX = Infinity;
            for (var i = 0; i < all.length; i++) {
                if (all[i] === cur || all[i].offsetParent === null) { continue; }
                var r = all[i].getBoundingClientRect();
                var cx = r.left + r.width / 2;
                var sameRow = r.top < cr.bottom - 6 && r.bottom > cr.top + 6;
                if (!sameRow || cx <= cr.left + cr.width / 2 + 4) { continue; }
                if (cx < wantX) { wantX = cx; want = all[i]; }
            }
            if (!want) { post("跳过：焦点右边同一行没有东西"); return null; }
            key(KEY.RIGHT);
            var now = document.querySelector("#options .focused");
            if (now === want) { return null; }
            if (now === cur) { return "按右键焦点没动"; }
            var nr = now ? now.getBoundingClientRect() : { top: -1 };
            return "按右键没走到同一行右邻居（from top=" + Math.round(cr.top) +
                   " to top=" + Math.round(nr.top) + "）";
        }],
        ["面板里能往下走", 600, function () {
            var before = document.getElementById("options").scrollTop;
            key(KEY.DOWN); key(KEY.DOWN); key(KEY.DOWN);
            window.__stScroll = before;
            return null;
        }],
        ["面板确实滚动了", 700, function () {
            var after = document.getElementById("options").scrollTop;
            return after > window.__stScroll ? null
                : "焦点下移但面板没滚动（before=" + window.__stScroll + " after=" + after + "）";
        }],
        /* The panel's related grid is paged rather than capped: two rows go up
         * with the panel (over a stream that is still buffering) and the rest
         * follows the ring down. What this catches is the grid quietly refusing
         * to grow — which looks exactly like a video that only had two rows of
         * related videos, and is why the total is asked for rather than guessed
         * at from the DOM. */
        ["第一张相关推荐的下键进入下一排", 700, function () {
            var first = document.querySelector("#opt-related .card");
            var total = typeof window.__stPanelTotal === "function"
                        ? window.__stPanelTotal() : 0;
            var m = /density-([45])/.exec(document.body.className);
            var columns = m ? Number(m[1]) : 3;
            if (!first || total <= columns) { return null; }
            Nav.focus(first);
            key(KEY.DOWN);
            var focused = Nav.current();
            return focused && Number(focused.getAttribute("data-i")) >= columns
                ? null : "从第一张推荐按下键，没有进入下一排";
        }],
        ["面板里的相关推荐能一直往下翻", 700, function () {
            if (!visible("options")) { return "面板不见了"; }
            var total = typeof window.__stPanelTotal === "function"
                        ? window.__stPanelTotal() : 0;
            var cards = count("#opt-related .card");
            post("面板：相关推荐一共 " + total + " 个，已经画出 " + cards + " 张");
            if (!total) { return "面板里一个相关推荐都没有"; }
            if (total <= 6) {
                window.__stPanelShort = true;   /* legitimately short list */
                return null;
            }
            key(KEY.DOWN); key(KEY.DOWN);
            return null;
        }],
        ["面板的推荐网格接着长出来了", 700, function () {
            if (window.__stPanelShort) { return null; }
            if (!visible("options")) { return "面板不见了"; }
            var cards = count("#opt-related .card");
            post("面板：往下走之后画出 " + cards + " 张");
            return cards > 6 ? null
                : "焦点走进相关推荐深处了，网格却没有接着长（还是 " + cards + " 张）";
        }],
        /* 返回 from a related pick comes back to the video it was picked from,
         * at that second, with the panel open on that card — not out to the
         * grid (2026-10-20, the viewer). */
        ["面板里点开一个相关推荐", 300, function () {
            var f = Nav.current(), box = document.getElementById("opt-related");
            if (!f || !box || !box.contains(f) || f.getAttribute("data-i") === null) {
                f = document.querySelector("#opt-related .card");
                if (!f) { return "面板里没有相关推荐可点"; }
                Nav.focus(f);
            }
            rel.title = document.getElementById("player-title").textContent;
            rel.pick = Number(f.getAttribute("data-i"));
            key(KEY.ENTER);
            return null;
        }],
        ["相关推荐那个视频出画面", 1000, function () {
            if (visible("shell")) { return "点开的相关推荐退回了首页"; }
            if (visible("player-loading")) { return WAIT; }
            var t = document.getElementById("player-title").textContent;
            return t && t !== rel.title && document.getElementById("player-pos").textContent !== "0:00"
                ? null : WAIT;
        }, 20000, "20 秒了点开的相关推荐还没在放（放不了的话会回到原来的视频）"],
        ["返回键回到原来那个视频", 300, function () { key(KEY.RETURN); return null; }],
        ["回到原来的视频，面板开着，焦点在点过的那张", 1000, function () {
            if (visible("shell")) { return "返回键退回了首页"; }
            /* The picture too: the scrub steps after this need its duration. */
            if (visible("player-loading")) { return WAIT; }
            if (document.getElementById("player-title").textContent !== rel.title) { return WAIT; }
            if (!visible("options")) { return WAIT; }
            var f = Nav.current(), box = document.getElementById("opt-related");
            return f && box && box.contains(f) && Number(f.getAttribute("data-i")) === rel.pick ? null
                : "面板开了，焦点却不在点过的第 " + (rel.pick + 1) + " 张上";
        }, 20000, "20 秒了还没回到原来那个视频的相关推荐"],
        ["返回键收起面板", 700, function () {
            key(KEY.RETURN);
            return null;
        }],
        ["面板已收起，仍在播放", 700, function () {
            if (visible("options")) { return "面板没有收起"; }
            if (visible("shell")) { return "收面板把播放也退出了"; }
            return null;
        }],
        ["右键进入拖动", 800, function () {
            key(KEY.RIGHT); key(KEY.RIGHT);
            return null;
        }],
        /* The head commits 700ms after the last press and takes the preview
         * down with it, and every step here waits longer than that — so this
         * one presses for itself and checks in the same tick. `paintScrub` is
         * synchronous, so by the time the press returns the thumbnail is either
         * there or it never was. The sheets are a separate request, which is
         * what this catches: a preview box that appears and stays black. */
        ["拖动时有缩略图预览", 1200, function () {
            key(KEY.RIGHT);
            var box = document.getElementById("scrub-preview");
            if (!box || box.className.indexOf("hidden") >= 0) { return "拖动时没有出现预览框"; }
            var bg = document.getElementById("scrub-thumb").style.backgroundImage;
            if (!bg || bg === "none") { return "预览框出来了但没有取到缩略图"; }
            post("预览：" + bg.replace(/^url\(["']?|["']?\)$/g, "").split("/").pop());
            return null;
        }],
        ["拖动生效并落点", 2500, function () {
            var t = document.getElementById("player-pos").textContent;
            return (t && t !== "0:00") ? null : "拖动之后进度仍是 0:00";
        }],

        /* The one that needs the segment index. A short scrub lands inside what
         * is already buffered and proves nothing; this jumps clear of it, which
         * used to be refused outright on the DASH path and — when it was the
         * resume point rather than a keypress — made the player download the
         * whole file up to that second and throw all of it away. */
        ["跨出缓冲区的远距离拖动", 900, function () {
            var dur = secs(document.getElementById("player-dur").textContent);
            var now = secs(document.getElementById("player-pos").textContent);
            window.__stFar = false;
            /* 8 presses is 3:30 (210s) by the step ladder in app.js — well past
             * the 60 s the pump keeps ahead of the playhead.
             *
             * Direction depends on where resume left us. Every run of this test
             * leaves a resume point further into the same video, and once it
             * sat near the end the forward jump clamped onto the closing
             * seconds: the video finished mid-check, autoplay pulled in the
             * next one, and the readout — now the new video's 2s — failed a
             * step whose playback was perfectly healthy (19:40 run,
             * 2026-08-03). Backwards from there is just as far outside the
             * buffer: bufferBehind keeps 120s and this jumps 210. */
            var canForward = dur - now >= 300;
            /* 345, not 330: the jump is 210s and the landing check demands
             * strictly more than 120s, so 330 lands exactly on the boundary
             * and fails a healthy player. */
            var canBack = now >= 345;
            if (!canForward && !canBack) {
                post("拖动：位置 " + now + "s/" + dur + "s 两头都不够远，跳过远距离拖动");
                return null;
            }
            window.__stFar = true;
            for (var i = 0; i < 8; i++) { key(canForward ? KEY.RIGHT : KEY.LEFT); }
            return null;
        }],
        ["跳转落在远处", 9000, function () {
            if (!window.__stFar) { return null; }
            var t = secs(document.getElementById("player-pos").textContent);
            window.__stSeekTo = t;
            return t > 120 ? null : "远距离拖动之后位置只有 " + t + "s";
        }],
        /* Fifteen seconds, because a far seek is one of the places a web-token
         * 403 shows up, and the strong-token rescue behind it measured 13s on
         * 2026-08-15 (403 → app endpoint → self-read sidx for twelve tiers →
         * rebuild). At 7s this step checked in the same second playback resumed
         * and reported 「那里没有缓冲到」 — a confident, specific, wrong diagnosis
         * of a player that was fine, which is the failure mode this file is
         * least allowed to have. The message now says what it actually knows. */
        ["跨区之后确实播得下去", 15000, function () {
            if (!window.__stFar) { return null; }
            var t = secs(document.getElementById("player-pos").textContent);
            /* If the jump was refused or nothing buffered there, the readout
             * sits exactly where the scrub left it and never advances. */
            return t > window.__stSeekTo
                ? null
                : "跳到 " + window.__stSeekTo + "s 后十五秒内进度没前进（现在 " + t +
                  "s）——要么那里取不到字节，要么救援还没跑完，去日志看这段时间有没有 403/强令牌";
        }],
        /* The far drag above, pressed while the player is torn down for a
         * rebuild — where the TV selftest of 2026-10-18 happened to press it,
         * one second into a strong-token rescue, and the picture came back at
         * the rescue's 0:46. The rebuild is staged (__stRebuild) because a 403
         * cannot be ordered up. */
        ["重建当中按的拖动", 600, function () {
            window.__stRb = 0;
            if (typeof window.__stRebuild !== "function") { return "没有 __stRebuild 这个入口"; }
            var dur = secs(document.getElementById("player-dur").textContent);
            var now = secs(document.getElementById("player-pos").textContent);
            /* The jump is 210s and the landing check wants 150 of it; the
             * first TV run (283s into a 568s video) skipped on the far drag's
             * 300/345, which guard a stricter check than this one. */
            var dir = dur - now >= 240 ? 1 : now >= 230 ? -1 : 0;
            if (!dir) { post("重建拖动：位置 " + now + "s/" + dur + "s 两头都不够远，跳过"); return null; }
            if (!window.__stRebuild(2500)) { post("重建拖动：不是 DASH，跳过"); return null; }
            window.__stRb = dir;
            window.__stRbFrom = now;
            for (var i = 0; i < 8; i++) { key(dir > 0 ? KEY.RIGHT : KEY.LEFT); }
            return null;
        }],
        ["重建之后落在拖动的地方", 2000, function () {
            if (!window.__stRb) { return null; }
            var t = secs(document.getElementById("player-pos").textContent);
            var moved = (t - window.__stRbFrom) * window.__stRb;
            return moved > 150 && Player.mode() ? null : WAIT;
        }, 15000, function () {
            return "等了 15 秒，位置 " + document.getElementById("player-pos").textContent +
                   "，拖动前在 " + window.__stRbFrom + "s（播放器 " + (Player.mode() || "没起来") + "）";
        }],
        ["确认键暂停", 600, function () {
            key(KEY.ENTER);
            return null;
        }],
        ["暂停图标出现", 600, function () {
            return visible("pause-glyph") ? null : "暂停后没有暂停图标";
        }],
        ["确认键继续", 400, function () { key(KEY.ENTER); return null; }],
        ["暂停图标消失", 600, function () {
            return visible("pause-glyph") ? "继续播放后暂停图标还在" : null;
        }],
        /* The branch the first field sample landed on (08-15, three hours
         * suspended): the set slept with a video playing, so the wake was
         * deferred rather than done. What is behind the player is then last
         * night's screen, and it has to be replaced on the way out — before the
         * fix, backing out handed it straight back. */
        ["播放中来了一次挂起恢复", 300, function () {
            if (typeof window.__stWake !== "function") { return "没有 __stWake 这个入口"; }
            window.__stPlayFeedBefore = window.__stItems;
            window.__stWake();
            if (visible("shell")) { return "唤醒把正在播放的视频掀掉了"; }
            return null;
        }],
        /* The end-of-video screen, which no key press can reach inside a run
         * this short — so the video is sent to four seconds from its end and the
         * real `ended` event does the rest. It shipped on 08-15 having never run
         * on the television once. */
        ["跳到片尾，让视频自己播完", 800, function () {
            if (typeof window.__stNearEnd !== "function") { return "没有 __stNearEnd 这个入口"; }
            return window.__stNearEnd() ? null : "拿不到时长，跳不过去";
        }],
        /* Polled rather than waited for. How long the end takes to arrive is
         * the CDN's business: 2026-10-18 the last four seconds of a three-hour
         * upload took 13.5s to come back (a cold range at the far end of the
         * file, ABR down to 360p on the way) — past both fixed waits this used
         * to have, and the four steps after them went red about a screen that
         * showed up a second later. The press that stops the countdown is still
         * made in the same call that finds the screen. */
        ["播完后出现「即将播放」界面", 3000, function () {
            return visible("nextup") ? checkChooser() : WAIT;
        }, 25000, "视频播完了但没有出现即将播放界面"],
        ["下键之后焦点在相关推荐里，倒计时停住", 600, function () {
            if (window.__stNoRelated) { post("跳过：这个视频没有相关推荐"); return null; }
            if (!visible("nextup")) {
                return "即将播放界面在按下键之后不见了——倒计时抢先开播了下一个";
            }
            if (!document.querySelector("#nextup-related .card.focused")) {
                return "按下键没有走进相关推荐那一行";
            }
            if (document.getElementById("nextup-count")) {
                return "走进相关推荐了，倒计时却还在跑——它会从观众手底下自己开播";
            }
            return null;
        }],
        /* The grid is meant to keep going: one row is painted while the
         * countdown runs (those thumbnails compete with the next video's start),
         * and the rest arrives as the focus walks into it. Both halves are
         * checked here — that more cards showed up than were first painted, and
         * that the screen actually followed the focus below the fold. The second
         * half is the one that fails silently: losing the `scroll` class on
         * #nextup leaves the ring moving onto cards nobody can see. */
        ["相关推荐能一直往下翻", 700, function () {
            if (window.__stNoRelated) { post("跳过：这个视频没有相关推荐"); return null; }
            if (!visible("nextup")) { return "即将播放界面不见了"; }
            var total = typeof window.__stNextupTotal === "function"
                        ? window.__stNextupTotal() : 0;
            var cards = count("#nextup-related .card");
            post("即将播放：相关推荐一共 " + total + " 个，已经画出 " + cards + " 张");
            if (total <= 3) {
                /* A short related list is a legitimate answer, not a failure —
                 * say which one it is rather than going red on the viewer's
                 * behalf. */
                window.__stNextupShort = true;
                return null;
            }
            if (cards <= 3) {
                return "走进相关推荐了，却还是只有第一行那三张——网格没有接着长";
            }
            window.__stNextupScroll = document.getElementById("nextup").scrollTop;
            key(KEY.DOWN);
            return null;
        }],
        ["翻到第二行，屏幕跟着滚下去了", 600, function () {
            if (window.__stNoRelated || window.__stNextupShort) { return null; }
            if (!visible("nextup")) { return "即将播放界面不见了"; }
            var f = document.querySelector("#nextup-related .card.focused");
            if (!f) { return "再按下键没有停在相关推荐里"; }
            if (Number(f.getAttribute("data-i")) < 3) {
                return "再按下键没有走到第二行";
            }
            var top = document.getElementById("nextup").scrollTop;
            post("即将播放：焦点第 " + f.getAttribute("data-i") + " 张，屏幕滚到 " + Math.round(top));
            if (!(top > window.__stNextupScroll)) {
                return "焦点走到第二行了，屏幕却没有跟着滚——卡片在看不见的地方";
            }
            return null;
        }],
        ["返回键从即将播放界面退出", 900, function () { key(KEY.RETURN); return null; }],
        ["即将播放界面收干净了", 700, function () {
            if (visible("nextup")) { return "即将播放界面没有收起来"; }
            /* If autoplay won the race anyway, the run is now inside the next
             * video and every later step would fail about a screen nobody is
             * on. One press back out, and say so — a cascade of red steps is a
             * worse report than one honest note. */
            if (!visible("shell")) {
                post("提示：倒计时抢先开播了下一个，按返回退出");
                key(KEY.RETURN);
            }
            return null;
        }],

        /* Six seconds, not three and a half: what this waits for is no longer a
         * cached grid being restored but a live feed request — payOwedWake
         * clears the cache and refetches, and the wake path is allowed one
         * silent three-second retry on top. At 3500ms a slow-but-healthy fetch
         * failed the step with 「重刷没补上」, which is a confident, specific and
         * wrong diagnosis — worse than no step at all. */
        ["回到首页网格", 6000, function () {
            if (!visible("shell")) { return "没有回到浏览界面"; }
            if (!count("#screen .card")) { return "回来后网格是空的"; }
            var f = document.querySelector("#screen .card.focused");
            if (!f) { return "回来后没有任何卡片被选中"; }
            /* Owed refresh paid: a new array rather than the cache restored. */
            if (window.__stItems === window.__stPlayFeedBefore) {
                return "挂起期间欠下的重刷没补上，回来的还是老那份首页";
            }
            if (f !== document.querySelector("#screen .card")) {
                return "补刷之后光标没有回到第一张卡片";
            }
            return null;
        }],

        /* The decisive one for multiple accounts, and it can only be answered
         * here — the question is what this firmware puts on the wire.
         *
         * This step existed before 2026-08-09 and did not catch the failure it
         * was written for. It asked whether the server recognised *somebody*,
         * and called that proof that a chosen account reaches it. Those are not
         * the same claim: the engine's jar is global and holds one account, so
         * with one account on the set it answers correctly no matter which route
         * carried the request. The Cookie header had in fact never arrived, and
         * this step said 认得 X every time.
         *
         * The claim is only worth anything against *which* account. So compare
         * the mid the server answers with against the mid the login handed us —
         * a disagreement means the request carried somebody else, which is the
         * whole bug, and it is a failure rather than a note. */
        ["送达服务器的是不是当前这个账号", 200, function () {
            var acc = (typeof Accounts !== "undefined") && Accounts.active();
            if (!acc) { post("账号：这台电视上没有登录账号，跳过"); return null; }

            var route = Auth.accessKey() ? "access_key"
                      : (Auth.jarIsOurs() ? "cookie jar" : "没有可用凭证");
            post("账号：共 " + Accounts.count() + " 个，当前 " + acc.id +
                 " mid=" + acc.mid + "，走 " + route);
            API.nav(function (me) {
                if (!me.isLogin) {
                    identityVerdict = "服务器不认这个会话（route=" + route + "）";
                } else if (acc.mid && me.mid && acc.mid !== me.mid) {
                    identityVerdict = "服务器认得的是 mid=" + me.mid + " " + me.uname +
                                      "，不是当前账号 mid=" + acc.mid +
                                      " —— 请求没带上被选中的那个账号";
                } else {
                    identityVerdict = "";
                    post("账号：服务器认得 " + me.uname + " mid=" + me.mid +
                         "，与当前账号一致（route=" + route + "）");
                }
            }, function (why) { identityVerdict = "nav 失败 " + why; });
            return null;
        }],
        /* The answer arrives asynchronously, and a step only counts as failed by
         * returning a reason — so the verdict is collected here rather than
         * posted from inside the callback, where the tally would never see it. */
        ["等待凭证检查", 3500, function () { return identityVerdict; }],

        /* The switcher is reachable only by remote, so walk to it the way a
         * viewer does: up out of the grid, then right past every tab. */
        ["上键离开网格进入顶栏", 500, function () {
            key(KEY.UP);
            return null;
        }],
        ["右键走到账号位", 600, function () {
            /* One press per tab plus slack. This said 8 when there were six
             * tabs; four zone tabs later it stopped short of the chip and the
             * account steps all failed for a reason that had nothing to do with
             * accounts. */
            for (var i = 0; i < 16; i++) { key(KEY.RIGHT); }
            var f = document.getElementById("account");
            return (f && f.className.indexOf("focused") >= 0)
                ? null : "右键走到头也没停在账号位上";
        }],
        ["确认键打开账号页", 1200, function () { key(KEY.ENTER); return null; }],
        ["账号页或登录页出现", 900, function () {
            var accounts = count("#screen .accounts");
            var login = count("#screen .login");
            if (!accounts && !login) { return "既没有账号页也没有登录页"; }
            if (login) { post("账号：一个账号都没有，开的是登录页"); return null; }
            if (!count("#screen .acc")) { return "账号页上一个头像都没有"; }
            if (count("#screen .acc.on") > 1) { return "同时有多个账号标着「当前」"; }
            /* 添加账号 is always the last tile; without it a second person can
             * never get onto the television. */
            var tiles = document.querySelectorAll("#screen .acc");
            var add = tiles[tiles.length - 1].getAttribute("data-id");
            if (add !== "__add") { return "没有「添加账号」入口"; }
            post("账号：账号页有 " + (tiles.length) + " 个格子");
            return null;
        }],
        ["焦点落在某个账号上", 400, function () {
            var f = document.querySelector("#screen .acc.focused");
            return f ? null : "账号页打开了但没有任何格子被选中";
        }],

        /* Removing an account was reachable, and had never once been walked —
         * the run stopped at "the tiles are here". On 2026-08-09 it was asked
         * for as a feature that did not exist, which is what an unwalked path
         * eventually becomes. The steps below go all the way to the confirmation
         * and then press 取消: the path gets exercised, nobody's account and
         * nobody's watch history gets destroyed by a test. */
        ["下键从头像走到删除账号按钮", 500, function () {
            if (!onAccounts()) { return null; }
            key(KEY.DOWN);
            return null;
        }],
        ["焦点停在删除账号上", 400, function () {
            if (!onAccounts()) { return null; }
            var f = document.querySelector("#screen .btn.focused");
            return (f && f.id === "btn-manage") ? null : "从头像按下键没走到删除账号按钮";
        }],
        ["确认键进入删除模式", 700, function () {
            if (!onAccounts()) { return null; }
            key(KEY.ENTER);
            return null;
        }],
        ["删除模式打开，焦点回到头像上", 600, function () {
            if (!onAccounts()) { return null; }
            if (!count("#screen .accounts.managing")) { return "按了删除账号却没进入删除模式"; }
            if (!document.querySelector("#screen .acc.focused")) {
                return "删除模式里没有任何头像被选中";
            }
            /* 访客 and 添加账号 have to be gone: pressing 确认 on either here
             * would do nothing, which is the shape of failure this app is worst
             * at showing. */
            var tiles = document.querySelectorAll("#screen .acc");
            var last = tiles[tiles.length - 1].getAttribute("data-id");
            if (last === "__add" || last === "__guest") { return "删除模式里还留着删不掉的格子"; }
            return null;
        }],
        ["确认键打开删除确认框", 700, function () {
            if (!onAccounts()) { return null; }
            key(KEY.ENTER);
            return null;
        }],
        ["确认框出现，焦点停在取消上", 600, function () {
            if (!onAccounts()) { return null; }
            if (!count("#screen .acc-confirm")) { return "选中账号后没有出现删除确认框"; }
            var f = document.querySelector("#screen .btn.focused");
            return (f && f.id === "btn-cancel") ? null : "删除确认框的焦点没有停在取消上";
        }],
        ["按取消，不真的删", 700, function () {
            if (!onAccounts()) { return null; }
            key(KEY.ENTER);
            return null;
        }],
        ["取消之后回到账号列表", 700, function () {
            if (!onAccounts()) { return null; }
            if (count("#screen .acc-confirm")) { return "取消之后确认框还在"; }
            if (!count("#screen .acc")) { return "取消之后账号列表没了"; }
            return null;
        }],

        ["返回键离开账号页", 1500, function () { key(KEY.RETURN); return null; }],
        ["回到浏览界面", 2500, function () {
            if (!visible("shell")) { return "没有回到浏览界面"; }
            if (count("#screen .accounts")) { return "账号页没有关掉"; }
            return null;
        }],

        /* Switching the set off and on again, which is the one journey no key
         * press can produce: Tizen suspends instead of killing, so it comes back
         * to the same JS context — and used to come back to last night's feed
         * with the cursor wherever it was left. `__stWake` is the only internal
         * this run calls directly, because the event that drives it belongs to
         * the platform. */
        ["模拟关机再开机", 400, function () {
            if (typeof window.__stWake !== "function") { return "没有 __stWake 这个入口"; }
            window.__stFeedBefore = window.__stItems;
            window.__stWake();
            return null;
        }],
        ["醒来后首页重刷，光标回到继续观看", 5000, function () {
            if (!visible("shell")) { return "醒来后没有停在浏览界面"; }
            if (!count("#screen .card")) { return "醒来后网格是空的"; }
            /* A new array means the feed was fetched again; repainting the cache
             * would hand back the very same one, and that is the whole point of
             * this step. */
            if (window.__stItems === window.__stFeedBefore) {
                return "首页没有重新取，还是醒来之前那一份";
            }
            var f = document.querySelector("#screen .card.focused");
            if (!f) { return "醒来后没有任何卡片被选中"; }
            if (f !== document.querySelector("#screen .card")) {
                return "光标没有回到第一张卡片";
            }
            var row = document.getElementById("resume-row");
            if (row && row.querySelectorAll(".card")[0] !== f) {
                return "有继续观看那一行，光标却不在它第一张上";
            }
            post(row ? "醒来：重取了首页，光标在继续观看第一张"
                     : "醒来：重取了首页，没有续播行，光标在推荐第一张");
            return null;
        }],

        /* The uploader page, reached the way a viewer reaches it: a video is
         * playing, 下键 pulls the panel, 上键 lands on the uploader chip, 确认
         * opens the page, 返回 comes back to the tab it was opened from. Last in
         * the run because it leaves the player. What this catches: the chip
         * missing or nameless (the mid never made it onto the card), the page
         * coming up empty (the app endpoint refused — the web one is gated by
         * IP and would fail this two times in three), the tab bar still
         * highlighting a tab on a screen that has none, and 返回 going to 推荐
         * by way of a reload instead of restoring where it came from. */
        ["再开一个视频，为了走到 UP 主页", 600, function () {
            if (!visible("shell")) { return "不在浏览界面"; }
            if (!document.querySelector("#screen .card.focused")) { return "没有选中的卡片"; }
            key(KEY.ENTER);
            return null;
        }],
        ["画面起来了", 8000, function () {
            if (visible("player-loading")) { return "八秒后仍停在加载画面"; }
            if (visible("shell")) { return "没有进入播放"; }
            return null;
        }],
        ["下键拉出面板", 1200, function () { key(KEY.DOWN); return null; }],
        /* 上一集 / 下一集 (PR #9, 10-25). Most recommended videos are one part
         * outside any 合集, so most runs only check that the buttons are not
         * there; with a next one, the panel must open on it and 确认 must play
         * it. In this block because it leaves the player anyway. */
        ["面板的上一集 / 下一集跟着分 P 和合集走，有下一集就按", 900, function () {
            if (!visible("options")) { return "面板没有出现"; }
            rel.epFrom = null;
            var prev = visible("panel-prev-episode"), next = visible("panel-next-episode");
            var parts = document.querySelectorAll("#opt-parts .opt[data-cid]"), at = -1;
            for (var i = 0; i < parts.length; i++) { if (/\bcurrent\b/.test(parts[i].className)) { at = i; } }
            if (!visible("opt-parts-group") && !visible("opt-season-group") && (prev || next)) {
                return "没有分 P 也不在合集里，面板却有" + (next ? "下一集" : "上一集");
            }
            if (at >= 0 && at < parts.length - 1 && !next) { return "正在看 P" + (at + 1) + " / " + parts.length + "，面板没有下一集"; }
            if (at > 0 && !prev) { return "正在看 P" + (at + 1) + "，面板没有上一集"; }
            if (!next) { post("跳过：这个视频后面没有下一 P，也没有合集的下一集"); return null; }
            var btn = document.getElementById("panel-next-episode");
            /* The part list can arrive after the panel opened, and a list that
             * lands later must not move the focus — so reopen once, the way
             * a viewer would, before holding it to where the panel opens. */
            if (Nav.current() !== btn) { key(KEY.RETURN); key(KEY.DOWN); }
            if (Nav.current() !== btn) { return "有下一集，面板却没有开在它上面"; }
            rel.epFrom = document.getElementById("player-title").textContent + " · " +
                         document.getElementById("player-part").textContent;
            key(KEY.ENTER);
            return null;
        }],
        ["按了下一集：换过去，画面起来了", 1000, function () {
            if (!rel.epFrom) { return null; }
            if (visible("shell")) { return "按了下一集退回了网格"; }
            if (visible("options")) { return "按了下一集，面板还开着"; }
            var now = document.getElementById("player-title").textContent + " · " +
                      document.getElementById("player-part").textContent;
            if (now === rel.epFrom || visible("player-loading")) { return WAIT; }
            post("下一集：" + rel.epFrom.slice(0, 30) + " → " + now.slice(0, 30));
            return null;
        }, 20000, "20 秒了下一集还没放起来"],
        ["下键再拉出面板", 1200, function () {
            if (rel.epFrom) { key(KEY.DOWN); }
            return null;
        }],
        ["面板顶上有 UP 主芯片", 900, function () {
            if (!visible("options")) { return "面板没有出现"; }
            var chip = document.getElementById("panel-up");
            if (!chip || chip.offsetParent === null) { return "面板里没有 UP 主芯片"; }
            if (!chip.textContent) { return "UP 主芯片上没有名字"; }
            rel.upVideo = document.getElementById("player-title").textContent;
            post("UP 主芯片：" + chip.textContent);
            return null;
        }],
        /* The ring opens on the playing part, the playing 合集 episode or the
         * first related card, and the chip is the only focusable above all of
         * them. One press too many closes the panel, which is why each press
         * checks first. */
        ["上键走到 UP 主芯片", 600, function () {
            /* Not four any more: a 合集 lists every episode and wraps, and the
             * ring opens on the current one — 10-18 that was the 23rd of a long
             * season, four presses stayed inside the row, and the 确认 meant
             * for the chip played episode 24. */
            /* ⟶ 10-18 23:27: 24 was not enough either — 「导演·2025」 runs past a
             * hundred episodes, the row wraps into twenty-odd lines, and the
             * 确认 meant for the chip played episode 24. Pressed until the chip
             * has the ring (each press checks first, so it cannot overshoot and
             * close the panel), and the count is logged: that many presses is a
             * cost the viewer pays too. */
            for (var i = 0; i < 300; i++) {
                if (document.querySelector("#panel-up.focused")) { break; }
                /* 关注 shares the chip's row and can take the ring first; one
                 * more 上 from it closes the panel (review, 10-20). */
                if (document.querySelector("#panel-follow.focused")) { key(KEY.LEFT); continue; }
                key(KEY.UP);
            }
            if (i > 6) { post("走到 UP 主芯片按了 " + i + " 次上键（选集那一排很长）"); }
            if (!visible("options")) { return "上键把面板关了，没有停在芯片上"; }
            return document.querySelector("#panel-up.focused") ? null : "焦点没有走到 UP 主芯片";
        }],
        ["确认键进 UP 主页", 600, function () { key(KEY.ENTER); return null; }],
        ["UP 主页：有页眉、有卡片、页签不高亮", 5000, function () {
            if (!visible("shell")) { return "没有离开播放器回到浏览界面"; }
            var head = document.getElementById("up-head");
            if (!head) { return "屏幕上没有 UP 主页眉"; }
            var n = count("#feed-grid .card");
            post("UP 主页：" + head.textContent.trim().slice(0, 24) + "，" + n + " 张卡片");
            if (!n) { return "UP 主页没有卡片"; }
            if (document.querySelector("#tabs .tab.active")) { return "UP 主页上还有页签在高亮"; }
            if (!document.querySelector("#feed-grid .card.focused")) { return "光标没有落在 UP 主页的卡片上"; }
            /* 关注 (10-20): read, never pressed. */
            var follow = document.getElementById("up-follow");
            if (Auth.isLoggedIn() && (!follow || follow.offsetParent === null)) {
                post("UP 主页没有关注按钮（可能是自己的主页，或状态还没读到）");
            }
            return null;
        }],
        /* 返回 from an UP page opened in the panel goes back to the video, at
         * that second, the ring on the chip (10-20, the viewer: 「应该退到刚刚
         * 那个视频呀」); the tab is two more presses away. */
        ["返回键回到刚才那个视频", 600, function () { key(KEY.RETURN); return null; }],
        ["回到那个视频，面板开着，焦点在 UP 主芯片", 1000, function () {
            if (visible("shell")) { return "返回键退回了网格，没有回到视频"; }
            if (visible("player-loading")) { return WAIT; }
            if (document.getElementById("player-title").textContent !== rel.upVideo) { return WAIT; }
            if (!visible("options")) { return WAIT; }
            return document.querySelector("#panel-up.focused") ? null : "面板开了，焦点却不在 UP 主芯片上";
        }, 15000, "15 秒了还没回到刚才那个视频"],
        ["返回键收起面板", 700, function () { key(KEY.RETURN); return null; }],
        ["再按返回回到网格", 700, function () {
            if (visible("options")) { return "面板没有收起"; }
            key(KEY.RETURN);
            return null;
        }],
        ["回到首页：页签重新高亮，页眉没了", 2500, function () {
            if (!visible("shell")) { return "返回之后不在浏览界面"; }
            if (document.getElementById("up-head")) { return "返回之后 UP 主页眉还在"; }
            if (!document.querySelector('#tabs .tab.active[data-screen="rcmd"]')) { return "返回之后推荐页签没有高亮"; }
            if (!count("#screen .card")) { return "返回之后网格是空的"; }
            if (!document.querySelector("#screen .card.focused")) { return "返回之后没有选中的卡片"; }
            return null;
        }],
        ["设置入口能用遥控器打开", 300, function () {
            Nav.focus(document.querySelector('#tabs .tab[data-screen="search"]'));
            key(KEY.RIGHT);
            var tab = document.querySelector('#tabs .tab.focused[data-screen="settings"]');
            if (!tab) { return "右键没有到设置页签"; }
            key(KEY.ENTER);
            return document.querySelector("#btn-autoplay.focused") ? null : "设置没有把焦点放在自动播放开关";
        }],
        ["自动播放开关可切换并保留", 300, function () {
            var before = Settings.get("autoplayNext", true) === true;
            key(KEY.ENTER);
            var changed = Settings.get("autoplayNext", true) === !before;
            var label = document.getElementById("btn-autoplay").textContent;
            Nav.focus(document.querySelector('#tabs .tab[data-screen="settings"]'));
            key(KEY.ENTER);
            var retained = Settings.get("autoplayNext", true) === !before;
            var shown = document.getElementById("btn-autoplay").textContent === label;
            key(KEY.ENTER); /* Restore the viewer's preference. */
            return changed && retained && shown && Settings.get("autoplayNext", true) === before
                ? null : "开关切换、重进设置或恢复原偏好失败";
        }],
        /* PR #10 (10-25): three places, so three presses come back round. */
        ["弹幕位置按三下转一圈回到原值", 300, function () {
            var btn = document.getElementById("btn-danmaku-area");
            if (!btn) { return "设置页里没有弹幕位置"; }
            var before = Settings.get("danmakuArea", "upper"), seen = {}, n = 0;
            Nav.focus(btn);
            for (var i = 0; i < 3; i++) {
                key(KEY.ENTER);
                if (!seen[btn.textContent]) { seen[btn.textContent] = 1; n++; }
            }
            Nav.focus(document.getElementById("btn-autoplay"));
            post("弹幕位置：" + Object.keys(seen).join(" → "));
            return n === 3 && Settings.get("danmakuArea", "upper") === before
                ? null : "三下看到 " + n + " 种写法，设置 " + before + " → " + Settings.get("danmakuArea", "upper");
        }],
        /* 2026-10-21. Only that the section is there and says what it should;
         * uploading is --diag's job, and this build has nowhere to send to. */
        ["诊断日志：开关、上传按钮在，写着这台电视的编号", 300, function () {
            var btn = document.getElementById("btn-diag"), st = document.getElementById("diag-status");
            if (!btn || !document.getElementById("btn-diag-upload") || !st) { return "设置页里没有诊断日志那一节"; }
            if (btn.textContent !== "诊断日志：" + (Diag.enabled() ? "开" : "关")) { return "开关上写的是「" + btn.textContent + "」"; }
            return !Diag.enabled() || /编号 [A-Z2-9]{4}-[A-Z2-9]{4}/.test(st.textContent) ? null
                : "状态行里没有编号：" + st.textContent;
        }],
        /* 2026-10-23, issue #8: on a Chromium 56 set focus went down 设置 and
         * the page stayed put, the bottom half out of reach. Every press here
         * must leave the focused button inside #screen. */
        ["设置页一路按下键，页面跟着滚", 300, function () {
            var screen = document.getElementById("screen");
            Nav.focus(document.getElementById("btn-autoplay"));
            var start = screen.scrollTop, lost = 0, sr = screen.getBoundingClientRect();
            for (var i = 0; i < 12; i++) {
                key(KEY.DOWN);
                var r = Nav.current().getBoundingClientRect();
                if (r.top < sr.top - 2 || r.bottom > sr.bottom + 2) { lost++; }
            }
            var end = screen.scrollTop, at = Nav.current().id || Nav.current().textContent;
            Nav.focus(document.getElementById("btn-autoplay"));
            post("设置页按 12 下下键：到了 " + at + "，scrollTop " + start + " → " + end + "，焦点出画面 " + lost + " 次");
            return lost === 0 && end > start + 100 ? null
                : "焦点出画面 " + lost + " 次，scrollTop " + start + " → " + end + "（到了 " + at + "）";
        }],
        ["退出设置回到推荐", 300, function () {
            key(KEY.RETURN);
            return document.querySelector('#tabs .tab.active[data-screen="rcmd"]') ? null : "没有回到推荐";
        }],

        /* ---- PR #2's features (2026-10-18). Read-only: nothing here writes to
         * the account, and every setting touched is put back. ---- */
        ["每行视频 3→4→5 转一圈回到原值", 600, function () {
            Nav.focus(document.querySelector('#tabs .tab[data-screen="settings"]'));
            key(KEY.ENTER);
            var btn = document.getElementById("btn-density");
            if (!btn) { return "设置页里没有每行视频按钮"; }
            var start = Settings.get("gridColumns", 3), seen = [];
            for (var i = 0; i < 3; i++) {
                Nav.focus(btn);
                key(KEY.ENTER);
                var n = Settings.get("gridColumns", 3);
                var cls = Number((/density-([45])/.exec(document.body.className) || [0, 3])[1]);
                if (cls !== n) { return "设成 " + n + " 个，页面却是 " + cls + " 列"; }
                if (btn.textContent.indexOf(n + " 个") < 0) { return "按钮上没写当前值 " + n; }
                seen.push(n);
            }
            post("每行视频：" + start + " → " + seen.join(" → "));
            return Settings.get("gridColumns", 3) === start ? null : "转一圈没有回到原值";
        }],
        /* 2026-10-18: the quality cap and 清空观看记录. The clear button is only
         * armed, never fired — a selftest must not empty someone's history. */
        ["画质上限转一圈回到原值", 600, function () {
            var btn = document.getElementById("btn-quality");
            if (!btn) { return "设置页里没有画质按钮"; }
            var start = Settings.qnCap(), seen = [];
            for (var i = 0; i < Settings.qnSteps().length; i++) {
                Nav.focus(btn);
                key(KEY.ENTER);
                seen.push(Settings.qnCap());
                if (btn.textContent.indexOf("画质上限：") !== 0) { return "按钮上没写画质上限"; }
            }
            post("画质上限：" + start + " → " + seen.join(" → "));
            return Settings.qnCap() === start ? null : "转一圈没有回到原值";
        }],
        ["清空观看记录要按两下（只按一下，不真清）", 300, function () {
            var btn = document.getElementById("btn-clear-history");
            if (!btn) { return "设置页里没有清空观看记录按钮"; }
            var before = Resume.clearedAt();
            Nav.focus(btn);
            key(KEY.ENTER);
            if (Resume.clearedAt() !== before) { return "按一下就清了"; }
            return btn.textContent.indexOf("再按一次") === 0 ? null : "按一下之后没有提示再按一次";
        }],
        ["回到推荐", 300, function () {
            Nav.focus(document.querySelector('#tabs .tab[data-screen="rcmd"]'));
            key(KEY.ENTER);
            return null;
        }],
        ["首页按设置的列数排开", 4500, function () {
            var cards = document.querySelectorAll("#feed-grid .card");
            if (cards.length < 6) { return "首页卡片不够 6 张"; }
            var top = cards[0].getBoundingClientRect().top, row = 0;
            while (row < cards.length && Math.abs(cards[row].getBoundingClientRect().top - top) < 30) { row++; }
            var want = Settings.get("gridColumns", 3);
            var src = (cards[0].querySelector("img") || {}).src || "";
            post("首页第一行 " + row + " 张（设置 " + want + "），封面 " + (src.split("@")[1] || "?"));
            return row === want ? null : "第一行 " + row + " 张，设置是 " + want;
        }],

        ["进「我的」", 300, function () {
            Nav.focus(document.querySelector('#tabs .tab[data-screen="mine"]'));
            key(KEY.ENTER);
            return null;
        }],
        ["「我的」里有收藏和关注的入口", 4000, function () {
            if (!Auth.isLoggedIn()) { probe.skipMine = true; post("跳过收藏和关注：没有登录"); return null; }
            if (!document.getElementById("mine-favorites")) { return "没有「我的收藏」按钮"; }
            if (!document.getElementById("mine-following")) { return "没有「关注的 UP 主」按钮"; }
            return null;
        }],
        ["打开我的收藏", 300, function () {
            if (probe.skipMine) { return null; }
            Nav.focus(document.getElementById("mine-favorites"));
            key(KEY.ENTER);
            return null;
        }],
        ["收藏夹列表读出来了", 3500, function () {
            if (probe.skipMine) { return null; }
            var box = document.getElementById("mine-library");
            if (!box) { return "没有进到收藏夹页面"; }
            if (/读取失败/.test(box.textContent)) { return box.textContent.trim().slice(0, 60); }
            probe.folders = count("#mine-library .library-item");
            var first = document.querySelector("#mine-library .library-item strong");
            post("收藏夹 " + probe.folders + " 个" + (first ? "，第一个「" + first.textContent + "」" : ""));
            return (probe.folders || /还没有收藏夹/.test(box.textContent)) ? null : "既没有收藏夹也没说是空的";
        }],
        ["打开第一个收藏夹", 300, function () {
            if (probe.skipMine || !probe.folders) { return null; }
            Nav.focus(document.querySelector("#mine-library .library-item"));
            key(KEY.ENTER);
            return null;
        }],
        ["收藏夹里的视频读出来了", 4000, function () {
            if (probe.skipMine || !probe.folders) { return null; }
            var box = document.getElementById("mine-library");
            if (!box) { return "没有进到收藏夹里"; }
            if (/读取失败/.test(box.textContent)) { return box.textContent.trim().slice(0, 60); }
            var n = count("#mine-library .card");
            post("这个收藏夹里 " + n + " 个视频");
            return (n || /没有可播放的视频/.test(box.textContent)) ? null : "既没有视频也没说是空的";
        }],
        ["返回键退到收藏夹列表", 300, function () {
            if (probe.skipMine || !probe.folders) { return null; }
            key(KEY.RETURN);
            return null;
        }],
        ["返回键退回「我的」", 1500, function () {
            if (probe.skipMine) { return null; }
            key(KEY.RETURN);
            return null;
        }],
        ["打开关注的 UP 主", 2500, function () {
            if (probe.skipMine) { return null; }
            var b = document.getElementById("mine-following");
            if (!b) { return "返回之后没有回到「我的」"; }
            Nav.focus(b);
            key(KEY.ENTER);
            return null;
        }],
        ["关注列表读出来了", 4000, function () {
            if (probe.skipMine) { return null; }
            var box = document.getElementById("mine-library");
            if (!box) { return "没有进到关注页面"; }
            if (/读取失败|暂时无法读取/.test(box.textContent)) { return box.textContent.trim().slice(0, 60); }
            var n = count("#mine-library .library-item");
            post("关注的 UP 主 " + n + " 位");
            return (n || /还没有关注/.test(box.textContent)) ? null : "既没有 UP 主也没说是空的";
        }],
        ["退出「我的」回到推荐", 300, function () {
            if (!probe.skipMine) { key(KEY.RETURN); }
            Nav.focus(document.querySelector('#tabs .tab[data-screen="rcmd"]'));
            key(KEY.ENTER);
            return null;
        }],

        ["开一个视频看评论", 4000, function () {
            var card = document.querySelector("#feed-grid .card.focused") ||
                       document.querySelector("#feed-grid .card");
            if (!card) { return "推荐网格没有回来"; }
            Nav.focus(card);
            key(KEY.ENTER);
            return null;
        }],
        ["画面起来了（评论）", 8000, function () {
            if (visible("player-loading")) { return "八秒后仍停在加载画面"; }
            if (visible("shell")) { return "没有进入播放"; }
            key(KEY.DOWN);
            return null;
        }],
        ["面板里的「看评论」", 1200, function () {
            if (!visible("options")) { return "面板没有出现"; }
            var b = document.getElementById("panel-comments");
            if (!b || b.offsetParent === null) { return "面板里没有「看评论」"; }
            Nav.focus(b);
            key(KEY.ENTER);
            return null;
        }],
        ["评论侧栏打开，视频缩到左边接着播", 4000, function () {
            if (!visible("comments-view")) { return "评论侧栏没有出现"; }
            if (visible("options")) { return "面板没有收起"; }
            var n = count("#comments-list [data-comment-index]");
            post("评论 " + n + " 条，视频区域 " + rect("html5-video"));
            if (!n) {
                var empty = document.getElementById("comments-empty");
                return "没有评论：" + (empty ? empty.textContent : "列表是空的");
            }
            return null;
        }],
        ["右键看楼中楼", 300, function () {
            var rows = document.querySelectorAll("#comments-list [data-comment-index]");
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].querySelector(".comment-replies")) {
                    Nav.focus(rows[i]);
                    key(KEY.RIGHT);
                    probe.replies = true;
                    return null;
                }
            }
            post("前 " + rows.length + " 条评论都没有回复，跳过楼中楼");
            return null;
        }],
        ["楼中楼读出来了", 3500, function () {
            if (!probe.replies) { return null; }
            var t = document.getElementById("comments-title").textContent;
            if (t !== "楼中楼") { return "标题是「" + t + "」"; }
            var n = count("#comments-list [data-comment-index]");
            post("楼中楼 " + n + " 条");
            return n ? null : "楼中楼是空的";
        }],
        ["返回键回到评论", 300, function () {
            if (!probe.replies) { return null; }
            key(KEY.RETURN);
            return document.getElementById("comments-title").textContent === "评论" ? null : "没有回到评论";
        }],
        ["返回键关掉评论，视频回到全屏", 400, function () {
            key(KEY.RETURN);
            if (visible("comments-view")) { return "评论还开着"; }
            if (visible("shell")) { return "关评论把播放也退出了"; }
            var v = document.getElementById("html5-video");
            var w = v ? Math.round(v.getBoundingClientRect().width) : 0;
            return (!w || w === 1920) ? null : "视频没有回到全屏（宽 " + w + "）";
        }],
        ["退出播放", 500, function () { key(KEY.RETURN); return null; }],

        ["在推荐里找一个有字幕的视频", 2500, function () {
            var items = (window.__stItems || []).slice(0, 10);
            probe.subDone = false;
            findSubtitled(items, 0, function (found, scanned) {
                probe.sub = found; probe.subScanned = scanned; probe.subDone = true;
            });
            return null;
        }],
        ["下载字幕文件", 9000, function () {
            if (!probe.subDone) { return "player/v2 九秒内没问完"; }
            if (!probe.sub) { post("跳过字幕：推荐里前 " + probe.subScanned + " 个视频都没有字幕轨"); return null; }
            var t = probe.sub.tracks;
            post("字幕轨 " + t.map(function (x) { return x.lan_doc || x.lan; }).join(" / ") +
                 "（" + probe.sub.v.bvid + "，推荐第 " + (probe.sub.idx + 1) + " 个）");
            /* The first track with an address, as startSubtitles() picks: a
             * listed track can come without one (2026-10-18, the first of eight
             * on BV1W8J46KEo6), and the app itself loaded 中文 fine that minute. */
            var withUrl = t.filter(function (x) { return x && x.subtitle_url; })[0];
            /* And all of them can: BV1gnhJ6JEAA's one track came back without
             * an address on this probe (10-18 15:56), while the app's own
             * request a few seconds later loaded it and put it on screen.
             * bilibili's answer, not ours — the file check has nothing to
             * fetch, and the on-screen check below still runs. */
            if (!withUrl) { probe.noUrl = true; post("字幕轨这次都没给地址，跳过文件解析（画面那一步照样验）"); return null; }
            probe.noUrl = false;
            API.subtitle(withUrl.subtitle_url, function (cues) {
                probe.cues = cues.length;
                probe.cueFirst = cues.length ? cues[0].from : -1;
            },
                         function (why) { probe.cueErr = String(why); });
            return null;
        }],
        ["字幕文件解析出了字幕行", 3000, function () {
            if (!probe.sub || probe.noUrl) { return null; }
            if (probe.cueErr) { return "字幕文件取不到：" + probe.cueErr; }
            post("字幕 " + probe.cues + " 行");
            return probe.cues ? null : "字幕文件是空的";
        }],
        ["打开字幕开关，播这个视频", 300, function () {
            if (!probe.sub) { return null; }
            /* Twenty seconds of looking proves nothing about a file whose first
             * line comes later — BV1qqJe6yEtt (10-18) had nine lines in all. */
            if (probe.cues && probe.cueFirst > 15) {
                post("跳过画面上的字幕：第一行在 " + Math.round(probe.cueFirst) + " 秒，二十秒里看不到");
                probe.sub = null;
                return null;
            }
            probe.subWas = Settings.get("showSubtitles", false);
            Settings.set("showSubtitles", true);
            var card = document.querySelector('#feed-grid .card[data-i="' + probe.sub.idx + '"]');
            if (!card) { Settings.set("showSubtitles", probe.subWas); return "网格里找不到这张卡片"; }
            Nav.focus(card);
            key(KEY.ENTER);
            /* A line only shows while a cue is running, so look the whole time
             * rather than at one instant that might fall between two. */
            probe.subSeen = "";
            probe.subTimer = setInterval(function () {
                var tx = document.getElementById("subtitle-text");
                if (!probe.subSeen && visible("subtitle-overlay") && tx && tx.textContent) {
                    probe.subSeen = tx.textContent;
                }
            }, 250);
            return null;
        }],
        ["画面上出现了字幕", 20000, function () {
            if (!probe.sub) { return null; }
            clearInterval(probe.subTimer);
            Settings.set("showSubtitles", probe.subWas);
            if (visible("shell")) { return "没有进入播放"; }
            if (!probe.subSeen) { return "播了 20 秒，画面上一行字幕都没出现"; }
            post("字幕：「" + probe.subSeen.slice(0, 30) + "」");
            return null;
        }],
        ["退出播放，字幕开关恢复原样", 600, function () {
            if (!probe.sub) { return null; }
            key(KEY.RETURN);
            return Settings.get("showSubtitles", false) === probe.subWas ? null : "字幕开关没有恢复";
        }],

        /* 弹幕 (2026-10-18). The pool is asked first, so a video nobody has
         * commented on is a skip, not a failure; then the first recommended
         * video plays and the overlay has to show a comment within 20 s. The
         * setting is put back afterwards. */
        ["弹幕：问推荐第一个视频的弹幕池", 600, function () {
            var v = (window.__stItems || [])[0];
            probe.dm = null; probe.dmDone = false;
            if (!v || !v.cid) { probe.dmDone = true; post("跳过弹幕：推荐第一张卡片没有 cid"); return null; }
            Danmaku.load(v.cid, function (list) {
                var early = list.filter(function (d) { return d.t < 15000; }).length;
                probe.dm = { n: list.length, early: early, v: v }; probe.dmDone = true;
            },
                         function (why) { probe.dmErr = String(why); probe.dmDone = true; });
            return null;
        }],
        /* Three seconds for the pool: the first run on the set (2026-10-18)
         * gave it 0.3 s, it took longer, and the step bailed before opening the
         * video — the next one then reported an empty screen, and its 返回 on
         * the home screen closed the app. A bail now clears probe.dm, so the
         * steps after it skip. */
        ["弹幕：打开它，画面上出现弹幕", 3000, function () {
            if (!probe.dmDone) { probe.dm = null; return "弹幕池 3 秒没问完"; }
            if (probe.dmErr) { probe.dm = null; return "弹幕池取不到：" + probe.dmErr; }
            if (!probe.dm) { return null; }
            if (!probe.dm.n) { post("跳过弹幕：这个视频没人发弹幕"); probe.dm = null; return null; }
            /* The same for a pool that has nothing early: BV1qqJe6yEtt (10-18)
             * had one comment, and twenty seconds of an empty screen was right. */
            if (!probe.dm.early) {
                post("跳过弹幕：弹幕池 " + probe.dm.n + " 条，前 15 秒一条都没有");
                probe.dm = null;
                return null;
            }
            probe.dmWas = Settings.get("danmaku", "normal");
            Settings.set("danmaku", "normal");
            /* 全屏 (PR #10): the layer is the whole picture and the renderer
             * reads its height, so the rows below the default 756px fill too. */
            probe.dmAreaWas = Settings.get("danmakuArea", "upper");
            Settings.set("danmakuArea", "full");
            var card = document.querySelector('#feed-grid .card[data-i="0"]');
            if (!card) {
                Settings.set("danmaku", probe.dmWas); Settings.set("danmakuArea", probe.dmAreaWas);
                probe.dm = null; return "网格里找不到第一张卡片";
            }
            Nav.focus(card);
            key(KEY.ENTER);
            probe.dmSeen = "";
            probe.dmLow = 0;
            probe.dmTimer = setInterval(function () {
                var n = document.querySelector("#danmaku .dm");
                if (!probe.dmSeen && visible("danmaku") && n && n.textContent) { probe.dmSeen = n.textContent; }
                var all = document.querySelectorAll("#danmaku .dm");
                for (var i = 0; i < all.length; i++) {
                    var top = all[i].getBoundingClientRect().top;
                    if (top >= 756 && top > probe.dmLow) { probe.dmLow = Math.round(top); }
                }
            }, 250);
            return null;
        }],
        ["弹幕：20 秒内画面上有弹幕", 20000, function () {
            if (!probe.dm) { return null; }
            clearInterval(probe.dmTimer);
            var h = document.getElementById("danmaku").clientHeight;
            post("弹幕池 " + probe.dm.n + " 条，画面上：「" + (probe.dmSeen || "").slice(0, 20) + "」；全屏，弹幕层高 " + h +
                 (probe.dmLow ? "，最低一条在 " + probe.dmLow + "px" : "，756px 以下没飞过弹幕"));
            if (!probe.dmSeen) { return "播了 20 秒，画面上一条弹幕都没出现"; }
            return h === 1080 ? null : "弹幕位置设成全屏，弹幕层只有 " + h + "px 高";
        }],
        ["弹幕：退出播放，设置恢复原样", 600, function () {
            if (!probe.dm) { return null; }
            Settings.set("danmakuArea", probe.dmAreaWas);
            if (visible("shell")) { Settings.set("danmaku", probe.dmWas); return "不在播放（没有返回，免得在首页按返回把应用退了）"; }
            key(KEY.RETURN);
            Settings.set("danmaku", probe.dmWas);
            return visible("danmaku") ? "退出播放之后弹幕层还在" : null;
        }],

        /* 顶栏 (2026-10-18): the bar is the viewer's — added to from 设置,
         * reordered by picking a chip up and moving it, taken off with 下. One
         * of each, ending where it began, so the viewer's bar is what it was. */
        ["顶栏：设置里加一个、挪一格、拿掉", 400, function () {
            if (!visible("shell")) { return "不在首页（上一步没退出播放）"; }
            function bar() {
                return Array.prototype.map.call(document.querySelectorAll("#tabs .user-tab"),
                    function (t) { return t.getAttribute("data-screen"); }).join(",");
            }
            Nav.focus(document.querySelector('#tabs .tab[data-screen="settings"]'));
            key(KEY.ENTER);
            var was = bar(), spare = document.querySelector("#spare-chips .opt");
            if (!spare) { return "「可以加到顶栏的」那一排是空的"; }
            var k = spare.getAttribute("data-spare");
            Nav.focus(spare); key(KEY.ENTER);
            var added = bar() === (was ? was + "," : "") + k;
            Nav.focus(document.querySelector('#bar-chips .opt[data-tab="' + k + '"]'));
            key(KEY.ENTER);
            var picked = !!document.querySelector('#bar-chips .opt.picked[data-tab="' + k + '"]');
            key(KEY.LEFT);
            var order = bar().split(","), moved = order.length > 1 ? order[order.length - 2] === k : true;
            key(KEY.DOWN);
            var back = bar() === was;
            post("顶栏试的是 " + k + "：加上 " + (added ? "对" : "不对") + "，拿起 " + (picked ? "对" : "不对") +
                 "，左移 " + (moved ? "对" : "不对") + "，拿掉后 " + (back ? "和原来一样" : "是 " + bar()));
            return added && picked && moved && back ? null : "顶栏没有跟着设置变";
        }],
        ["顶栏：最右和最左的页签都滑得进画面", 300, function () {
            var bar = document.getElementById("tabs").getBoundingClientRect();
            function inView(sel) {
                var t = document.querySelector(sel);
                Nav.focus(t);
                var r = t.getBoundingClientRect();
                return r.left >= bar.left - 1 && r.right <= bar.right + 1;
            }
            var right = inView('#tabs .tab[data-screen="settings"]'), left = inView('#tabs .tab[data-screen="rcmd"]');
            return right && left ? null : ("焦点在页签上却看不见：" + (right ? "" : "设置 ") + (left ? "" : "推荐"));
        }],

        /* 直播 (2026-10-18): the tab lists rooms, the first plays, 下 changes
         * room, 返回 lands on the card of the room last watched. */
        ["直播：页签里有直播间", 500, function () {
            if (!probe.liveTab) {
                probe.liveTab = true;
                Nav.focus(document.querySelector('#tabs .tab[data-screen="live"]'));
                key(KEY.ENTER);
                return WAIT;
            }
            return count("#feed-grid .card .live-badge") ? null : WAIT;
        }, 15000, "15 秒了直播页签一张直播卡片都没有"],
        ["直播：打开第一个，出画面", 300, function () {
            if (!probe.liveOpen) {
                probe.liveOpen = true;
                Nav.focus(document.querySelector('#feed-grid .card[data-i="0"]'));
                key(KEY.ENTER);
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（直播间打不开，看 live: 那几行）"; }
            return livePlaying() ? null : WAIT;
        }, 30000, "30 秒没出画面"],
        ["直播：下键换一个直播间，出画面", 300, function () {
            if (!probe.liveNext) {
                probe.liveNext = true;
                probe.liveWas = document.getElementById("live-meta").textContent;
                key(KEY.DOWN);
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格"; }
            var moved = document.getElementById("live-meta").textContent !== probe.liveWas;
            return (moved && livePlaying()) ? null : WAIT;
        }, 30000, "换台 30 秒没出画面"],
        /* Issue #7, 10-24 (Tizen 4.0): MSE could not decode one room's 原画, and
         * that moved the whole session onto an AVPlay that played nothing — the
         * room that had just played as well. Made to order: the next Shaka
         * start reports 3016. This room should step down a tier, still on MSE
         * (a room with no lower tier goes to AVPlay by itself), and the room
         * before it should still play on MSE. */
        ["直播：MSE 解不了这个直播间（3016）→ 降一档还是 MSE，出画面", 300, function () {
            if (!probe.decode) {
                probe.decode = true;
                window.__stLiveDecodeFailOnce();
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            var st = window.__stLiveRoom() || {};
            if (st.native) { return "一个直播间解不了，整次运行都改走了 AVPlay"; }
            if (!st.mseSteps) {
                if (Player.mode() !== "avplay") { return WAIT; }
                post("直播间 " + st.room + " 没有更低的档，这个直播间改走了 AVPlay");
                return null;
            }
            if (Player.mode() === "avplay") { return "降了档却走了 AVPlay"; }
            if (Player.mode() !== "live" || !livePlaying()) { return WAIT; }
            post("直播间 " + st.room + " 降到 qn" + st.used + "，还是 MSE，出画面了");
            return null;
        }, 30000, "30 秒没降档出画面（看 live: 那几行）"],
        ["直播：上键回到前一个直播间，还是 MSE，出画面", 300, function () {
            if (!probe.decodeBack) {
                probe.decodeBack = document.getElementById("live-meta").textContent;
                key(KEY.UP);
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            if (document.getElementById("live-meta").textContent === probe.decodeBack) { return WAIT; }
            if (Player.mode() === "avplay") { return "前一个直播间走了 AVPlay"; }
            if (Player.mode() !== "live" || !livePlaying()) { return WAIT; }
            key(KEY.DOWN);   /* back to the room the steps below are in */
            return null;
        }, 30000, "30 秒没出画面"],
        /* 10-23: one room here was Shaka 4032 (nothing in its playlist this
         * engine plays) four times running, and closed. Made to order — the
         * next Shaka start reports it — the room should move to AVPlay by
         * itself, the other rooms staying on Shaka. */
        ["直播：Shaka 放不了这个直播间（4032）→ 这个直播间改走 AVPlay，时间在走", 300, function () {
            var k = probe.unsup;
            if (!k) {
                k = probe.unsup = { t0: -1 };
                window.__stLiveUnsupportedOnce();
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            if (Player.mode() !== "avplay" || visible("player-loading")) { return WAIT; }
            var t = -1;
            try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
            if (t < 0) { return WAIT; }
            if (k.t0 < 0) { k.t0 = t; return WAIT; }
            return t - k.t0 >= 1500 ? null : WAIT;
        }, 60000, "60 秒没在 AVPlay 上走起来（看 live: 那几行）"],
        /* Tizen 3.0's MSE cannot decode live (issue #5, 10-22), so there live
         * goes to AVPlay — fMP4, or TS when the TS playlist answers. No set
         * here takes that route by itself; this is where it gets played. The
         * second step lets the room choose, so whether it ran TS is in the
         * 「开 … 走 AVPlay」 line, not a pass/fail (TS is weather). */
        ["直播：同一个直播间改走 AVPlay + HLS-fMP4，出画面、时间在走", 300, function () {
            return liveNativeStep("fmp4");
        }, 25000, "25 秒没在 AVPlay 上走起来"],
        /* 10-22: rooms that 「不能播放」 on the Tizen 3.0 set sent nothing — AVPlay
         * said it was prepared, and nothing watched it after that. Pause it
         * behind the app's back: the clock stops, and the room should
         * reconnect by itself and move again. */
        ["直播：AVPlay 画面停住 → 自己重连、时间又走起来", 300, function () {
            var st = window.__stLiveRoom() || {};
            if (!probe.freeze) {
                probe.freeze = { token: st.token, t0: -1 };
                try { webapis.avplay.pause(); } catch (e) { return "暂停不了 AVPlay：" + e.message; }
                return WAIT;
            }
            if (st.token === probe.freeze.token) { return WAIT; }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            if (Player.mode() !== "avplay" || visible("player-loading")) { return WAIT; }
            var t = -1;
            try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
            if (t < 0) { return WAIT; }
            if (probe.freeze.t0 < 0) { probe.freeze.t0 = t; return WAIT; }
            return t - probe.freeze.t0 >= 1500 ? null : WAIT;
        }, 40000, "40 秒没重连起来（看 live: 那几行）"],
        /* 10-24: rooms that offer only 原画 have TS and FLV and no fMP4, and
         * their TS playlist never answered from here; AVPlay is given the FLV
         * first. No TS playlist counts as answering here, so a room is either
         * on its HTTP-FLV or on fMP4. Some rooms' FLV hosts answer 403 from
         * here (d1--ov-gotcha05: the two biggest rooms, 10-24; their TS
         * answers), which says nothing about AVPlay: on to the next room, and
         * back again afterwards. */
        ["直播：AVPlay 先放 HTTP-FLV，出画面、时间在走", 300, function () {
            var st = window.__stLiveRoom() || {}, f = probe.flv;
            function back(r) {
                for (var i = 0; i < f.hops; i++) { key(KEY.UP); }
                return r;
            }
            if (!f) {
                probe.flv = { t0: -1, hops: 0, room: "" };
                window.__stLiveNative(true, "tsdead");
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            if (st.flvDead) { return back("AVPlay 起不来 HTTP-FLV（看 live: 那几行）"); }
            if (st.flvGaveUp && st.room !== f.room) {
                if (f.hops >= 6) { return back("7 个直播间的 HTTP-FLV 都没答（看 live: 那几行）"); }
                f.room = st.room;
                f.hops++;
                f.t0 = -1;
                key(KEY.DOWN);
                return WAIT;
            }
            if (Player.mode() !== "avplay" || visible("player-loading") || st.fmt !== "HTTP-FLV") { return WAIT; }
            var t = -1;
            try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
            if (t < 0) { return WAIT; }
            if (f.t0 < 0) { f.t0 = t; return WAIT; }
            return t - f.t0 >= 1500 ? back(null) : WAIT;
        }, 90000, "90 秒没在 AVPlay 上用 HTTP-FLV 走起来（看 live: 那几行）"],
        /* The room chooses: FLV, TS or fMP4, whichever answers first in that
         * order. 10-22, before FLV, a TS that stalled (10 s) and stepped down,
         * two more playlist looks and fMP4 took about 35 s here. */
        ["直播：再走 AVPlay，直播间自己挑 FLV / TS / fMP4，出画面、时间在走", 300, function () {
            return liveNativeStep("auto");
        }, 60000, "60 秒没在 AVPlay 上走起来"],
        /* The Tizen 3.0 set's third room (10-22): its 原画 TS was
         * NOT_SUPPORTED_FORMAT. Made to order here — the next TS start reports
         * it — and the room should step down a tier, still on TS. */
        ["直播：TS 这一档放不了 → 降一档还是 TS，出画面", 300, function () {
            var ts = probe.tsStep;
            /* Back to the room the run was in, for the 返回 step below. */
            function done(r) {
                window.__stLiveNative(false);
                for (var i = 0; i < ts.hops; i++) { key(KEY.UP); }
                return r;
            }
            if (!ts) {
                ts = probe.tsStep = { t0: -1, hops: 0 };
                window.__stLiveNative(true, "", true);
                return WAIT;
            }
            var st = window.__stLiveRoom() || {};
            if (!st.fmt) { return WAIT; }
            /* TS is weather: a room whose TS does not answer cannot show this. */
            if (st.fmt === "HLS-fMP4" && !st.below) {
                if (ts.hops >= 3) { post("连着 4 个直播间的 TS 清单都不通，降档这条路走不到，跳过"); return done(null); }
                ts.hops++;
                post("直播间 " + st.room + " 的 TS 清单不通，换下一个");
                key(KEY.DOWN);
                return WAIT;
            }
            if (visible("shell")) { return "退回了网格（看 live: 那几行）"; }
            if (!st.below || Player.mode() !== "avplay" || visible("player-loading")) { return WAIT; }
            if (!(st.used < st.below)) { return done("降档之后是 " + st.fmt + " qn" + st.used + "，应该低于 qn" + st.below); }
            /* The lower tier's TS not answering is weather; fMP4 is then what was designed. */
            if (st.fmt !== "HLS-TS" && !ts.noted) { ts.noted = true; post("降到 qn" + st.used + " 了，那一档的 TS 清单不通，用的 " + st.fmt); }
            var t = -1;
            try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
            if (t < 0) { return WAIT; }
            if (ts.t0 < 0) { ts.t0 = t; return WAIT; }
            if (t - ts.t0 < 1500) { return WAIT; }
            post("直播间 " + st.room + " 的 TS 从 qn" + st.below + " 降到 qn" + st.used + "（" + st.fmt + "），出画面了");
            return done(null);
        }, 75000, "75 秒没降档出画面（看 live: 那几行）"],
        /* The other half of issue #7, 10-24: a session already on AVPlay (its
         * first room decoded at no tier) and this room's AVPlay with nothing to
         * play — on that Tizen 4.0 set, every room. MSE gets one try, and a
         * picture there brings the rooms after it back to MSE. */
        ["直播：整次运行在 AVPlay 上、AVPlay 放不了这个直播间 → 试 MSE，出画面后回到 MSE", 300, function () {
            if (!probe.mseTry) {
                probe.mseTry = true;
                window.__stLiveNative(true, "none");
                return WAIT;
            }
            if (visible("shell")) { window.__stLiveNative(false); return "退回了网格（看 live: 那几行）"; }
            var st = window.__stLiveRoom() || {};
            if (!st.mseTry || Player.mode() !== "live" || !livePlaying()) { return WAIT; }
            window.__stLiveNative(false);
            return st.native ? "MSE 放出来了，这次运行却还在 AVPlay 上" : null;
        }, 30000, "30 秒没在 MSE 上出画面（看 live: 那几行）"],
        /* Issue #7 (10-23, a Tizen 4.0 set): a room offering no fMP4 was closed
         * with 「没有 HLS-fMP4 的流」 whatever else it had. With FLV or TS it goes
         * to AVPlay, on any set. Neither answering here is weather: the room
         * then closes with the plain message, and is opened again (on MSE) for
         * the 返回 step below. */
        ["直播：没有 HLS-fMP4 的直播间走 AVPlay 放 FLV 或 TS", 300, function () {
            var nf = probe.noFmp4;
            if (!nf) {
                nf = probe.noFmp4 = { t0: -1, reopened: false };
                window.__stLiveNative(false);   /* in case the step above timed out with AVPlay given nothing */
                window.__stLiveNoFmp4(true);
                return WAIT;
            }
            if (nf.reopened) {
                if (visible("shell")) { return "重新打开直播间又退回了网格（看 live: 那几行）"; }
                var v = document.getElementById("html5-video");
                return (!visible("player-loading") && v && v.currentTime > 1 && !v.paused) ? null : WAIT;
            }
            if (visible("shell")) {
                var said = document.getElementById("toast").textContent;
                window.__stLiveNoFmp4(false);
                if (/fMP4|没给/.test(said)) { return "没有 fMP4 的直播间被关掉了：" + said; }
                post("这个直播间的 FLV 和 TS 都不通，关了（「" + said + "」），重新打开");
                nf.reopened = true;
                Nav.focus(document.querySelector('#feed-grid .card[data-i="1"]'));
                key(KEY.ENTER);
                return WAIT;
            }
            var st = window.__stLiveRoom() || {};
            if ((st.fmt !== "HLS-TS" && st.fmt !== "HTTP-FLV") || Player.mode() !== "avplay" || visible("player-loading")) { return WAIT; }
            var t = -1;
            try { if (webapis.avplay.getState() === "PLAYING") { t = webapis.avplay.getCurrentTime(); } } catch (e) {}
            if (t < 0) { return WAIT; }
            if (nf.t0 < 0) { nf.t0 = t; return WAIT; }
            if (t - nf.t0 < 1500) { return WAIT; }
            window.__stLiveNoFmp4(false);
            post("直播间 " + st.room + " 没有 fMP4，走 AVPlay 放 " + st.fmt + " qn" + st.used + "，时间在走");
            return null;
        }, 60000, "60 秒没在 AVPlay 上放起 FLV 或 TS（看 live: 那几行）"],
        ["直播：返回，焦点落在最后看的那个直播间", 600, function () {
            key(KEY.RETURN);
            var f = document.querySelector("#feed-grid .card.focused");
            var at = f && f.getAttribute("data-i");
            /* Back on 推荐, the way the run is expected to end. */
            Nav.focus(document.querySelector('#tabs .tab[data-screen="rcmd"]'));
            key(KEY.ENTER);
            return visible("shell") && at === "1" ? null : ("回到网格后焦点在 " + at + "，应该是 1");
        }]
    ];

    /* ---------------- 弹幕帧耗时（deploy.sh --dmperf, 2026-10-18） ----------------
     * The viewer saw the danmaku shake while it scrolled. Measured the way
     * douyin's --grid was: one run, one video, the candidate ways of drawing
     * rotated window by window (the order shifted each round), so the network
     * and the video's own busy and quiet stretches average out. Per window:
     * requestAnimationFrame intervals — a frame the compositor could not
     * produce shows as a long interval even with the main thread idle — the
     * main thread's long tasks, which tell those two apart, and the video's
     * own dropped frames. */
    /* 10-18 first run: 原样 (opacity on the box + a blurred shadow) 12 frames
     * short in 14 s at the median, opacity moved onto each comment 8, that plus
     * an unblurred shadow 2, danmaku off 0 — the third is now app.css. Second
     * run: the step per frame, whole (now) against the old 4.57 px. "old"
     * keeps the 1.2.1 drawing whole for comparison with what is tried next. */
    var DMV = [
        { id: "a", name: "现在的画法（每帧 4 像素）" },
        { id: "frac", name: "每帧 4.57 像素（1.2.1 的速度）", speed: 1920 / 7000 },
        { id: "off", name: "弹幕关" }
    ];
    var DMV_CSS =
        'html[data-dmv="old"] #danmaku { opacity: 0.85; }\n' +
        'html[data-dmv="old"] #danmaku .dm { opacity: 1; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.6); }\n';
    var DM_ROUNDS = 3, DM_SETTLE = 1500, DM_WINDOW = 14000;
    /* A string, not a literal: tools/lint.mjs reads `matrix(` as a call. */
    var MATRIX = new RegExp("matrix(3d)?\\(([^)]+)\\)");

    function minutes(text) {
        var p = String(text || "").split(":"), s = 0;
        for (var i = 0; i < p.length; i++) { s = s * 60 + (parseInt(p[i], 10) || 0); }
        return s / 60;
    }
    function quality(v) {
        try {
            var q = v.getVideoPlaybackQuality();
            return { d: q.droppedVideoFrames || 0, t: q.totalVideoFrames || 0 };
        } catch (e) { return { d: 0, t: 0 }; }
    }
    function pct(sorted, p) {
        return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    }

    /* One window: everything that happens on screen for `ms`, summarised. */
    function measureWindow(ms, done) {
        var iv = [], last = 0, stop = false, lt = { n: 0, ms: 0 }, obs = null;
        try {
            obs = new window.PerformanceObserver(function (list) {
                var es = list.getEntries();
                for (var i = 0; i < es.length; i++) { lt.n++; lt.ms += es[i].duration; }
            });
            obs.observe({ entryTypes: ["longtask"] });
        } catch (e) { obs = null; lt = null; }
        var box = document.getElementById("danmaku"), added = 0, liveSum = 0, liveN = 0;
        var mo = new window.MutationObserver(function (recs) {
            for (var i = 0; i < recs.length; i++) {
                added += recs[i].addedNodes.length;
                /* Nodes are pooled: a reused one starts a new comment. */
                for (var j = 0; j < recs[i].addedNodes.length; j++) {
                    recs[i].addedNodes[j].__stOld = false;
                    recs[i].addedNodes[j].__stX = undefined;
                }
            }
        });
        mo.observe(box, { childList: true });
        var sampler = setInterval(function () { liveSum += box.childNodes.length; liveN++; }, 500);
        var v = document.getElementById("html5-video"), q0 = quality(v);
        /* Where the moving comments are drawn on each frame, as the main
         * thread samples the same animations: on a whole pixel or between two,
         * and how far each moved since the frame before. */
        var pos = { n: 0, between: 0, wobble: 0, steps: {} };
        /* Only comments that entered during this window: the ones already
         * on screen were started under the previous window's variant. */
        for (var o = 0; o < box.childNodes.length; o++) { box.childNodes[o].__stOld = true; }
        function sample() {
            var kids = box.childNodes;
            for (var i = kids.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
                if (kids[i].__stOld) { continue; }
                seen++;
                var m = MATRIX.exec(window.getComputedStyle(kids[i]).transform || "");
                if (!m) { continue; }
                var x = parseFloat(m[2].split(",")[m[1] ? 12 : 4]);
                var was = kids[i].__stX;
                kids[i].__stX = x;
                if (was === undefined || was === x) { continue; }   /* new, or a fixed one */
                pos.n++;
                var frac = x - Math.floor(x), fwas = was - Math.floor(was), df = Math.abs(frac - fwas);
                if (Math.min(frac, 1 - frac) > 0.05) { pos.between++; }
                if (Math.min(df, 1 - df) > 0.05) { pos.wobble++; }   /* sharp one frame, soft the next */
                var step = (Math.round((was - x) * 10) / 10).toString();
                pos.steps[step] = (pos.steps[step] || 0) + 1;
            }
        }
        function frame(t) {
            if (stop) { return; }
            if (last) { iv.push(t - last); }
            last = t;
            sample();
            window.requestAnimationFrame(frame);
        }
        window.requestAnimationFrame(frame);
        setTimeout(function () {
            stop = true;
            mo.disconnect();
            clearInterval(sampler);
            if (obs) { try { obs.disconnect(); } catch (e) {} }
            var q1 = quality(v), s = iv.slice().sort(function (a, b) { return a - b; });
            var base = pct(s, 0.5) || 16.7, missed = 0, over25 = 0, over50 = 0;
            for (var i = 0; i < iv.length; i++) {
                missed += Math.max(0, Math.round(iv[i] / base) - 1);
                if (iv[i] > 25) { over25++; }
                if (iv[i] > 50) { over50++; }
            }
            done({ frames: iv.length, p50: base, p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : 0,
                   missed: missed, over25: over25, over50: over50, lt: lt, added: added,
                   live: liveN ? liveSum / liveN : 0, vDropped: q1.d - q0.d, vFrames: q1.t - q0.t, pos: pos });
        }, ms);
    }
    function windowLine(r) {
        return "帧 " + r.frames + " 中位 " + r.p50.toFixed(1) + "ms p95 " + r.p95.toFixed(1) +
            " 最长 " + Math.round(r.max) + " 少画 " + r.missed + " 帧（>25ms " + r.over25 + " 次，>50ms " + r.over50 + " 次）" +
            " 长任务 " + (r.lt ? r.lt.n + " 次 " + Math.round(r.lt.ms) + "ms" : "量不了") +
            " 同屏 " + r.live.toFixed(0) + " 条 新出 " + r.added + " 条" + posLine(r.pos);
    }
    function posLine(p) {
        if (!p || !p.n) { return ""; }
        var top = Object.keys(p.steps).sort(function (a, b) { return p.steps[b] - p.steps[a]; }).slice(0, 4);
        return " 位置在两像素之间 " + Math.round(100 * p.between / p.n) + "%、小数部分逐帧在变 " +
            Math.round(100 * p.wobble / p.n) + "%（" + p.n + " 次）每帧走 " +
            top.map(function (k) { return k + "px×" + p.steps[k]; }).join(" ");
    }
    function median(xs) {
        var s = xs.slice().sort(function (a, b) { return a - b; });
        return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
    }

    var dmp = {};
    var dmperfSteps = [
        ["首页加载出卡片", 500, function () {
            return count("#screen .card") > 0 ? null : WAIT;
        }, 20000, "20 秒了首页还没有卡片"],
        ["打开排行", 300, function () {
            var st = document.createElement("style");
            st.textContent = DMV_CSS;
            document.head.appendChild(st);
            dmp.wasLevel = Settings.get("danmaku", "normal");
            window.__stNoHistory = true;
            window.__stItems = null;
            window.__stLoadFeed("ranking");
            post("屏幕 " + window.innerWidth + "x" + window.innerHeight + " dpr=" + (window.devicePixelRatio || 1) +
                 " screen=" + screen.width + "x" + screen.height);
            return null;
        }],
        ["排行出来了", 500, function () {
            return window.__stItems && window.__stItems.length && count("#feed-grid .card") ? null : WAIT;
        }, 15000, "15 秒了排行还没出来"],
        /* The densest early stretch among the first four that run long enough
         * for the rounds: four pool requests, once per run. Desktop dry runs of
         * this (six each) got this IP a 412 from bilibili for half an hour on
         * 10-18 — and the television shares the IP. */
        ["挑弹幕最多的视频", 200, function () {
            if (!dmp.asked) {
                dmp.asked = true;
                dmp.cands = [];
                var items = window.__stItems;
                for (var i = 0; i < items.length && dmp.cands.length < 4; i++) {
                    if (items[i].cid && minutes(items[i].duration) >= 6) { dmp.cands.push({ i: i, v: items[i], n: -1 }); }
                }
                if (!dmp.cands.length) { return "排行前面没有 6 分钟以上、带 cid 的视频"; }
                dmp.cands.forEach(function (c) {
                    Danmaku.load(c.v.cid, function (list) {
                        c.n = list.filter(function (d) { return d.t < 300000; }).length;
                    }, function () { c.n = 0; });
                });
            }
            var pending = dmp.cands.filter(function (c) { return c.n < 0; }).length;
            if (pending) { return WAIT; }
            dmp.cands.sort(function (a, b) { return b.n - a.n; });
            dmp.pick = dmp.cands[0];
            post("候选 " + dmp.cands.map(function (c) { return c.v.bvid + "=" + c.n; }).join(" ") +
                 "（前 5 分钟的弹幕数）");
            return dmp.pick.n ? null : "候选的弹幕池全是空的";
        }, 15000, "弹幕池 15 秒没问完"],
        ["开始播放", 200, function () {
            if (!dmp.pick) { return "没有挑到视频"; }
            Settings.set("danmaku", "normal");
            var card = document.querySelector('#feed-grid .card[data-i="' + dmp.pick.i + '"]');
            if (!card) { return "网格里找不到第 " + dmp.pick.i + " 张卡片"; }
            Nav.focus(card);
            key(KEY.ENTER);
            post("放 " + dmp.pick.v.bvid + "「" + String(dmp.pick.v.title || "").slice(0, 24) + "」" + dmp.pick.v.duration);
            return null;
        }],
        ["出画面、弹幕到了", 1000, function () {
            if (visible("shell") || visible("player-loading")) { return WAIT; }
            return visible("danmaku") && count("#danmaku .dm") ? null : WAIT;
        }, 25000, "25 秒了还没在放、或者弹幕没出来"],
        ["轮换量帧", 3000, function () {
            if (dmp.done) { return null; }
            if (dmp.started) { return WAIT; }
            dmp.started = true;
            var v = document.getElementById("html5-video");
            post("视频 " + (v ? v.videoWidth + "x" + v.videoHeight : "?") + "，每种 " + (DM_WINDOW / 1000) +
                 " 秒、" + DM_ROUNDS + " 轮，弹幕「标准」");
            var plan = [];
            for (var r = 0; r < DM_ROUNDS; r++) {
                for (var k = 0; k < DMV.length; k++) { plan.push({ round: r + 1, dv: DMV[(k + r) % DMV.length] }); }
            }
            dmp.results = {};
            dmp.speed0 = Danmaku.test.speed();
            var n = 0;
            function nextWindow() {
                if (n >= plan.length || visible("shell")) { dmp.done = true; return; }
                var w = plan[n++];
                if (w.dv.id === "off") { window.__stDanmaku("off"); }
                else {
                    if (Settings.get("danmaku", "normal") !== "normal") { window.__stDanmaku("normal"); }
                    document.documentElement.setAttribute("data-dmv", w.dv.id);
                }
                Danmaku.test.speed(w.dv.speed || dmp.speed0);
                setTimeout(function () {
                    measureWindow(DM_WINDOW, function (res) {
                        (dmp.results[w.dv.id] = dmp.results[w.dv.id] || []).push(res);
                        post("第 " + w.round + " 轮 " + w.dv.id + "（" + w.dv.name + "）：" + windowLine(res));
                        nextWindow();
                    });
                }, DM_SETTLE);
            }
            nextWindow();
            return WAIT;
        }, 8 * 60000, "轮换 8 分钟没跑完"],
        ["汇总", 200, function () {
            DMV.forEach(function (d) {
                var rs = dmp.results[d.id] || [];
                if (!rs.length) { return; }
                function m(f) { return median(rs.map(f)); }
                post("汇总 " + d.id + "（" + d.name + "，" + rs.length + " 次的中位）：少画 " + m(function (r) { return r.missed; }) +
                     " 帧/" + (DM_WINDOW / 1000) + "秒，最长帧 " + Math.round(m(function (r) { return r.max; })) + "ms，>25ms " +
                     m(function (r) { return r.over25; }) + " 次，长任务 " + Math.round(m(function (r) { return r.lt ? r.lt.ms : 0; })) +
                     "ms，同屏 " + m(function (r) { return r.live; }).toFixed(0) + " 条，位置在两像素之间 " +
                     m(function (r) { return r.pos && r.pos.n ? Math.round(100 * r.pos.between / r.pos.n) : 0; }) + "%、逐帧在变 " +
                     m(function (r) { return r.pos && r.pos.n ? Math.round(100 * r.pos.wobble / r.pos.n) : 0; }) + "%");
            });
            return null;
        }],
        ["收尾：退出播放、弹幕设置恢复", 300, function () {
            document.documentElement.removeAttribute("data-dmv");
            if (dmp.speed0) { Danmaku.test.speed(dmp.speed0); }
            if (!visible("shell")) { key(KEY.RETURN); }
            window.__stDanmaku(dmp.wasLevel || "normal");
            setTimeout(function () { window.__stNoHistory = false; }, 2000);
            return null;
        }]
    ];

    /* ---------------- 播放中换令牌（deploy.sh --tokenswap, 2026-10-20） ----------------
     *
     * A web-token 403 mid-play used to tear the player down and rebuild on the
     * strong token — seven frozen seconds on 10-20 with thirty buffered. Now
     * the strong token is minted behind the playing buffer and later requests
     * are rewritten to it (B), its indexes come from the web answers (A), and
     * the next video within fifteen minutes starts on it (C). The CDN refuses
     * when it likes, so the refusal is made here: one media request goes out
     * with its signature spoiled, and the CDN's own 403 does the rest. */
    var sw = {};
    function swPos() { return Player.hasPosition() ? Player.position() : 0; }
    function swOpen(n) {
        var cards = document.querySelectorAll("#feed-grid .card");
        if (cards.length <= n) { return "推荐网格里不到 " + (n + 1) + " 张卡片"; }
        Nav.focus(cards[n]);
        key(KEY.ENTER);
        return null;
    }
    var swapSteps = [
        ["首页加载出卡片", 500, function () {
            return count("#feed-grid .card") > 1 ? null : WAIT;
        }, 20000, "20 秒了首页还没有卡片"],
        ["打开推荐第一个视频", 300, function () {
            window.__stNoHistory = true;
            return swOpen(0);
        }],
        ["出画面、播过 6 秒", 1000, function () {
            if (visible("shell") || visible("player-loading")) { return WAIT; }
            return swPos() > 6000 ? null : WAIT;
        }, 30000, function () { return "30 秒了还没播到 6 秒（位置 " + Math.round(swPos() / 1000) + "s）"; }],
        ["造一次 web 令牌 403", 200, function () {
            var st = window.__stStrongState();
            if (!st || st.route !== "dash") { return "这个视频走的不是 DASH，换令牌这条路用不上"; }
            if (st.strong) { return "这个视频一开始就是强令牌（教训或近来被拒），造不出 web 令牌被拒"; }
            sw.at = swPos();
            sw.cid = st.cid;
            Player.test.fake403();
            return null;
        }],
        ["换上强令牌、没有重建", 1000, function () {
            var info = Player.test.swapInfo(), st = window.__stStrongState();
            if (!info.swapped) { return WAIT; }
            if (visible("player-loading")) { return "换上了，但加载画面出来了 —— 那是重建"; }
            if (!st || !st.strong) { return "播放器换了，会话里的清单却不是强令牌"; }
            sw.swappedAt = swPos();
            return null;
        }, 15000, function () {
            var info = Player.test.swapInfo();
            return info.fakeLeft ? "改坏签名的请求一直没发出去" :
                   info.pending ? "15 秒了强令牌还没铸好" : "15 秒了没换上（看 player: 那几行，可能退回了重建）";
        }],
        ["换上之后接着放", 8000, function () {
            var moved = swPos() - sw.swappedAt;
            post("换令牌：从 " + Math.round(sw.at / 1000) + "s 起，换上时在 " + Math.round(sw.swappedAt / 1000) +
                 "s，之后 8 秒走了 " + (moved / 1000).toFixed(1) + "s");
            return moved >= 5000 ? null : "换上之后 8 秒只走了 " + (moved / 1000).toFixed(1) + " 秒";
        }],
        ["退出播放", 300, function () { key(KEY.RETURN); return null; }],
        ["回到网格", 500, function () { return visible("shell") ? null : WAIT; }, 5000, "5 秒了还没回到网格"],
        ["打开推荐第二个视频", 300, function () { return swOpen(1); }],
        ["第二个直接走强令牌（近来被拒）", 1000, function () {
            if (visible("shell") || visible("player-loading")) { return WAIT; }
            var st = window.__stStrongState();
            if (!st || !st.shown) { return WAIT; }
            return /近来被拒/.test(st.label) ? null :
                "第二个没走「近来被拒」那条路（" + (st.label || "web 令牌") + "）";
        }, 25000, "25 秒了第二个还没出画面"],
        ["收尾：退出播放，忘掉这次造出来的被拒", 300, function () {
            if (!visible("shell")) { key(KEY.RETURN); }
            window.__stForgetRefusal();
            /* And the six-hour lesson the swap wrote for the first video: the
             * refusal was made up here (review, 10-20). */
            if (sw.cid) { Player.learnStrong(sw.cid, 0); }
            setTimeout(function () { window.__stNoHistory = false; }, 2000);
            return null;
        }]
    ];

    /* ---------------- 诊断日志上传（deploy.sh --diag, 2026-10-21） ----------------
     *
     * The upload path on the television itself: through 设置 the way a viewer
     * presses it, then the automatic one an incident starts, against whatever
     * BILI_DIAG_TO named (tools/diag-local.mjs by default). The toggle is
     * turned off and on again, and left as it was found. */
    var dg = {};
    function diagStatus() { var n = document.getElementById("diag-status"); return n ? n.textContent : ""; }
    var diagSteps = [
        ["首页加载出卡片", 500, function () {
            return count("#feed-grid .card") > 1 ? null : WAIT;
        }, 20000, "20 秒了首页还没有卡片"],
        /* 10-25: an upload that failed goes again a minute after the next
         * start. To see it, run this mode once with the stand-in refusing
         * (FAIL=404 node tools/diag-local.mjs — the uploads below fail), then
         * again with it answering: here the missed one goes, before the
         * manual upload below would make it moot. */
        ["上次没传上的，这次启动后补传", 1000, function () {
            if (dg.pending === undefined) {
                dg.pending = Diag.status().pending;
                if (!dg.pending) { post("跳过：上次的都传上了，没有要补传的"); return null; }
                post("上次有没传上的，等补传（启动后一分钟，或三分钟间隔过了）");
            }
            var last = Diag.status().last;
            if (!last) { return WAIT; }
            if (!last.ok) { return "补传没传上：" + last.why; }
            post("补传：编号 " + last.id);
            return Diag.status().pending ? "补传了，还说有没传上的" : null;
        }, 240000, "4 分钟了还没补传"],
        ["进设置，诊断日志开着、有接收地址", 300, function () {
            Nav.focus(document.querySelector('#tabs .tab[data-screen="settings"]'));
            key(KEY.ENTER);
            dg.wasOn = Diag.enabled();
            if (!dg.wasOn) { Diag.setEnabled(true); }
            var st = Diag.status();
            if (!st.configured) { return "这个构建没有接收地址（deploy.sh --diag 应该写进了 DIAG_TO）"; }
            post("诊断日志：编号 " + st.device + "，缓冲里 " + st.lines + " 行");
            return null;
        }],
        ["按「上传诊断日志」", 300, function () {
            Nav.focus(document.getElementById("btn-diag-upload"));
            key(KEY.ENTER);
            return null;
        }],
        ["状态行写上传了", 500, function () {
            var last = Diag.status().last;
            if (!/已上传/.test(diagStatus())) { return /没传上/.test(diagStatus()) ? "没传上：" + (last && last.why) : WAIT; }
            if (!last || !last.ok || !last.id) { return "状态行说已上传，Diag.status() 里没有编号"; }
            dg.manualId = last.id;
            post("手动上传：编号 " + last.id);
            return null;
        }, 25000, function () { return "25 秒了状态行还是「" + diagStatus() + "」"; }],
        ["开关关掉：不记录，再打开", 300, function () {
            var btn = document.getElementById("btn-diag");
            Nav.focus(btn);
            key(KEY.ENTER);
            if (Diag.enabled() || btn.textContent !== "诊断日志：关") { return "按了没关上"; }
            if (diagStatus().indexOf("已关闭") !== 0) { return "关了之后状态行是「" + diagStatus() + "」"; }
            if (Diag.status().lines !== 0) { return "关了之后缓冲里还有 " + Diag.status().lines + " 行"; }
            key(KEY.ENTER);
            return Diag.enabled() ? null : "再按没打开";
        }],
        ["出一次事：8 秒后自动上传", 300, function () {
            dg.before = (Diag.status().last || {}).id;
            /* Run twice within three minutes, the second run's incident is
             * held back by the first's automatic upload: that is the gap
             * working, not this failing. */
            var sent = null;
            try { sent = JSON.parse(localStorage.getItem("bili.diag.sent")); } catch (e) {}
            dg.held = !!(sent && sent.at && new Date().getTime() - sent.at < Diag._test.AUTO_GAP);
            if (dg.held) { post("跳过：三分钟内刚自动传过一份，这次出事会被拦下（连着跑 --diag 会这样）"); return null; }
            Diag.incident("自测：造的一次出事");
            return null;
        }],
        ["自动上传有了新编号", 1000, function () {
            if (dg.held) { return null; }
            var last = Diag.status().last || {};
            if (last.id && last.id !== dg.before && !last.manual) { post("自动上传：编号 " + last.id); return null; }
            if (last.ok === false && !last.manual) { return "没传上：" + last.why; }
            return WAIT;
        }, 30000, "30 秒了自动上传还没有结果"],
        ["收尾：开关放回原样，退出设置", 300, function () {
            if (Diag.enabled() !== dg.wasOn) { Diag.setEnabled(dg.wasOn); }
            key(KEY.RETURN);
            return null;
        }]
    ];

    function run() {
        var i = 0, failures = 0;
        if (SELFTEST === "dmperf") { steps = dmperfSteps; }
        if (SELFTEST === "tokenswap") { steps = swapSteps; }
        if (SELFTEST === "diag") { steps = diagSteps; }
        post("开始");
        function next() {
            if (i >= steps.length) {
                post(failures ? ("结束，" + failures + " 步失败") : "结束，全部通过");
                return;
            }
            var step = steps[i++], firstAt = 0;
            function attempt() {
                var why;
                try { why = step[2](); }
                catch (e) { why = "抛出异常 " + e.message; }
                if (why === WAIT) {
                    var now = new Date().getTime();
                    if (!firstAt) { firstAt = now; }
                    if (now - firstAt < (step[3] || 0)) { setTimeout(attempt, 500); return; }
                    why = typeof step[4] === "function" ? step[4]()
                        : step[4] || "等了 " + Math.round((step[3] || 0) / 1000) + " 秒还没有";
                }
                if (why) { failures++; post("✗ " + step[0] + " — " + why); }
                else { post("✓ " + step[0]); }
                next();
            }
            setTimeout(attempt, step[1]);
        }
        next();
    }

    return { run: run };
})();
