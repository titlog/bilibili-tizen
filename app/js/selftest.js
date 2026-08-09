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

    function key(code) {
        var e = document.createEvent("Event");
        e.initEvent("keydown", true, true);
        e.keyCode = code;
        /* preventDefault is called by the handler; a synthetic Event tolerates it. */
        document.dispatchEvent(e);
    }

    var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, RETURN: 10009 };

    function visible(id) {
        var n = document.getElementById(id);
        return !!(n && n.offsetParent !== null);
    }

    function count(sel) { return document.querySelectorAll(sel).length; }

    /* A set with nobody signed in opens the login page instead of the switcher,
     * and the removal walk has nothing to walk. Skipping is right; failing would
     * make the run red on a television that is behaving perfectly. */
    function onAccounts() { return count("#screen .acc") > 0; }

    /* Filled by the identity check, read by the step that waits for it. Empty
     * string means it answered and agreed; null means it never answered. */
    var identityVerdict = "凭证检查没有回应";

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

        API.playurlProgressive(v.bvid, v.cid, PREFERRED_QN, function (r) {
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
        var want = [["美食", 1020], ["舞蹈", 1004], ["人工智能", 1011], ["科技数码", 1012]];
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
        var bad = [], names = ["美食", "舞蹈", "人工智能", "科技数码"], line = [];
        for (var i = 0; i < names.length; i++) {
            var v = zoneProbe[names[i]];
            line.push(names[i] + "=" + (v === undefined ? "没回来" : v));
            if (typeof v !== "number" || v === 0) { bad.push(names[i]); }
        }
        post("分区 " + line.join(" "));
        return bad.length ? ("这些分区取不到内容：" + bad.join("、")) : null;
    }

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
        ["探测流地址", 200, function () { probeStream(); probeZones(); return null; }],
        ["等待探测结果", 4000, function () { return null; }],
        ["四个分区都有内容", 100, zoneVerdict],
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
        ["下键拉出面板", 1200, function () {
            key(KEY.DOWN);
            return null;
        }],
        ["面板可见且有内容", 900, function () {
            if (!visible("options")) { return "面板没有出现"; }
            if (!document.getElementById("panel-title").textContent) { return "面板标题为空"; }
            return null;
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
        ["跨区之后确实播得下去", 7000, function () {
            if (!window.__stFar) { return null; }
            var t = secs(document.getElementById("player-pos").textContent);
            /* If the jump was refused or nothing buffered there, the readout
             * sits exactly where the scrub left it and never advances. */
            return t > window.__stSeekTo
                ? null
                : "跳到 " + window.__stSeekTo + "s 后进度不前进（现在 " + t + "s）——那里没有缓冲到";
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
        ["返回键退出播放", 500, function () { key(KEY.RETURN); return null; }],
        ["回到首页网格", 2500, function () {
            if (!visible("shell")) { return "没有回到浏览界面"; }
            if (!count("#screen .card")) { return "回来后网格是空的"; }
            var f = document.querySelector("#screen .card.focused");
            return f ? null : "回来后没有任何卡片被选中";
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
        }]
    ];

    function run() {
        var i = 0, failures = 0;
        post("开始");
        function next() {
            if (i >= steps.length) {
                post(failures ? ("结束，" + failures + " 步失败") : "结束，全部通过");
                return;
            }
            var step = steps[i++];
            setTimeout(function () {
                var why;
                try { why = step[2](); }
                catch (e) { why = "抛出异常 " + e.message; }
                if (why) { failures++; post("✗ " + step[0] + " — " + why); }
                else { post("✓ " + step[0]); }
                next();
            }, step[1]);
        }
        next();
    }

    return { run: run };
})();
