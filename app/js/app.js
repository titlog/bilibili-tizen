/* Screens and routing.
 *
 * Everything is rendered by replacing #screen's innerHTML and then handing focus
 * back to Nav. There is no framework and no build step: Tizen 7's WebKit is old
 * and the whole app ships as plain ES5.
 */
(function () {
    "use strict";

    var screenEl, statusEl, toastEl;
    var state = { screen: "rcmd", query: "", results: null };
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
                card.onselect = function () { playVideo(v); };
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
        if (loadingMore || playing || optionsOpen) { return; }
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
            (function (card, v) { card.onselect = function () { playVideo(v); }; })(
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
            window.__stItems = items;   /* selftest addresses the same video */
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
        /* Related videos in the player panel carry data-i too, so without this
         * picking one wrote its index over the feed's and returning landed on
         * an unrelated card. */
        if (optionsOpen) { return; }
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

        /* Coming back from a video used to land on an empty keyboard with the
         * results thrown away, so finding one thing meant searching twice. */
        if (state.results && state.results.length) {
            paintResults(state.results);
        }

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
                    var kbd = screenEl.querySelector(".keyboard");
                    if (kbd) { kbd.className = "keyboard"; }
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
    var imeOpen = false;

    function closeIme(commit) {
        if (!imeOpen) { return; }
        imeOpen = false;
        var input = el("ime");
        if (commit) { state.query = input.value || ""; }
        input.onkeydown = input.onchange = input.oninput = null;
        try { input.blur(); } catch (e) {}
        el("ime-wrap").className = "hidden";
        var box = el("qbox");
        if (box) { box.textContent = state.query || "输入关键词"; }
        /* Focus has to come back explicitly: while the input held it, Nav had no
         * idea where the cursor was, and leaving it that way is what made the
         * remote stop responding entirely. */
        Nav.reset(".key");
    }

    function openIme() {
        var input = el("ime");
        imeOpen = true;
        el("ime-wrap").className = "";
        input.value = state.query;

        input.oninput = function () { state.query = input.value || ""; };
        input.onkeydown = function (e) {
            var k = e.keyCode;
            if (k === 13) { closeIme(true); loadSuggestions(); runSearch(); }
            else if (k === 10009) { closeIme(false); }
            else { return; }   /* everything else belongs to the IME */
            /* Only the two keys handled here are swallowed. Stopping every key
             * meant that once the keyboard closed, Nav never saw another press
             * and the remote appeared dead. */
            e.stopPropagation();
            e.preventDefault();
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

    /* Search stopped at whatever one page returned. It pages like the feeds do,
     * from the same focus-nears-the-end trigger. */
    function maybeLoadMoreSearch(focused) {
        if (loadingMore || playing || optionsOpen || state.screen !== "search") { return; }
        if (!state.results || !focused || !focused.getAttribute) { return; }
        if (focused.getAttribute("data-i") === null) { return; }
        if (Number(focused.getAttribute("data-i")) < state.results.length - 6) { return; }

        loadingMore = true;
        var next = (state.searchPage || 1) + 1;
        var term = state.query.trim();
        API.search(term, next, function (more) {
            loadingMore = false;
            if (state.screen !== "search" || state.query.trim() !== term) { return; }
            var seen = {};
            for (var i = 0; i < state.results.length; i++) { seen[state.results[i].bvid] = 1; }
            var fresh = [];
            for (var j = 0; j < more.length; j++) {
                if (more[j].bvid && !seen[more[j].bvid]) { fresh.push(more[j]); }
            }
            if (!fresh.length) { return; }
            state.searchPage = next;
            state.results = state.results.concat(fresh);
            paintResults(state.results, true);
        }, function () { loadingMore = false; });
    }

    function paintResults(items, keepFocus) {
        var cur = Nav.current();
        var focusedIndex = (keepFocus && cur && cur.getAttribute &&
                            cur.getAttribute("data-i") !== null)
            ? Number(cur.getAttribute("data-i")) : null;
        var results = el("results");
        if (!results) { return null; }
        var html = '<div class="grid">';
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], i); }
        results.innerHTML = html + "</div>";
        /* Fold the keyboard away once there is something to look at, so the
         * results are not buried under four rows of letters. */
        var kb = screenEl.querySelector(".keyboard");
        if (kb) { kb.className = "keyboard collapsed"; }
        var cards = results.querySelectorAll(".card");
        for (var j = 0; j < cards.length; j++) {
            (function (card, v) { card.onselect = function () { playVideo(v); }; })(
                cards[j], items[Number(cards[j].getAttribute("data-i"))]);
        }
        if (keepFocus && focusedIndex !== null && cards[focusedIndex]) {
            Nav.focus(cards[focusedIndex]);
        }
        return cards[0];
    }

    function runSearch() {
        if (!state.query.trim()) { toast("先输入关键词"); return; }
        var token = viewToken;
        var results = el("results");
        results.innerHTML = '<div class="empty">搜索中…</div>';
        state.searchPage = 1;
        API.search(state.query.trim(), 1, function (items) {
            if (!stillViewing(token)) { return; }
            results = el("results");
            if (!results) { return; }
            if (!items.length) { results.innerHTML = '<div class="empty">没有结果</div>'; return; }
            state.results = items;
            var first = paintResults(items);
            Nav.focus(first);
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

            /* Local first, because it is the only record of what this app has
             * played — the server-side list needs a CSRF token we never see. */
            var mine = Resume.recent(24);
            var h0 = el("hist");
            if (mine.length && h0) {
                var g0 = '<div class="grid">';
                for (var m0 = 0; m0 < mine.length; m0++) { g0 += cardHtml(mine[m0], m0); }
                h0.innerHTML = g0 + "</div>";
                var lc = h0.querySelectorAll(".card");
                for (var li = 0; li < lc.length; li++) {
                    (function (card, vv) { card.onselect = function () { playVideo(vv); }; })(
                        lc[li], mine[Number(lc[li].getAttribute("data-i"))]);
                }
            }

            el("btn-logout").onselect = function () {
                Auth.logout();
                toast("已退出登录");
                renderMine();
            };
            Nav.reset("#btn-logout");

            if (me.isLogin) {
                API.history(function (items) {
                    var h = el("hist");
                    if (!h) { return; }
                    if (!items.length) { h.innerHTML = '<div class="empty">没有历史记录</div>'; return; }
                    var g = '<div class="grid">';
                    for (var i = 0; i < items.length; i++) { g += cardHtml(items[i], i); }
                    h.innerHTML = g + "</div>";
                    var cards = h.querySelectorAll(".card");
                    for (var j = 0; j < cards.length; j++) {
                        (function (card, v) { card.onselect = function () { playVideo(v); }; })(
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

    /* ---------------- playback ---------------- */

    /* Selecting a video plays it. What used to be a detail page is the panel the
     * down key pulls up over the video. */
    function playVideo(v, fromPanel) {
        if (!fromPanel) { rememberPosition(); }
        if (v.pages) { play(v, v.cid); return; }

        /* 推荐, 热门 and 排行 already carry the cid, which is all playback needs.
         * Waiting on a view() round trip just to learn something we were handed
         * put seconds of black screen between the button and the picture. Start
         * immediately and fill in the description, parts and related list behind
         * the video, since only the panel wants them. */
        if (v.cid) {
            var provisional = {
                bvid: v.bvid, cid: v.cid, title: v.title, pic: v.pic,
                author: v.author, duration: v.duration, play: v.play,
                desc: "", pages: []
            };
            play(provisional, v.cid);
            return;
        }

        var token = newView();
        toast("正在打开…");
        API.view(v.bvid, function (d) {
            if (!stillViewing(token)) { return; }
            play(d, d.cid);
        }, function (why) {
            if (!stillViewing(token)) { return; }
            toast("打开失败：" + why);
        });
    }

    function startProgressive(r) {
        playing.quality = r.quality;
        playing.accept = r.accept || [];
        playing.urls = r.urls || [r.url];
        playing.urlIdx = 0;
        setQualityBadge(QUALITY_NAMES[r.quality] || ("QN " + r.quality));
        Player.playProgressive(playing.urls[0], playing.startMs || 0);
    }

    /* The part label can only be drawn once the page list has arrived. */
    function refreshPartLabel() {
        if (!playing) { return; }
        var d = playing.detail, cid = playing.cid, label = "";
        if (d.pages && d.pages.length > 1) {
            for (var i = 0; i < d.pages.length; i++) {
                if (d.pages[i].cid === cid) {
                    label = "P" + (i + 1) + " / " + d.pages.length + "  " + d.pages[i].part;
                    break;
                }
            }
        }
        el("player-part").textContent = label;
    }

    function fmt(ms) {
        var s = Math.floor((ms || 0) / 1000);
        var m = Math.floor(s / 60);
        s = s % 60;
        if (m < 60) { return m + ":" + ("0" + s).slice(-2); }
        return Math.floor(m / 60) + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + s).slice(-2);
    }

    function setQualityBadge(text) {
        var b = el("player-quality");
        b.textContent = text || "";
        b.className = text ? "" : "hidden";
    }

    var HINT = "确认键 播放/暂停 · 左右 快退/快进 · 下键 简介/相关 · 返回键 退出";
    var chromeTimer = null;

    /* A paused video should read as paused from the sofa, not just by a frozen
     * number in the corner. */
    function setPaused(paused) {
        if (paused) {
            Player.pause();
            el("pause-glyph").className = "";
            el("playerui").className = "";
            if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
        } else {
            Player.resume();
            el("pause-glyph").className = "hidden";
            showChrome();
        }
    }
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

    /* ---------------- scrubbing ----------------
     * Ten seconds a press is unusable on a fifty-minute video. Holding a
     * direction now moves a scrub head along the bar, accelerating the longer it
     * is held, and the jump commits when the viewer stops — the same shape as
     * every television player, and it keeps a single button doing one thing. */
    var scrub = null;          /* {target, step, commitTimer} */

    function scrubStep() {
        /* 10s, then 30s, then a minute, then a thirtieth of the video: on a long
         * upload the last tier is what makes crossing it bearable. */
        var n = scrub.presses;
        var dur = Player.durationMs() || 0;
        if (n < 4) { return 10000; }
        if (n < 8) { return 30000; }
        if (n < 14) { return 60000; }
        return Math.max(60000, Math.floor(dur / 30));
    }

    function enterScrub() {
        if (scrub) { return; }
        if (!Player.durationMs()) { return; }
        scrub = { target: lastKnownPosition, presses: 0, timer: null };
        el("playerui").className = "scrubbing";
        el("player-scrub").className = "";
        if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
    }

    function moveScrub(dir) {
        if (!playing) { return; }
        if (!scrub) { enterScrub(); }
        if (!scrub) {
            /* No duration means no bar to scrub along, but a relative jump still
             * works — silently doing nothing made the key feel broken. */
            Player.seekBy(dir * 10000);
            return;
        }
        scrub.presses++;
        var dur = Player.durationMs() || 0;
        scrub.target = Math.max(0, Math.min(dur ? dur - 2000 : Infinity,
                                            scrub.target + dir * scrubStep()));
        paintScrub();
        if (scrub.timer) { clearTimeout(scrub.timer); }
        /* Commit on a pause in input rather than on a separate confirm press:
         * one button, one meaning. */
        scrub.timer = setTimeout(commitScrub, 700);
    }

    function paintScrub() {
        var dur = Player.durationMs() || 1;
        var pct = Math.min(100, (scrub.target / dur) * 100);
        el("player-fill").style.width = pct + "%";
        el("player-scrub").style.left = "calc(" + pct + "% - 3px)";
        el("player-pos").textContent = fmt(scrub.target);
    }

    function commitScrub() {
        if (!scrub) { return; }
        var target = scrub.target;
        cancelScrub();
        Player.seekTo(target);
    }

    function cancelScrub() {
        if (!scrub) { return; }
        if (scrub.timer) { clearTimeout(scrub.timer); }
        scrub = null;
        el("playerui").className = "";
        el("player-scrub").className = "hidden";
        showChrome();
    }

    var lastKnownPosition = 0;

    /* ---------------- options: quality and parts ---------------- */

    var optionsOpen = false;

    var QUALITY_NAMES = {
        127: "8K", 120: "4K", 116: "1080P60", 112: "1080P+",
        80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P"
    };

    function openOptions() {
        if (!playing || optionsOpen) { return; }
        cancelScrub();
        optionsOpen = true;
        el("playerui").className = "hidden";
        el("options").className = "scroll";
        el("options").scrollTop = 0;

        var d = playing.detail;

        el("panel-title").textContent = d.title || "";
        el("panel-meta").textContent = [d.author, d.duration, (d.play || "") + "次观看"]
            .filter(function (x) { return !!x; }).join("  ·  ");
        el("panel-desc").textContent = (d.desc || "").slice(0, 400);

        var group = el("opt-parts-group");
        if (d.pages && d.pages.length > 1) {
            group.className = "opt-group";
            var ph = "";
            for (var p = 0; p < d.pages.length && p < 40; p++) {
                ph += '<div class="opt focusable' + (d.pages[p].cid === playing.cid ? " current" : "") +
                      '" data-cid="' + d.pages[p].cid + '">P' + (p + 1) + "</div>";
            }
            el("opt-parts").innerHTML = ph;
        } else {
            group.className = "opt-group hidden";
            el("opt-parts").innerHTML = "";
        }

        /* Related videos live in the panel now, so "what else" never costs the
         * viewer their place in the video. */
        var rg = el("opt-related-group");
        if (d.related && d.related.length) {
            rg.className = "opt-group";
            var rh = '<div class="grid">';
            for (var r = 0; r < d.related.length && r < 16; r++) {
                rh += cardHtml(d.related[r], r);
            }
            el("opt-related").innerHTML = rh + "</div>";
            var rcards = el("opt-related").querySelectorAll(".card");
            for (var rc = 0; rc < rcards.length; rc++) {
                (function (card, vv) {
                    card.onselect = function () {
                        /* playVideo remembers the browse position, and it must
                         * not see the panel's own cards as the feed's. */
                        var fromPanel = true;
                        closeOptions();
                        playVideo(vv, fromPanel);
                    };
                })(rcards[rc], d.related[Number(rcards[rc].getAttribute("data-i"))]);
            }
        } else {
            rg.className = "opt-group";
            el("opt-related").innerHTML = '<div class="empty">正在加载相关视频…</div>';
        }

        var opts = document.querySelectorAll("#options .opt");
        for (var k = 0; k < opts.length; k++) {
            (function (node) {
                node.onselect = function () {
                    var cid = node.getAttribute("data-cid");
                    closeOptions();
                    if (cid) { play(playing.detail, Number(cid)); }
                };
            })(opts[k]);
        }
        Nav.reset("#options .opt.current") ;
        if (!Nav.current()) { Nav.reset("#options .opt"); }
    }

    function closeOptions() {
        if (!optionsOpen) { return; }
        optionsOpen = false;
        el("options").className = "hidden scroll";
        if (!playing) { return; }
        el("playerui").className = "";
        showChrome();
    }

    var nextToken = 0;

    function cancelNext() {
        nextToken++;   /* an in-flight nextUp lookup must not surface later */
        if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
        pendingNext = null;
        el("nextup").className = "hidden";
    }

    function beginAutoNext() {
        /* The panel belongs to the video that just ended; leaving it up meant
         * the countdown ran underneath it and the next video started with a
         * stale quality list on screen. */
        closeOptions();
        cancelScrub();
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
                /* Nothing to continue with: back to where the viewer was. */
                playing = finished;
                stopPlayback();
                return;
            }
            /* Remember what just finished: cancelling the countdown should land
             * on the video the viewer was watching, not the one queued up. */
            next.from = finished && finished.detail;
            pendingNext = next;
            el("playerui").className = "hidden";
            el("nextup").className = "";
            el("nextup-title").textContent = next.title;
            var thumb = el("nextup-thumb");
            if (next.detail && next.detail.pic) {
                thumb.src = next.detail.pic;
                thumb.className = "";
            } else { thumb.className = "hidden"; }

            var left = 8;
            el("nextup-count").textContent = left;
            nextTimer = setInterval(function () {
                left--;
                el("nextup-count").textContent = left;
                if (left <= 0) { playNext(); }
            }, 1000);
        });
    }

    function handleNextKeys(k) {
        if (k === Nav.KEY.ENTER || k === Nav.KEY.PLAY_PAUSE) { playNext(); return true; }
        if (k === Nav.KEY.RETURN) {
            var finished = pendingNext.from;
            cancelNext();
            playing = finished ? { detail: finished, cid: finished.cid } : null;
            stopPlayback();
            return true;
        }
        if (k === Nav.KEY.EXIT) { return false; }
        return true;
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
        /* Every per-video piece of player state is cleared here. Leaving any of
         * it behind is invisible until the exact moment it matters: the scrub
         * head seeded from the last video would jump a fresh one straight to its
         * own ending. */
        closeOptions();
        cancelScrub();
        playing = { detail: detail, cid: cid };
        var startMs = Resume.positionMs(detail.bvid, cid);
        lastKnownPosition = startMs;
        playing.startMs = startMs;
        if (startMs) { toast("从 " + fmt(startMs) + " 继续播放"); }
        el("player-title").textContent = detail.title;
        var partLabel = "";
        if (detail.pages && detail.pages.length > 1) {
            for (var pi = 0; pi < detail.pages.length; pi++) {
                if (detail.pages[pi].cid === cid) {
                    partLabel = "P" + (pi + 1) + " / " + detail.pages.length +
                                "  " + detail.pages[pi].part;
                    break;
                }
            }
        }
        el("player-part").textContent = partLabel;
        setQualityBadge("");
        el("player-buffer").style.width = "0%";
        el("pause-glyph").className = "hidden";
        el("player-hint").textContent = HINT;

        /* Deliberately not fetched here. Everything the panel wants is queued
         * until the picture is up, so nothing competes with AVPlay for a
         * connection while it is opening the stream. */
        playing.needsMeta = true;
        el("pause-glyph").className = "hidden";
        cancelScrub();
        el("player-pos").textContent = "0:00";
        el("player-dur").textContent = detail.duration;
        el("player-fill").style.width = "0%";
        showPlayerUi(true);
        el("loading-title").textContent = detail.title || "";
        el("player-loading").className = "";
        status("");

        /* Route by what each form can actually deliver.
         *
         * bilibili caps the single-file (durl) form at 720p and, for anything
         * with a high-tier source, refuses it outright — the API still returns a
         * url and the CDN answers 403 on every mirror. DASH carries the real
         * quality ladder. So ask DASH what it has first, and take progressive
         * only when it is no worse, because AVPlay's native path beats
         * hand-rolled MSE on buffering, seeking and memory. */
        playing.canDowngrade = true;
        var session = playing;
        report("player", "requesting qn=" + PREFERRED_QN);

        API.playurlDash(detail.bvid, cid, PREFERRED_QN, function (dash) {
            if (playing !== session) { return; }
            var best = Player.pickDashVideo(dash);
            var dashQn = (best && best.id) || 0;
            report("player", "dash offers qn=" + dashQn +
                   " accept=" + (dash.acceptQuality || []).join(","));

            API.playurlProgressive(detail.bvid, cid, PREFERRED_QN, function (r) {
                if (playing !== session) { return; }
                report("player", "progressive gave qn=" + r.quality +
                       " accept=" + (r.accept || []).join(","));
                if (dashQn > r.quality) { playDash(dash, dashQn); }
                else { startProgressive(r); }
            }, function (why) {
                if (playing !== session) { return; }
                report("player", "no durl (" + why + ")");
                if (dashQn) { playDash(dash, dashQn); }
                else { toast("播放失败：" + why); stopPlayback(); }
            });
        }, function (dashWhy) {
            if (playing !== session) { return; }
            report("player", "no dash (" + dashWhy + ")");
            API.playurlProgressive(detail.bvid, cid, PREFERRED_QN, function (r) {
                if (playing !== session) { return; }
                report("player", "progressive gave qn=" + r.quality);
                startProgressive(r);
            }, function (why) {
                if (playing !== session) { return; }
                toast("播放失败：" + why);
                stopPlayback();
            });
        });
    }

    /* Hand a DASH response to the player and label it with the representation
     * the player itself picked, so the badge cannot disagree with the picture. */
    function playDash(dash, qn) {
        playing.quality = qn;
        setQualityBadge(QUALITY_NAMES[qn] || ("QN " + qn));
        Player.playDash(dash, playing.startMs || 0);
    }

    /* Every progressive mirror refused. Retrying progressive at a lower quality
     * is pointless: for videos that carry a 4K source, bilibili refuses the
     * MP4 form outright — the API still hands back a url and the CDN answers 403
     * on every tier. DASH for the same video serves fine, so that is the
     * fallback. This is why "some videos" failed while most were fine. */
    function downgrade(why) {
        if (!playing || playing.downgraded) { stopPlayback(); return; }
        playing.downgraded = true;
        playing.failed = false;
        el("player-loading").className = "";
        report("player", "progressive refused (" + why + "), switching to dash");

        var d = playing.detail, cid = playing.cid, session = playing;
        API.playurlDash(d.bvid, cid, PREFERRED_QN, function (dash) {
            if (playing !== session) { return; }
            var vrep = Player.pickDashVideo(dash);
            if (vrep && vrep.id) {
                playing.quality = vrep.id;
                setQualityBadge(QUALITY_NAMES[vrep.id] || ("QN " + vrep.id));
            }
            Player.playDash(dash, Resume.positionMs(d.bvid, cid));
        }, function (w2) {
            if (playing !== session) { return; }
            toast("播放失败：" + w2);
            stopPlayback();
        });
    }

    /* Runs once the stream is playing, so the description, parts and related
     * list arrive without contending with the player for the network. */
    function loadMetaForPlaying() {
        if (!playing || !playing.needsMeta) { return; }
        playing.needsMeta = false;
        var session = playing, d = session.detail;

        if (!d.pages || !d.pages.length) {
            API.view(d.bvid, function (full) {
                if (playing !== session) { return; }
                full.related = session.detail.related;
                session.detail = full;
                refreshPartLabel();
            }, function () {});
        }
        if (!d.related) {
            API.related(d.bvid, function (list) {
                if (playing !== session) { return; }
                session.detail.related = list;
                if (optionsOpen) { closeOptions(); openOptions(); }
            }, function () {});
        }
    }

    /* Ask a plain XHR for the same bytes AVPlay just refused. A 206 here means
     * the url and the network are fine and the fault is in how AVPlay asks —
     * which is the distinction that took several deploys to establish the first
     * time, so it is now answered automatically on every failure. */
    function probeUrl(url, why) {
        var host = String(url).split("/")[2] || "?";
        var scheme = String(url).slice(0, 5);
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.setRequestHeader("Range", "bytes=0-1023");
            xhr.timeout = 10000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                report("probe", scheme + " " + host + " avplay=" + why +
                       " xhr=" + xhr.status);
            };
            xhr.ontimeout = function () { report("probe", host + " xhr=timeout"); };
            xhr.onerror = function () { report("probe", host + " xhr=error"); };
            xhr.send();
        } catch (e) {}
    }

    function stopPlayback() {
        el("player-loading").className = "hidden";
        var was = playing;
        Resume.flush();
        cancelScrub();
        closeOptions();
        el("pause-glyph").className = "hidden";
        cancelNext();
        playedInChain = {};
        Player.stop();
        playing = null;
        showPlayerUi(false);
        /* Back to the grid the viewer was browsing, at the card they picked. */
        var home = state.screen;
        if (home === "search") { renderSearch(); }
        else if (home === "mine") { renderMine(); }
        else { loadFeed(home, true); }
    }

    Player.on(function (kind, data) {
        if (kind === "time") {
            if (playing) {
                var d0 = playing.detail;
                Resume.record(d0.bvid, playing.cid, data.position, data.duration, {
                    bvid: d0.bvid, title: d0.title, pic: d0.pic,
                    author: d0.author, duration: d0.duration, play: d0.play
                });
            }
            lastKnownPosition = data.position;
            /* While scrubbing the bar belongs to the scrub head, not the clock. */
            if (scrub) { return; }
            el("player-pos").textContent = fmt(data.position);
            if (data.duration) {
                el("player-dur").textContent = fmt(data.duration);
                el("player-fill").style.width =
                    Math.min(100, (data.position / data.duration) * 100) + "%";
                var buf = Player.bufferedMs();
                el("player-buffer").style.width =
                    Math.min(100, (buf / data.duration) * 100) + "%";
            }
        } else if (kind === "playing") {
            el("player-loading").className = "hidden";
            loadMetaForPlaying();
        } else if (kind === "buffering") {
            el("player-hint").textContent = data ? "缓冲中…" : HINT;
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
            el("player-loading").className = "hidden";
            report("player", data);
            if (playing.urls && playing.urlIdx + 1 < playing.urls.length) {
                var failedUrl = playing.urls[playing.urlIdx];
                probeUrl(failedUrl, data);
                playing.urlIdx++;
                playing.failed = false;
                el("player-loading").className = "";
                Player.playProgressive(playing.urls[playing.urlIdx], playing.startMs || 0);
                return;
            }
            if (playing.canDowngrade && !playing.downgraded) { downgrade(String(data)); return; }
            toast("播放错误：" + data);
            stopPlayback();
        }
    });

    /* ---------------- keys ---------------- */

    Nav.onKey(function (k) {
        if (pendingNext) { return handleNextKeys(k); }
        if (optionsOpen) {
            if (k === Nav.KEY.RETURN) { closeOptions(); return true; }
            /* Up from the first row leaves the panel, mirroring the down key
             * that opened it — otherwise return is the only way out and there
             * is nothing on screen that says so. */
            if (k === Nav.KEY.UP && el("options").scrollTop <= 2) {
                var cur = Nav.current();
                var row = cur && cur.parentNode;
                if (row && (row.id === "opt-parts" || row.id === "opt-related" ||
                            (row.parentNode && row.parentNode.id === "opt-related"))) {
                    closeOptions(); return true;
                }
            }
            if (k === Nav.KEY.EXIT) { return false; }
            return false;   /* let Nav move focus between the options */
        }
        if (!playing) { return false; }
        if (!scrub) { showChrome(); }
        /* While playing, the remote drives the player rather than the focus. */
        switch (k) {
            case Nav.KEY.ENTER:
            case Nav.KEY.PLAY_PAUSE:
                if (scrub) { commitScrub(); return true; }
                setPaused(!Player.isPaused());
                return true;
            case Nav.KEY.LEFT:
            case Nav.KEY.REW:
                moveScrub(-1); return true;
            case Nav.KEY.RIGHT:
            case Nav.KEY.FF:
                moveScrub(1); return true;
            case Nav.KEY.DOWN:
                openOptions(); return true;
            case Nav.KEY.RETURN:
                if (scrub) { cancelScrub(); return true; }
                stopPlayback(); return true;
            case Nav.KEY.EXIT:
                return false;   /* let Nav close the app */
            default:
                return true;
        }
    });

    Nav.onBack(function () {
        if (imeOpen) { closeIme(false); return; }
        if (playing) { stopPlayback(); return; }
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
        Nav.onFocus(function (elm) { maybeLoadMore(elm); maybeLoadMoreSearch(elm); });
        /* Settings were only consulted from inside 我的, so a quality picked in
         * the panel was forgotten on the next launch. */

        var tabs = document.querySelectorAll("#tabs .tab");
        for (var i = 0; i < tabs.length; i++) {
            (function (tab) {
                tab.onselect = function () {
                    var s = tab.getAttribute("data-screen");
                    Auth.cancelQrLogin();
                    if (s === "search") { renderSearch(); }
                    else if (s === "mine") { renderMine(); }
                    /* Pressing the tab you are already on reloads it; coming
                     * back to a tab restores where you were, which is what a
                     * television expects — refetching and jumping to the first
                     * card loses your place every time you glance elsewhere. */
                    else { loadFeed(s, state.screen !== s); }
                };
            })(tabs[i]);
        }

        loadFeed("rcmd");
        if (typeof SELFTEST !== "undefined" && SELFTEST && typeof SelfTest !== "undefined") {
            SelfTest.run();
        }
    };
})();
