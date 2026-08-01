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
    /* Quotes matter: several call sites interpolate into attributes, and search
     * suggestions are text bilibili supplies, not ours. */
    function esc(s) {
        return String(s || "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function status(text) { statusEl.textContent = text || ""; }

    var toastTimer = null;
    function toast(text) {
        toastEl.textContent = text;
        toastEl.className = "";
        if (toastTimer) { clearTimeout(toastTimer); }
        toastTimer = setTimeout(function () { toastEl.className = "hidden"; }, 4000);
    }

    /* Errors used to be terminal: the only escape from "加载失败" was to switch
     * tab and come back. */
    function showError(message, retry) {
        screenEl.innerHTML = '<div class="empty">' + esc(message) +
            '<div class="actions" style="justify-content:center;margin-top:32px">' +
            '<div class="btn focusable" id="btn-retry">重试</div></div></div>';
        var b = el("btn-retry");
        if (b) { b.onselect = retry; }
        Nav.reset("#btn-retry");
    }

    function markTab() {
        var tabs = document.querySelectorAll("#tabs .tab");
        var focused = Nav.current();
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute("data-screen") === state.screen;
            /* Rebuilding className used to strip "focused" from the tab the user
             * was standing on, so the ring vanished for as long as the feed took
             * to load. */
            tabs[i].className = "tab focusable" + (on ? " active" : "") +
                                (tabs[i] === focused ? " focused" : "");
        }
    }

    /* ---------------- grid of videos ---------------- */

    function cardHtml(v, i) {
        var seen = Resume.fraction(v.bvid);
        return '<div class="card focusable" data-i="' + i + '">' +
               '<div class="thumb"><img src="' + esc(v.pic) + '" alt="">' +
               '<span class="dur">' + esc(v.duration) + '</span>' +
               (seen ? '<span class="seen" style="width:' + Math.round(seen * 100) + '%"></span>' : "") +
               '</div>' +
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

    /* Feeds are cached so that coming back from a video lands where the user
     * left off instead of refetching and dumping focus on the first card. */
    var feedCache = {};

    var feedRequest = 0;
    var loadingMore = false;

    /* Bumped whenever the user changes what they are looking at. Any callback
     * that would paint the screen checks it first: a slow response arriving
     * after the viewer has moved on used to redraw the old screen over the new
     * one, and — worse — hand focus to an element no longer in the document,
     * which leaves the remote apparently dead. */
    var viewToken = 0;
    function newView() { return ++viewToken; }
    function stillViewing(token) { return token === viewToken; }

    /* ranking answers with its full 100 in one go and has no second page. */
    function fetchPage(kind, page, onOk, onFail) {
        if (kind === "ranking") { return page === 1 ? API.ranking(onOk, onFail) : onOk([]); }
        if (kind === "rcmd") { return API.recommended(page, onOk, onFail); }
        if (kind === "dynamic") { return API.dynamic(page, onOk, onFail); }
        return API.popular(page, onOk, onFail);
    }

    /* Feeds used to stop dead after one screenful. Rather than a "load more"
     * button, which costs a press and a focus jump, the next page is fetched as
     * the focus nears the end of what is already rendered. */
    function maybeLoadMore(focused) {
        if (loadingMore) { return; }
        var cache = feedCache[state.screen];
        if (!cache || cache.exhausted) { return; }
        if (!focused || !focused.getAttribute || focused.getAttribute("data-i") === null) { return; }
        if (!/(^|\s)card(\s|$)/.test(focused.className)) { return; }

        var idx = Number(focused.getAttribute("data-i"));
        if (idx < cache.items.length - 8) { return; }

        loadingMore = true;
        var kind = state.screen, next = (cache.page || 1) + 1;
        fetchPage(kind, next, function (more) {
            loadingMore = false;
            var c = feedCache[kind];
            if (!c || state.screen !== kind) { return; }

            /* rcmd can repeat items across batches; dropping duplicates keeps
             * the grid from filling with the same handful of videos. */
            var seen = {};
            for (var i = 0; i < c.items.length; i++) { seen[c.items[i].bvid] = 1; }
            var fresh = [];
            for (var j = 0; j < more.length; j++) {
                if (more[j].bvid && !seen[more[j].bvid]) { fresh.push(more[j]); seen[more[j].bvid] = 1; }
            }

            c.page = next;
            if (!fresh.length) { c.exhausted = true; return; }
            c.items = c.items.concat(fresh);
            appendCards(fresh, c.items.length - fresh.length);
        }, function () {
            loadingMore = false;
            var c = feedCache[kind];
            if (c) { c.exhausted = true; }
        });
    }

    function appendCards(items, offset) {
        var grid = screenEl.querySelector(".grid");
        if (!grid) { return; }
        var html = "";
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], offset + i); }
        var holder = document.createElement("div");
        holder.innerHTML = html;
        while (holder.firstChild) {
            var node = holder.firstChild;
            holder.removeChild(node);
            grid.appendChild(node);
            (function (card, v) { card.onselect = function () { openDetail(v); }; })(
                node, items[Number(node.getAttribute("data-i")) - offset]);
        }
    }

    function loadFeed(kind, restore) {
        state.screen = kind;
        markTab();
        var req = ++feedRequest;
        newView();

        var cached = feedCache[kind];
        if (restore && cached) {
            renderGrid(cached.items);
            var cards = screenEl.querySelectorAll(".card");
            var target = cards[Math.min(cached.index || 0, cards.length - 1)];
            Nav.focus(target || cards[0]);
            screenEl.scrollTop = cached.scrollTop || 0;
            return;
        }

        screenEl.innerHTML = '<div class="empty">加载中…</div>';
        if (kind === "dynamic" && !Auth.isLoggedIn()) {
            screenEl.innerHTML = '<div class="empty">动态需要登录，先去「我的」扫码</div>';
            Nav.reset(".tab");
            return;
        }
        fetchPage(kind, 1, function (items) {
            /* Tab presses outrun the network: without this the slower of two
             * requests wins and paints its content under the other's heading. */
            if (req !== feedRequest) { return; }
            feedCache[kind] = { items: items, index: 0, scrollTop: 0, page: 1, exhausted: !items.length };
            renderGrid(items);
            Nav.reset(".card");
        }, function (why) {
            if (req !== feedRequest) { return; }
            showError("加载失败：" + why, function () { loadFeed(kind); });
        });
    }

    function rememberPosition() {
        var c = feedCache[state.screen];
        if (!c) { return; }
        var cur = Nav.current();
        if (cur && cur.getAttribute && cur.getAttribute("data-i") !== null) {
            c.index = Number(cur.getAttribute("data-i"));
        }
        c.scrollTop = screenEl.scrollTop;
    }

    /* ---------------- search ---------------- */

    var KEYS = [
        "ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ0123", "456789"
    ];

    function renderSearch() {
        state.screen = "search";
        markTab();
        newView();
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
                '<div class="key wide focusable" data-act="ime">中文输入</div>' +
                '<div class="key wide focusable" data-act="space">空格</div>' +
                '<div class="key wide focusable" data-act="del">删除</div>' +
                '<div class="key wide go focusable" data-act="go">搜索</div>' +
                '</div></div><div id="suggests" class="suggests"></div>' +
                '<div id="results"></div></div>';
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
                    else if (act === "ime") { openIme(); return; }
                    el("qbox").textContent = state.query || "输入关键词";
                    loadSuggestions();
                };
            })(keys[i]);
        }
        Nav.reset(".key");
    }

    /* The on-screen letter grid cannot type Chinese. Focusing a real input
     * hands over to the television's own IME, which can — and which also gives
     * the user their usual keyboard rather than one invented here. */
    function openIme() {
        var input = el("ime");
        input.value = state.query;
        input.onchange = input.onblur = function () {
            state.query = input.value || "";
            var box = el("qbox");
            if (box) { box.textContent = state.query || "输入关键词"; }
            loadSuggestions();
        };
        input.onkeydown = function (e) {
            if (e.keyCode === 13) {          /* enter closes the IME and searches */
                state.query = input.value || "";
                input.blur();
                var box = el("qbox");
                if (box) { box.textContent = state.query || "输入关键词"; }
                runSearch();
            } else if (e.keyCode === 10009) { /* return key backs out of the IME */
                input.blur();
                Nav.reset(".key");
            }
            e.stopPropagation();
        };
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }

    var suggestTimer = null;

    /* Suggestions are worth a lot on a remote, where every character is several
     * button presses — one press on a suggestion beats ten on the grid. */
    function loadSuggestions() {
        if (suggestTimer) { clearTimeout(suggestTimer); }
        var term = state.query.trim();
        var box = el("suggests");
        if (!box) { return; }
        if (term.length < 1) { box.innerHTML = ""; return; }

        suggestTimer = setTimeout(function () {
            API.suggest(term, function (list) {
                var b = el("suggests");
                if (!b || state.query.trim() !== term) { return; }
                var html = "";
                for (var i = 0; i < list.length && i < 8; i++) {
                    html += '<div class="suggest focusable" data-s="' + esc(list[i]) + '">' +
                            esc(list[i]) + "</div>";
                }
                b.innerHTML = html;
                var nodes = b.querySelectorAll(".suggest");
                for (var j = 0; j < nodes.length; j++) {
                    (function (node) {
                        node.onselect = function () {
                            state.query = node.getAttribute("data-s");
                            el("qbox").textContent = state.query;
                            runSearch();
                        };
                    })(nodes[j]);
                }
            }, function () { /* suggestions are a nicety; stay quiet on failure */ });
        }, 300);
    }

    function runSearch() {
        if (!state.query.trim()) { toast("先输入关键词"); return; }
        var token = viewToken;
        var results = el("results");
        results.innerHTML = '<div class="empty">搜索中…</div>';
        API.search(state.query.trim(), function (items) {
            if (!stillViewing(token)) { return; }
            results = el("results");
            if (!results) { return; }
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
            if (!stillViewing(token)) { return; }
            results = el("results");
            if (results) { results.innerHTML = '<div class="empty">搜索失败：' + esc(why) + '</div>'; }
        });
    }

    /* ---------------- mine / login ---------------- */

    function renderMine() {
        state.screen = "mine";
        markTab();
        newView();
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
        rememberPosition();
        state.stack.push(state.screen);
        state.screen = "detail";
        var token = newView();
        screenEl.innerHTML = '<div class="empty">加载中…</div>';
        API.view(v.bvid, function (d) {
            if (!stillViewing(token)) { return; }
            openDetailFrom(d);
        }, function (why) {
            if (!stillViewing(token)) { return; }
            showError("加载失败：" + why, function () { openDetail(v); });
        });
    }

    /* Split out so leaving the player can rebuild the page it came from without
     * another round trip. */
    function openDetailFrom(d) {
        state.screen = "detail";
        markTab();
        var token = newView();
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
            if (!stillViewing(token)) { return; }
            d.related = items;
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
    }

    /* ---------------- playback ---------------- */

    function fmt(ms) {
        var s = Math.floor((ms || 0) / 1000);
        var m = Math.floor(s / 60);
        s = s % 60;
        if (m < 60) { return m + ":" + ("0" + s).slice(-2); }
        return Math.floor(m / 60) + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + s).slice(-2);
    }

    var chromeTimer = null;
    var pendingNext = null;     /* {detail, cid, title} awaiting the countdown */
    var nextTimer = null;
    var playedInChain = {};     /* stops a chain of autoplays circling back */

    /* What follows the video that just finished. A multi-part upload continues
     * with its own next part — jumping to an unrelated recommendation halfway
     * through a tutorial series is not what anyone means by "next". Otherwise
     * take the first related video not already seen in this chain. */
    function nextUp(cb) {
        if (!playing) { cb(null); return; }
        var d = playing.detail, cid = playing.cid;

        if (d.pages && d.pages.length > 1) {
            for (var i = 0; i < d.pages.length - 1; i++) {
                if (d.pages[i].cid === cid) {
                    cb({ detail: d, cid: d.pages[i + 1].cid,
                         title: "P" + (i + 2) + "  " + d.pages[i + 1].part });
                    return;
                }
            }
        }

        function fromList(list) {
            for (var i = 0; i < (list || []).length; i++) {
                if (playedInChain[list[i].bvid]) { continue; }
                var pick = list[i];
                API.view(pick.bvid, function (nd) {
                    cb({ detail: nd, cid: nd.cid, title: nd.title });
                }, function () { cb(null); });
                return;
            }
            cb(null);
        }

        if (d.related) { fromList(d.related); }
        else { API.related(d.bvid, function (list) { d.related = list; fromList(list); },
                           function () { cb(null); }); }
    }

    var nextToken = 0;

    function cancelNext() {
        nextToken++;   /* an in-flight nextUp lookup must not surface later */
        if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
        pendingNext = null;
        el("nextup").className = "hidden";
    }

    function beginAutoNext() {
        var was = playing;
        Player.stop();
        playing = null;
        if (!was) { showPlayerUi(false); return; }
        playedInChain[was.detail.bvid] = 1;
        playing = was;   /* nextUp reads it, and the keys still belong to the player */

        var token = ++nextToken;
        nextUp(function (next) {
            /* Two round trips happen before the countdown appears; pressing 返回
             * in that window used to leave the lookup running, so a video would
             * start by itself on top of whatever the viewer had navigated to. */
            if (token !== nextToken) { return; }
            var finished = playing;
            playing = null;
            if (!next) {
                /* Nothing to continue with: fall back to the page it came from. */
                showPlayerUi(false);
                if (finished && finished.detail) { openDetailFrom(finished.detail); }
                return;
            }
            /* Remember what just finished: cancelling the countdown should land
             * on the video the viewer was watching, not the one queued up. */
            next.from = finished && finished.detail;
            pendingNext = next;
            el("playerui").className = "hidden";
            el("nextup").className = "";
            el("nextup-title").textContent = next.title;

            var left = 5;
            el("nextup-count").textContent = left;
            nextTimer = setInterval(function () {
                left--;
                el("nextup-count").textContent = left;
                if (left <= 0) { playNext(); }
            }, 1000);
        });
    }

    function playNext() {
        var next = pendingNext;
        cancelNext();
        if (!next) { return; }
        playedInChain[next.detail.bvid] = 1;
        play(next.detail, next.cid);
    }

    /* The overlay is for orientation, not decoration: show it on any input and
     * take it away again so the picture is unobstructed while watching. */
    function showChrome() {
        if (!playing) { return; }
        el("playerui").className = "";
        if (chromeTimer) { clearTimeout(chromeTimer); }
        chromeTimer = setTimeout(function () {
            if (playing && !Player.isPaused()) { el("playerui").className = "hidden"; }
        }, 4000);
    }

    function showPlayerUi(on) {
        el("shell").className = on ? "hidden" : "";
        el("playerui").className = on ? "" : "hidden";
        if (!on) { el("nextup").className = "hidden"; }
        if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
        if (on) { showChrome(); }
    }

    function play(detail, cid) {
        playing = { detail: detail, cid: cid };
        var startMs = Resume.positionMs(detail.bvid, cid);
        if (startMs) { toast("从 " + fmt(startMs) + " 继续播放"); }
        el("player-title").textContent = detail.title;
        el("player-pos").textContent = "0:00";
        el("player-dur").textContent = detail.duration;
        el("player-fill").style.width = "0%";
        showPlayerUi(true);
        status("");

        /* Progressive is the better route when it exists; DASH is the fallback
         * for videos bilibili no longer offers as a single file. */
        /* Progressive first, always. The stream url is pre-signed, so AVPlay
         * needs no session to fetch it — only the playurl call does, and that
         * goes over XHR with the cookie jar. Routing signed-in playback through
         * MSE instead was a mistake: it bought nothing and gave up native
         * buffering, seeking and hardware decode. */
        playing.canDowngrade = true;
        var session = playing;
        API.playurlProgressive(detail.bvid, cid, PREFERRED_QN, function (r) {
            /* Backing out while the url resolves used to start playback with no
             * way to stop it — audio under the browse UI, deaf to the remote. */
            if (playing !== session) { return; }
            playing.quality = r.quality;
            playing.accept = r.accept || [];
            Player.playProgressive(r.url, startMs);
        }, function (why) {
            if (playing !== session) { return; }
            /* No single-file stream for this video: DASH through MSE is the
             * only remaining route. */
            report("player", "no durl (" + why + "), falling back to dash");
            API.playurlDash(detail.bvid, cid, PREFERRED_QN, function (dash) {
                if (playing !== session) { return; }
                Player.playDash(dash, startMs);
            }, function (w2) {
                if (playing !== session) { return; }
                toast("播放失败：" + w2);
                stopPlayback();
            });
        });
    }

    /* Every CDN mirror refused, or DASH would not start. Rather than dead-end
     * on an error, drop to the progressive stream, which is served from the
     * plain hosts and has always worked here. */
    function downgrade(why) {
        if (!playing || playing.downgraded) { stopPlayback(); return; }
        playing.downgraded = true;
        playing.failed = false;
        toast(why + "，改用标清");
        var d = playing.detail, cid = playing.cid, session = playing;
        API.playurlProgressive(d.bvid, cid, 64, function (r) {
            if (playing !== session) { return; }
            Player.playProgressive(r.url, Resume.positionMs(d.bvid, cid));
        }, function (w2) {
            if (playing !== session) { return; }
            toast("播放失败：" + w2);
            stopPlayback();
        });
    }

    function stopPlayback() {
        var was = playing;
        Resume.flush();
        cancelNext();
        playedInChain = {};
        Player.stop();
        playing = null;
        showPlayerUi(false);
        /* Back out to the page the video was started from. Dropping to a feed
         * and re-focusing its first card is disorienting after a 50 minute
         * video. */
        if (was && was.detail) { openDetailFrom(was.detail); }
        else { loadFeed(state.screen === "detail" ? "rcmd" : state.screen, true); }
    }

    Player.on(function (kind, data) {
        if (kind === "time") {
            if (playing) {
                Resume.record(playing.detail.bvid, playing.cid, data.position, data.duration);
            }
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
            if (playing) { Resume.forget(playing.detail.bvid, playing.cid); }
            beginAutoNext();
        } else if (kind === "seek-refused") {
            toast("该片段尚未缓冲，无法跳转");
        } else if (kind === "log") {
            report("player", data);
        } else if (kind === "error") {
            /* One failure can cascade into a burst as queued work unwinds; only
             * the first is worth reporting or acting on. */
            if (!playing || playing.failed) { return; }
            playing.failed = true;
            report("player", data);
            if (playing.canDowngrade && !playing.downgraded) { downgrade(String(data)); return; }
            toast("播放错误：" + data);
            stopPlayback();
        }
    });

    /* ---------------- keys ---------------- */

    Nav.onKey(function (k) {
        if (pendingNext) {
            if (k === Nav.KEY.ENTER || k === Nav.KEY.PLAY_PAUSE) { playNext(); return true; }
            if (k === Nav.KEY.RETURN) {
                var back = pendingNext.from || pendingNext.detail;
                cancelNext();
                showPlayerUi(false);
                playedInChain = {};
                openDetailFrom(back);
                return true;
            }
            if (k === Nav.KEY.EXIT) { return false; }
            return true;
        }
        if (!playing) { return false; }
        showChrome();
        /* While playing, the remote drives the player rather than the focus. */
        switch (k) {
            case Nav.KEY.ENTER:
            case Nav.KEY.PLAY_PAUSE:
                if (Player.isPaused()) { Player.resume(); showChrome(); }
                else { Player.pause(); el("playerui").className = ""; if (chromeTimer) { clearTimeout(chromeTimer); } }
                return true;
            case Nav.KEY.LEFT:
            case Nav.KEY.REW:
                Player.seekBy(-10000); return true;
            case Nav.KEY.RIGHT:
            case Nav.KEY.FF:
                Player.seekBy(10000); return true;
            case Nav.KEY.RETURN:
                stopPlayback(); return true;
            case Nav.KEY.EXIT:
                return false;   /* let Nav close the app */
            default:
                return true;
        }
    });

    Nav.onBack(function () {
        if (playing) { stopPlayback(); return; }
        if (state.screen === "detail") {
            var back = state.stack.pop();
            if (back === "search") { renderSearch(); }
            else if (back === "mine") { renderMine(); }
            else if (back === "detail") {
                /* Reached from a related video. Unwind to the nearest real
                 * screen rather than asking loadFeed for a "detail" feed, which
                 * silently fell through to 热门 under the wrong heading. */
                while (state.stack.length && state.stack[state.stack.length - 1] === "detail") {
                    state.stack.pop();
                }
                var under = state.stack.pop() || "rcmd";
                if (under === "search") { renderSearch(); }
                else if (under === "mine") { renderMine(); }
                else { loadFeed(under, true); }
            } else { loadFeed(back || "rcmd", true); }
            return;
        }
        Auth.cancelQrLogin();
        if (state.screen !== "rcmd") { loadFeed("rcmd"); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    });

    /* ---------------- boot ---------------- */

    window.onload = function () {
        screenEl = el("screen");
        statusEl = el("status");
        toastEl = el("toast");

        Nav.registerKeys();
        Nav.onFocus(maybeLoadMore);

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

        loadFeed("rcmd");
    };
})();
