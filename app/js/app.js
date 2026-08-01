/* Screens and routing.
 *
 * Everything is rendered by replacing #screen's innerHTML and then handing focus
 * back to Nav. There is no framework and no build step: Tizen 7's WebKit is old
 * and the whole app ships as plain ES5.
 */
(function () {
    "use strict";

    var screenEl, statusEl, toastEl;
    var state = { screen: "popular", query: "", stack: [] };
    var playing = null;

    function el(id) { return document.getElementById(id); }

    /* There is no console on a retail set and dlog is closed, so anything that
     * throws is posted to tools/collect.mjs instead. Silent when unset. */
    function report(kind, detail) {
        if (!REPORT_TO) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", REPORT_TO, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.send(JSON.stringify({ event: "log", detail: { msg: kind + ": " + detail } }));
        } catch (e) {}
    }

    window.onerror = function (msg, src, line) {
        report("js error", msg + " @" + String(src).split("/").pop() + ":" + line);
        return false;
    };
    function esc(s) {
        return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function status(text) { statusEl.textContent = text || ""; }

    var toastTimer = null;
    function toast(text) {
        toastEl.textContent = text;
        toastEl.className = "";
        if (toastTimer) { clearTimeout(toastTimer); }
        toastTimer = setTimeout(function () { toastEl.className = "hidden"; }, 4000);
    }

    function markTab() {
        var tabs = document.querySelectorAll("#tabs .tab");
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute("data-screen") === state.screen;
            tabs[i].className = "tab focusable" + (on ? " active" : "");
        }
    }

    /* ---------------- grid of videos ---------------- */

    function cardHtml(v, i) {
        return '<div class="card focusable" data-i="' + i + '">' +
               '<div class="thumb"><img src="' + esc(v.pic) + '" alt="">' +
               '<span class="dur">' + esc(v.duration) + '</span></div>' +
               '<div class="card-title">' + esc(v.title) + '</div>' +
               '<div class="card-meta">' + esc(v.author) + ' &middot; ' + esc(v.play) + '次观看</div>' +
               '</div>';
    }

    function renderGrid(items, emptyText) {
        if (!items.length) {
            screenEl.innerHTML = '<div class="empty">' + esc(emptyText || "没有内容") + '</div>';
            return;
        }
        var html = '<div class="grid">';
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], i); }
        screenEl.innerHTML = html + "</div>";

        var cards = screenEl.querySelectorAll(".card");
        for (var j = 0; j < cards.length; j++) {
            (function (card, v) {
                card.onselect = function () { openDetail(v); };
            })(cards[j], items[Number(cards[j].getAttribute("data-i"))]);
        }
    }

    function loadFeed(kind) {
        state.screen = kind;
        markTab();
        screenEl.innerHTML = '<div class="empty">加载中…</div>';
        var fn = kind === "ranking" ? API.ranking : function (ok, fail) { API.popular(1, ok, fail); };
        fn(function (items) {
            renderGrid(items);
            Nav.reset(".card");
        }, function (why) {
            screenEl.innerHTML = '<div class="empty">加载失败：' + esc(why) + '</div>';
            Nav.reset(".tab");
        });
    }

    /* ---------------- search ---------------- */

    var KEYS = [
        "ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ0123", "456789"
    ];

    function renderSearch() {
        state.screen = "search";
        markTab();
        var html = '<div class="search-wrap">' +
            '<div class="search-box" id="qbox">' + esc(state.query || "输入关键词") + '</div>' +
            '<div class="keyboard">';
        for (var r = 0; r < KEYS.length; r++) {
            html += '<div class="krow">';
            for (var c = 0; c < KEYS[r].length; c++) {
                var ch = KEYS[r].charAt(c);
                html += '<div class="key focusable" data-ch="' + ch + '">' + ch + '</div>';
            }
            html += "</div>";
        }
        html += '<div class="krow">' +
                '<div class="key wide focusable" data-act="space">空格</div>' +
                '<div class="key wide focusable" data-act="del">删除</div>' +
                '<div class="key wide go focusable" data-act="go">搜索</div>' +
                '</div></div><div id="results"></div></div>';
        screenEl.innerHTML = html;

        var keys = screenEl.querySelectorAll(".key");
        for (var i = 0; i < keys.length; i++) {
            (function (k) {
                k.onselect = function () {
                    var ch = k.getAttribute("data-ch");
                    var act = k.getAttribute("data-act");
                    if (ch) { state.query += ch; }
                    else if (act === "space") { state.query += " "; }
                    else if (act === "del") { state.query = state.query.slice(0, -1); }
                    else if (act === "go") { runSearch(); return; }
                    el("qbox").textContent = state.query || "输入关键词";
                };
            })(keys[i]);
        }
        Nav.reset(".key");
    }

    function runSearch() {
        if (!state.query.trim()) { toast("先输入关键词"); return; }
        var results = el("results");
        results.innerHTML = '<div class="empty">搜索中…</div>';
        API.search(state.query.trim(), function (items) {
            if (!items.length) { results.innerHTML = '<div class="empty">没有结果</div>'; return; }
            var html = '<div class="grid">';
            for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], i); }
            results.innerHTML = html + "</div>";
            var cards = results.querySelectorAll(".card");
            for (var j = 0; j < cards.length; j++) {
                (function (card, v) { card.onselect = function () { openDetail(v); }; })(
                    cards[j], items[Number(cards[j].getAttribute("data-i"))]);
            }
            Nav.focus(cards[0]);
        }, function (why) {
            results.innerHTML = '<div class="empty">搜索失败：' + esc(why) + '</div>';
        });
    }

    /* ---------------- mine / login ---------------- */

    function renderMine() {
        state.screen = "mine";
        markTab();
        Auth.cancelQrLogin();

        if (!Auth.isLoggedIn()) {
            renderLogin();
            return;
        }
        screenEl.innerHTML = '<div class="mine"><div class="empty">检查登录状态…</div></div>';
        API.nav(function (me) {
            var html = '<div class="mine">' +
                '<div class="me">' +
                '<div class="me-name">' + esc(me.isLogin ? me.uname : "会话已失效") + '</div>' +
                '<div class="me-sub">' + (me.isLogin
                    ? "已登录，等级 " + esc(me.level) + " · 1080P 可用"
                    : "服务器不认这个会话，需要重新扫码") + '</div>' +
                '<div class="actions">' +
                '<div class="btn focusable" id="btn-logout">退出登录</div>' +
                '</div></div>';
            html += '<div class="section">观看历史</div><div id="hist"></div></div>';
            screenEl.innerHTML = html;

            el("btn-logout").onselect = function () {
                Auth.logout();
                PREFERRED_QN = 64;
                toast("已退出登录");
                renderMine();
            };
            Nav.reset("#btn-logout");

            if (me.isLogin) {
                PREFERRED_QN = 80;
                API.history(function (items) {
                    var h = el("hist");
                    if (!h) { return; }
                    if (!items.length) { h.innerHTML = '<div class="empty">没有历史记录</div>'; return; }
                    var g = '<div class="grid">';
                    for (var i = 0; i < items.length; i++) { g += cardHtml(items[i], i); }
                    h.innerHTML = g + "</div>";
                    var cards = h.querySelectorAll(".card");
                    for (var j = 0; j < cards.length; j++) {
                        (function (card, v) { card.onselect = function () { openDetail(v); }; })(
                            cards[j], items[Number(cards[j].getAttribute("data-i"))]);
                    }
                }, function (why) {
                    var h = el("hist");
                    if (h) { h.innerHTML = '<div class="empty">历史读取失败：' + esc(why) + '</div>'; }
                });
            }
        }, function (why) {
            screenEl.innerHTML = '<div class="empty">无法检查登录状态：' + esc(why) + '</div>';
            Nav.reset(".tab");
        });
    }

    function renderLogin() {
        screenEl.innerHTML = '<div class="login">' +
            '<div class="login-left">' +
            '<h2>用 bilibili App 扫码登录</h2>' +
            '<div class="login-step" id="login-step">正在获取二维码…</div>' +
            '<div class="login-note">登录后可用 1080P，并能看到自己的观看历史。<br>' +
            '二维码只在这台电视上生成，不会经过任何第三方。</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-refresh">重新获取</div></div>' +
            '</div>' +
            '<div class="login-right" id="qrbox"></div></div>';

        el("btn-refresh").onselect = function () { renderLogin(); };
        Nav.reset("#btn-refresh");

        Auth.startQrLogin(function (s) {
            var step = el("login-step"), box = el("qrbox");
            if (!step || !box) { return; }
            if (s.kind === "qr") {
                try {
                    box.innerHTML = QR.toHtml(s.url, 8);
                    step.textContent = "等待扫码…";
                } catch (e) {
                    step.textContent = "二维码生成失败：" + e.message;
                    report("qr", e.message);
                }
            } else if (s.kind === "scanned") {
                step.textContent = "已扫码，请在手机上确认";
            } else if (s.kind === "finishing") {
                step.textContent = "正在换取登录凭证…";
            } else if (s.kind === "done") {
                toast("登录成功");
                renderMine();
            } else if (s.kind === "expired") {
                step.textContent = "二维码已过期，选「重新获取」";
            } else if (s.kind === "error") {
                step.textContent = "登录失败：" + s.why;
                report("login", s.why);
            }
        });
    }

    /* ---------------- detail ---------------- */

    function openDetail(v) {
        state.stack.push(state.screen);
        state.screen = "detail";
        screenEl.innerHTML = '<div class="empty">加载中…</div>';
        API.view(v.bvid, function (d) {
            var html = '<div class="detail">' +
                '<div class="detail-head">' +
                '<img class="detail-pic" src="' + esc(d.pic) + '" alt="">' +
                '<div class="detail-info">' +
                '<h2>' + esc(d.title) + '</h2>' +
                '<div class="detail-meta">' + esc(d.author) + ' &middot; ' +
                    esc(d.duration) + ' &middot; ' + esc(d.play) + '次观看</div>' +
                '<div class="detail-desc">' + esc((d.desc || "").slice(0, 220)) + '</div>' +
                '<div class="actions">' +
                '<div class="btn focusable" id="btn-play">播放</div>' +
                '</div></div></div>';

            if (d.pages.length > 1) {
                html += '<div class="section">分P</div><div class="parts">';
                for (var i = 0; i < d.pages.length && i < 30; i++) {
                    html += '<div class="part focusable" data-cid="' + d.pages[i].cid + '">' +
                            (i + 1) + " " + esc(d.pages[i].part) + "</div>";
                }
                html += "</div>";
            }
            html += '<div class="section">相关推荐</div><div id="related"></div></div>';
            screenEl.innerHTML = html;

            el("btn-play").onselect = function () { play(d, d.cid); };
            var parts = screenEl.querySelectorAll(".part");
            for (var p = 0; p < parts.length; p++) {
                (function (node) {
                    node.onselect = function () { play(d, Number(node.getAttribute("data-cid"))); };
                })(parts[p]);
            }
            Nav.reset("#btn-play");

            API.related(d.bvid, function (items) {
                var r = el("related");
                if (!r || !items.length) { return; }
                var h = '<div class="grid">';
                for (var i = 0; i < items.length && i < 12; i++) { h += cardHtml(items[i], i); }
                r.innerHTML = h + "</div>";
                var cards = r.querySelectorAll(".card");
                for (var j = 0; j < cards.length; j++) {
                    (function (card, vv) { card.onselect = function () { openDetail(vv); }; })(
                        cards[j], items[Number(cards[j].getAttribute("data-i"))]);
                }
            }, function () {});
        }, function (why) {
            screenEl.innerHTML = '<div class="empty">加载失败：' + esc(why) + '</div>';
            Nav.reset(".tab");
        });
    }

    /* ---------------- playback ---------------- */

    function fmt(ms) {
        var s = Math.floor((ms || 0) / 1000);
        var m = Math.floor(s / 60);
        s = s % 60;
        if (m < 60) { return m + ":" + ("0" + s).slice(-2); }
        return Math.floor(m / 60) + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + s).slice(-2);
    }

    function showPlayerUi(on) {
        el("shell").className = on ? "hidden" : "";
        el("playerui").className = on ? "" : "hidden";
    }

    function play(detail, cid) {
        playing = { detail: detail, cid: cid };
        el("player-title").textContent = detail.title;
        el("player-pos").textContent = "0:00";
        el("player-dur").textContent = detail.duration;
        el("player-fill").style.width = "0%";
        showPlayerUi(true);
        status("");

        /* Progressive is the better route when it exists; DASH is the fallback
         * for videos bilibili no longer offers as a single file. */
        /* AVPlay has no access to the engine's cookie jar, so a jar-only
         * session has to play through MSE or it silently drops to 720p. */
        if (Auth.needsJar() && PREFERRED_QN > 64) {
            API.playurlDash(detail.bvid, cid, PREFERRED_QN, function (dash) {
                Player.playDash(dash, 0);
            }, function (why) {
                toast("高清流获取失败，改用标清：" + why);
                API.playurlProgressive(detail.bvid, cid, 64, function (r) {
                    Player.playProgressive(r.url, 0);
                }, function (w2) { toast("播放失败：" + w2); stopPlayback(); });
            });
            return;
        }

        API.playurlProgressive(detail.bvid, cid, PREFERRED_QN, function (r) {
            Player.playProgressive(r.url, 0);
        }, function () {
            toast("无渐进式流，改用 DASH");
            API.playurlDash(detail.bvid, cid, PREFERRED_QN, function (dash) {
                Player.playDash(dash, 0);
            }, function (why) {
                toast("播放失败：" + why);
                stopPlayback();
            });
        });
    }

    function stopPlayback() {
        Player.stop();
        playing = null;
        showPlayerUi(false);
        Nav.reset(".card");
    }

    Player.on(function (kind, data) {
        if (kind === "time") {
            el("player-pos").textContent = fmt(data.position);
            if (data.duration) {
                el("player-dur").textContent = fmt(data.duration);
                el("player-fill").style.width =
                    Math.min(100, (data.position / data.duration) * 100) + "%";
            }
        } else if (kind === "buffering") {
            el("player-hint").textContent = data ? "缓冲中…"
                : "确认键 播放/暂停 · 左右 快退/快进 · 返回键 退出";
        } else if (kind === "ended") {
            stopPlayback();
        } else if (kind === "error") {
            /* One failure can cascade into a burst as queued work unwinds; only
             * the first is worth reporting or acting on. */
            if (!playing || playing.failed) { return; }
            playing.failed = true;
            report("player", data);
            toast("播放错误：" + data);
            stopPlayback();
        }
    });

    /* ---------------- keys ---------------- */

    Nav.onKey(function (k) {
        if (!playing) { return false; }
        /* While playing, the remote drives the player rather than the focus. */
        switch (k) {
            case Nav.KEY.ENTER:
            case Nav.KEY.PLAY_PAUSE:
                if (Player.isPaused()) { Player.resume(); } else { Player.pause(); }
                return true;
            case Nav.KEY.LEFT:
            case Nav.KEY.REW:
                Player.seekBy(-10000); return true;
            case Nav.KEY.RIGHT:
            case Nav.KEY.FF:
                Player.seekBy(10000); return true;
            case Nav.KEY.RETURN:
                stopPlayback(); return true;
            default:
                return true;
        }
    });

    Nav.onBack(function () {
        if (playing) { stopPlayback(); return; }
        if (state.screen === "detail") {
            var back = state.stack.pop() || "popular";
            if (back === "search") { renderSearch(); }
            else if (back === "mine") { renderMine(); }
            else { loadFeed(back); }
            return;
        }
        if (state.screen !== "popular") { loadFeed("popular"); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    });

    /* ---------------- boot ---------------- */

    window.onload = function () {
        screenEl = el("screen");
        statusEl = el("status");
        toastEl = el("toast");

        Nav.registerKeys();

        var tabs = document.querySelectorAll("#tabs .tab");
        for (var i = 0; i < tabs.length; i++) {
            (function (tab) {
                tab.onselect = function () {
                    var s = tab.getAttribute("data-screen");
                    Auth.cancelQrLogin();
                    if (s === "search") { renderSearch(); }
                    else if (s === "mine") { renderMine(); }
                    else { loadFeed(s); }
                };
            })(tabs[i]);
        }

        loadFeed("popular");
    };
})();
