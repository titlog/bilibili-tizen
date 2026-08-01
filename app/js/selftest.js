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

    var steps = [
        ["首页加载出卡片", 3500, function () {
            return count("#screen .card") > 0 ? null : "网格里没有任何卡片";
        }],
        ["焦点落在第一张卡片", 300, function () {
            var f = document.querySelector("#screen .card.focused");
            return f ? null : "没有卡片处于选中状态";
        }],
        ["探测流地址", 200, function () { probeStream(); return null; }],
        ["等待探测结果", 4000, function () { return null; }],
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
        ["拖动生效并落点", 2500, function () {
            var t = document.getElementById("player-pos").textContent;
            return (t && t !== "0:00") ? null : "拖动之后进度仍是 0:00";
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
