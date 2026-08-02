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
        paintAccount();
    }

    /* ---------------- who is watching ---------------- */

    /* Accounts are created before anyone knows whose they are: the web fallback
     * hands back cookies and no identity at all, and even the TV path only
     * carries a mid until nav() has been asked for a name. */
    function accountLabel(acc) {
        if (!acc) { return "未登录"; }
        if (acc.uname) { return acc.uname; }
        if (acc.mid) { return "UID " + acc.mid; }
        return "账号 " + String(acc.id).slice(1);
    }

    function initial(name) {
        var s = String(name || "").replace(/^\s+/, "");
        return s ? s.charAt(0) : "?";
    }

    /* The chip in the top bar. Repainted from markTab, so every screen that
     * renders keeps it honest. */
    function paintAccount() {
        var node = el("account");
        if (!node) { return; }
        var acc = Accounts.active();
        var label = accountLabel(acc);
        var stale = !!(acc && Accounts.needsRelogin(acc));

        /* Same trap the tabs documented above: rebuilding className here would
         * strip the focus ring off the chip while the viewer is standing on it. */
        node.className = "focusable" + (stale ? " warn" : "") +
                         (node === Nav.current() ? " focused" : "");

        el("account-name").textContent = stale ? label + "（需重新扫码）" : label;

        var face = el("account-face"), mark = el("account-initial");
        if (acc && acc.face && !stale) {
            face.src = acc.face;
            face.className = "";
            mark.className = "hidden";
        } else {
            face.className = "hidden";
            mark.className = "";
            mark.textContent = acc ? initial(label) : "客";
        }
    }

    /* Fills in the name and avatar for whoever is active. Deliberately does not
     * act on isLogin:false — that would also fire if the firmware ever refused
     * the Cookie header, and marking every stored account dead on the strength
     * of one ambiguous answer is exactly the kind of guess this project has
     * paid for before. 我的 reports the failure instead, where it is readable. */
    function refreshActiveProfile() {
        var acc = Accounts.active();
        if (!acc || !Auth.isLoggedIn()) { return; }
        /* Which route is carrying the session. Whether this firmware lets a
         * widget set a Cookie header is the fact the whole account design rests
         * on, and nothing else in the app would ever say — a session that works
         * and one that silently falls back to the jar look identical on screen. */
        var route = Auth.cookieHeader() ? "Cookie 头"
                  : (Auth.jarIsOurs() ? "cookie jar" : "无凭证");
        API.nav(function (me) {
            report("account", Accounts.count() + " 个账号，当前 route=" + route +
                   "，服务器" + (me.isLogin ? ("认得 " + me.uname) : "不认这个会话"));
            if (!me.isLogin) { return; }
            Accounts.describe(acc.id, me);
            paintAccount();
        }, function (why) { report("account", "route=" + route + "，nav 失败 " + why); });
    }

    /* The one path an account change takes. Everything personal has to be let
     * go of here: the feed cache holds the previous account's recommendations,
     * and serving those under a new name is both wrong and invisible. */
    function switchTo(id) {
        if (playing) { stopPlayback(); }
        Auth.cancelLogin();
        Resume.flush();          /* into the outgoing account's namespace */
        Accounts.switchTo(id);
        feedCache = {};
        state.query = "";
        state.results = null;
        paintAccount();

        var acc = Accounts.active();
        if (acc && Accounts.needsRelogin(acc)) {
            toast("这个账号的登录凭证已经不在了，需要重新扫码");
            renderLogin(acc.id);
            return;
        }
        refreshActiveProfile();
        loadFeed("rcmd");
    }

    /* ---------------- grid of videos ---------------- */

    function cardHtml(v, i) {
        /* Server-side history carries its own progress; everything else asks
         * the local record. */
        var seen = (typeof v.seen === "number") ? v.seen : Resume.fraction(v.bvid);
        return '<div class="card focusable" data-i="' + i + '">' +
               '<div class="thumb"><img src="' + esc(v.pic) + '" alt="">' +
               '<span class="dur">' + esc(v.duration) + '</span>' +
               (seen ? '<span class="seen" style="width:' + Math.round(seen * 100) + '%"></span>' : "") +
               '</div>' +
               '<div class="card-title">' + esc(v.title) + '</div>' +
               '<div class="card-meta">' +
               /* Which part you were on, on the history cards — "看到一半" is
                * not much use on a 24-part upload without it. */
               (v.page ? '<span class="card-part">P' + esc(v.page) + '</span>' : "") +
               esc(v.author) + (v.play ? ' &middot; ' + esc(v.play) + '次观看' : "") +
               '</div>' +
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

    /* A grid of cards inside any container, wired to play on select. 我的 builds
     * two of these and the player panel a third. */
    function paintCards(container, items) {
        if (!container) { return; }
        var html = '<div class="grid">';
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], i); }
        container.innerHTML = html + "</div>";

        var cards = container.querySelectorAll(".card");
        for (var j = 0; j < cards.length; j++) {
            (function (card) {
                card.onselect = function () {
                    playVideo(items[Number(card.getAttribute("data-i"))]);
                };
            })(cards[j]);
        }
    }

    /* The two histories, folded into one run of cards in time order.
     *
     * They were two sections for a while, on the theory that "watched here" and
     * "watched on the phone" are different things. From the sofa they are not:
     * it is one viewer, one account, and the question is always what was on
     * last. Two lists meant comparing timestamps by eye across a screen break —
     * and now that this television reports what it plays, the same video shows
     * up in both, so keeping them apart would show it twice.
     *
     * One card per video, keyed on bvid. The two sides know different things,
     * so the loser is not discarded outright: the server carries the resume
     * point from the phone, the local record carries the last thirty seconds
     * watched here, and dropping either one breaks carrying on where you were.
     */
    function mergeHistory(local, server) {
        var byBvid = {}, out = [];
        var all = local.concat(server);
        for (var i = 0; i < all.length; i++) {
            var card = all[i], k = card.bvid;
            var held = byBvid[k];
            if (!held) { byBvid[k] = card; continue; }

            var winner = (card.at || 0) > (held.at || 0) ? card : held;
            var loser = (winner === card) ? held : card;

            /* A resume point only ever comes from the server, so it has to
             * survive the local card winning on recency — that pair is what
             * makes a video open where the phone left it.
             *
             * Only within the same part, though. On a 24-part upload the two
             * sides can name different parts, and then "further along" is not
             * the same question as "more recent": this set reports what it
             * plays, but the server's copy lags it by up to a report interval,
             * so for half a minute after watching P3 here the phone's older P7
             * is still the further of the two. Carrying it over would send the
             * next press back to P7. Across parts the recent side decides. */
            var samePart = !winner.cid || !loser.cid || winner.cid === loser.cid;
            if (samePart) {
                if ((loser.progressMs || 0) > (winner.progressMs || 0)) {
                    winner.progressMs = loser.progressMs;
                }
                if (!winner.cid && loser.cid) { winner.cid = loser.cid; }
                if (!winner.page && loser.page) { winner.page = loser.page; }
            }
            byBvid[k] = winner;
        }
        for (var b in byBvid) {
            if (!byBvid.hasOwnProperty(b)) { continue; }
            var c = byBvid[b];
            /* The sliver: the server's figure and this set's own record disagree
             * for the length of one report interval, and the further of the two
             * is the honest one. */
            c.seen = Math.max((typeof c.seen === "number") ? c.seen : 0,
                              Resume.fraction(c.bvid));
            out.push(c);
        }
        out.sort(function (a, b2) { return (b2.at || 0) - (a.at || 0); });
        return out;
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

    /* The zone tabs, as bilibili's partition ids. Each is that partition's
     * ranking — the same shape as 排行, and unsigned at every rid.
     *
     * These are the 1000-series ids of the site's current layout, taken from
     * the zone pages themselves: /c/food is 1020, /c/dance 1004, /c/ai 1011,
     * /c/tech 1012. The old two-and-three-digit ids still answer (美食 was 211,
     * 舞蹈 129) but they are the previous layout, and they no longer hold what
     * the website shows under the same name.
     *
     * There is no public list of these. The only way to learn one is to open
     * the zone page and read the `region_id` its own requests carry — the
     * search and ranking endpoints will not tell you, and guessing by name
     * finds nothing. */
    var ZONES = { food: 1020, dance: 1004, ai: 1011, tech: 1012 };

    /* ranking answers with its full 100 in one go and has no second page. */
    function fetchPage(kind, page, onOk, onFail) {
        if (kind === "ranking") { return page === 1 ? API.ranking(0, onOk, onFail) : onOk([]); }
        if (ZONES[kind]) { return page === 1 ? API.ranking(ZONES[kind], onOk, onFail) : onOk([]); }
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

    /* ---------------- accounts ---------------- */

    /* Modelled on how a television handles a shared household: a wall of faces,
     * the current one marked, an empty tile to add another, and removal kept
     * behind a separate mode so nobody deletes their sister by pressing OK on
     * the wrong square. */
    var manageMode = false;

    function tileHtml(id, faceInner, name, tag, on) {
        return '<div class="acc focusable' + (on ? " on" : "") + '" data-id="' + esc(id) + '">' +
               '<div class="acc-face">' + faceInner + '</div>' +
               '<div class="acc-name">' + esc(name) + '</div>' +
               '<div class="acc-tag">' + esc(tag) + '</div>' +
               '</div>';
    }

    function renderAccounts(picker) {
        state.screen = "accounts";
        manageMode = false;
        newView();
        Auth.cancelLogin();
        paintAccounts(picker);
    }

    function paintAccounts(picker) {
        markTab();
        var list = Accounts.all();
        var activeId = Accounts.activeId();

        var html = '<div class="accounts' + (manageMode ? " managing" : "") + '">' +
                   '<h2>' + (picker ? "谁在看？" : (manageMode ? "选择要移除的账号" : "切换账号")) + '</h2>' +
                   '<div class="acc-row">';

        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            var label = accountLabel(a);
            var stale = Accounts.needsRelogin(a);
            var inner = (a.face && !stale)
                ? '<img src="' + esc(a.face) + '" alt="">'
                : '<span class="acc-initial">' + esc(initial(label)) + '</span>';

            var tag = "";
            if (manageMode) { tag = "移除"; }
            else if (a.id === activeId) { tag = "当前"; }
            else if (stale) { tag = "需重新扫码"; }

            html += tileHtml(a.id, inner, label, tag, a.id === activeId && !manageMode);
        }

        if (!manageMode) {
            /* Somewhere to go that touches nobody's history or recommendations.
             * Only offered once there is an account it could be confused with. */
            if (list.length) {
                html += tileHtml("__guest", '<span class="acc-initial">客</span>', "访客",
                                 activeId === Accounts.GUEST ? "当前" : "",
                                 activeId === Accounts.GUEST);
            }
            html += tileHtml("__add", '<span class="acc-plus">+</span>', "添加账号", "", false);
        }

        html += '</div><div id="acc-actions"></div>';
        if (list.length && !manageMode) {
            html += '<div class="acc-note">每个账号的观看记录和推荐都是分开的，互相看不到。</div>';
        }
        screenEl.innerHTML = html + '</div>';

        var tiles = screenEl.querySelectorAll(".acc");
        for (var j = 0; j < tiles.length; j++) {
            (function (node) {
                var id = node.getAttribute("data-id");
                node.onselect = function () {
                    if (id === "__add") { renderLogin(null); return; }
                    if (manageMode) { confirmRemove(id); return; }
                    if (id === "__guest") { switchTo(Accounts.GUEST); return; }
                    if (id === activeId) {
                        /* Already here — unless their credentials are gone, in
                         * which case switchTo would not run and pressing OK on
                         * your own face would silently do nothing. */
                        var cur = Accounts.get(id);
                        if (cur && Accounts.needsRelogin(cur)) { renderLogin(id); return; }
                        loadFeed("rcmd");
                        return;
                    }
                    switchTo(id);
                };
            })(tiles[j]);
        }

        var box = el("acc-actions");
        if (list.length && box) {
            box.innerHTML = '<div class="actions">' +
                '<div class="btn ghost focusable" id="btn-manage">' +
                (manageMode ? "完成" : "管理账号") + '</div></div>';
            el("btn-manage").onselect = function () {
                manageMode = !manageMode;
                paintAccounts(false);
            };
        }

        var pick = screenEl.querySelector(".acc.on") || screenEl.querySelector(".acc");
        Nav.focus(pick);
    }

    function confirmRemove(id) {
        var acc = Accounts.get(id);
        var box = el("acc-actions");
        if (!acc || !box) { return; }
        var label = accountLabel(acc);

        box.innerHTML = '<div class="acc-confirm">移除「' + esc(label) + '」？' +
            '这台电视上属于 TA 的观看记录会一起删掉，bilibili 上的账号不受影响。</div>' +
            '<div class="actions">' +
            '<div class="btn ghost focusable" id="btn-cancel">取消</div>' +
            '<div class="btn danger focusable" id="btn-remove">移除</div>' +
            '</div>';

        el("btn-cancel").onselect = function () { paintAccounts(false); };
        el("btn-remove").onselect = function () {
            var wasActive = Accounts.activeId() === id;
            Accounts.remove(id);
            manageMode = false;
            /* Whether or not the removed account was the active one, the cached
             * feeds may be theirs — remove() promotes somebody else. */
            feedCache = {};
            state.query = "";
            state.results = null;
            toast("已移除「" + label + "」");
            if (!Accounts.count()) { renderLogin(null); return; }
            if (wasActive) { refreshActiveProfile(); }
            paintAccounts(false);
        };
        /* Cancel takes the focus: the destructive button should need a
         * deliberate move to reach. */
        Nav.reset("#btn-cancel");
    }

    /* ---------------- mine / login ---------------- */

    function renderMine() {
        state.screen = "mine";
        markTab();
        Auth.cancelLogin();

        if (!Auth.isLoggedIn()) {
            /* With accounts already on the set, dropping straight into a QR code
             * hides the ones that are a single press away. */
            if (Accounts.count()) { renderAccounts(false); return; }
            renderLogin(null);
            return;
        }
        var token = newView();
        var accId = Accounts.activeId();
        screenEl.innerHTML = '<div class="mine"><div class="empty">检查登录状态…</div></div>';
        API.nav(function (me) {
            /* A slow nav landing after the viewer switched account or tab used
             * to repaint the screen they had left, under the wrong name. */
            if (!stillViewing(token)) { return; }
            if (me.isLogin) { Accounts.describe(accId, me); paintAccount(); }

            var html = '<div class="mine">' +
                '<div class="me">' +
                '<div class="me-name">' + esc(me.isLogin ? me.uname : "会话已失效") + '</div>' +
                '<div class="me-sub">' + (me.isLogin
                    ? "已登录，等级 " + esc(me.level) + " · 1080P 可用"
                    : "服务器不认这个会话，需要重新扫码") + '</div>' +
                '<div id="mine-actions"><div class="actions">' +
                '<div class="btn focusable" id="btn-switch">切换账号</div>' +
                '<div class="btn ghost focusable" id="btn-logout">退出登录</div>' +
                '</div></div></div>';
            /* One list. The local record is painted straight away because it
             * costs nothing and the screen should not open empty; the server's
             * arrives a moment later and the two are merged in place. */
            html += '<div class="section">观看历史</div><div id="hist"></div>' +
                    '<div id="hist-note"></div></div>';
            screenEl.innerHTML = html;

            var mine = Resume.recent(40);
            var shown = mergeHistory(mine, []);
            var h0 = el("hist");
            if (h0) {
                if (shown.length) { paintCards(h0, shown); }
                else {
                    /* "读取中…" only when something is actually on its way. With
                     * an expired session nothing follows this, and the message
                     * would have sat there for the rest of the evening. */
                    h0.innerHTML = '<div class="empty">' + (me.isLogin
                        ? "读取中…" : "这台电视上还没有看过什么") + '</div>';
                }
            }

            el("btn-switch").onselect = function () { renderAccounts(false); };

            /* Signing out takes the account off the television altogether, which
             * is not what "退出登录" implies on a phone — so it says so before
             * doing it rather than after. */
            el("btn-logout").onselect = function () {
                var box = el("mine-actions");
                if (!box) { return; }
                box.innerHTML =
                    '<div class="acc-confirm">退出并从这台电视上移除这个账号？' +
                    '本机的观看记录会一起删掉，bilibili 上的账号不受影响。</div>' +
                    '<div class="actions">' +
                    '<div class="btn ghost focusable" id="btn-cancel">取消</div>' +
                    '<div class="btn danger focusable" id="btn-remove">退出并移除</div>' +
                    '</div>';
                el("btn-cancel").onselect = function () { renderMine(); };
                el("btn-remove").onselect = function () {
                    Auth.logout();
                    feedCache = {};
                    state.query = "";
                    state.results = null;
                    paintAccount();
                    toast("已退出登录");
                    if (Accounts.count()) { renderAccounts(false); }
                    else { renderLogin(null); }
                };
                Nav.reset("#btn-cancel");
            };
            Nav.reset("#btn-switch");

            if (me.isLogin) {
                API.history(function (items, rawCount) {
                    var h = el("hist");
                    if (!h || !stillViewing(token)) { return; }
                    /* The newest title goes in the line too. A count alone says
                     * the request worked, not that the answer is current — and
                     * "is what the television has the same as what my phone
                     * shows" is the only question this log line ever gets asked.
                     * One title answers it; the rest is noise. */
                    report("history", "服务端历史 " + rawCount + " 条，可打开的 " + items.length +
                        " 条" + (items.length ? "，最新一条：" + items[0].title.slice(0, 24) : ""));

                    /* Repainting moves the ground under whoever is already
                     * looking. The card under the ring is found again by bvid,
                     * because its position in the list is exactly what the merge
                     * just changed. */
                    var cur = Nav.current();
                    var keep = "";
                    if (cur && cur.getAttribute && cur.getAttribute("data-i") !== null) {
                        var was = shown[Number(cur.getAttribute("data-i"))];
                        keep = was ? was.bvid : "";
                    }

                    shown = mergeHistory(mine, items);
                    if (!shown.length) {
                        h.innerHTML = '<div class="empty">' + (rawCount
                            ? "bilibili 上这 " + rawCount + " 条都不是普通视频（番剧/直播/专栏），这里打不开"
                            : "还没有看过什么") + '</div>';
                        return;
                    }
                    paintCards(h, shown);
                    if (keep) {
                        for (var ki = 0; ki < shown.length; ki++) {
                            if (shown[ki].bvid !== keep) { continue; }
                            Nav.focus(h.querySelectorAll(".card")[ki]);
                            break;
                        }
                    }
                }, function (why) {
                    if (!stillViewing(token)) { return; }
                    report("history", "服务端历史读取失败：" + why);
                    var h2 = el("hist");
                    var note = el("hist-note");
                    /* The local list stands on its own, so a failed request is a
                     * footnote rather than an error screen — unless there is no
                     * local list, in which case it is the whole story. */
                    if (!mine.length && h2) {
                        h2.innerHTML = '<div class="empty">读取失败：' + esc(why) + '</div>';
                    } else if (note) {
                        note.innerHTML = '<div class="empty">手机 / 网页端的记录没读到（' +
                                         esc(why) + '），下面只是这台电视上的</div>';
                    }
                });
            }
        }, function (why) {
            if (!stillViewing(token)) { return; }
            screenEl.innerHTML = '<div class="empty">无法检查登录状态：' + esc(why) + '</div>';
            Nav.reset(".tab");
        });
    }

    /* `intoId` re-authenticates an account already on the set, rather than
     * adding another face to the switcher. It matters because the web fallback
     * cannot say who just scanned, so without it a viewer restoring their own
     * expired session would end up listed twice. */
    function renderLogin(intoId) {
        state.screen = "login";
        markTab();
        var token = newView();
        var again = !!intoId;
        var more = Accounts.count() > 0;

        screenEl.innerHTML = '<div class="login">' +
            '<div class="login-left">' +
            '<h2>' + (again ? "重新扫码登录这个账号"
                            : (more ? "添加一个账号" : "用 bilibili App 扫码登录")) + '</h2>' +
            '<div class="login-step" id="login-step">正在获取二维码…</div>' +
            '<div class="login-note">登录后可用 1080P，并能看到自己的观看历史。<br>' +
            '二维码只在这台电视上生成，不会经过任何第三方。' +
            (more ? '<br>每个账号的记录和推荐相互独立。' : '') + '</div>' +
            '<div class="actions">' +
            '<div class="btn focusable" id="btn-refresh">重新获取</div>' +
            (more ? '<div class="btn ghost focusable" id="btn-back">返回账号列表</div>' : '') +
            '</div></div>' +
            '<div class="login-right" id="qrbox"></div></div>';

        el("btn-refresh").onselect = function () { renderLogin(intoId); };
        if (more) { el("btn-back").onselect = function () { renderAccounts(false); }; }
        Nav.reset("#btn-refresh");

        Auth.startLogin(function (s) {
            /* The poller outlives the screen if the viewer walks away mid-scan,
             * and cancelLogin only fires on the routes that know they are
             * leaving. */
            if (!stillViewing(token)) { return; }
            var step = el("login-step"), box = el("qrbox");
            if (!step || !box) { return; }

            if (s.kind === "qr") {
                try {
                    box.innerHTML = QR.toHtml(s.url, 8);
                    step.textContent = s.via === "tv"
                        ? "等待扫码…" : "等待扫码…（网页登录，此账号无法长期保存）";
                } catch (e) {
                    step.textContent = "二维码生成失败：" + e.message;
                    report("qr", e.message);
                }
            } else if (s.kind === "fallback") {
                /* Worth a line in the collector: it is the difference between an
                 * account that can be switched back to and one that cannot. */
                report("login", "TV 登录不可用，回落网页扫码：" + s.why);
                step.textContent = "正在改用网页扫码…";
            } else if (s.kind === "scanned") {
                step.textContent = "已扫码，请在手机上确认";
            } else if (s.kind === "finishing") {
                step.textContent = "正在换取登录凭证…";
            } else if (s.kind === "done") {
                toast("登录成功");
                feedCache = {};
                state.query = "";
                state.results = null;
                paintAccount();
                refreshActiveProfile();
                renderMine();
            } else if (s.kind === "expired") {
                step.textContent = "二维码已过期，选「重新获取」";
            } else if (s.kind === "error") {
                step.textContent = "登录失败：" + s.why;
                report("login", s.why);
            }
        }, intoId);
    }

    /* ---------------- playback ---------------- */

    /* Selecting a video plays it. What used to be a detail page is the panel the
     * down key pulls up over the video. */
    /* Which part to open. A multi-part upload watched to P7 and then reopened
     * from the feed used to start again at P1: the position for P7 was stored
     * the whole time, but nothing asked which part it belonged to. Only honoured
     * when that part is really one of this video's — a stale entry from before
     * an uploader reorganised the parts should not send playback somewhere the
     * video no longer has. */
    function resumeCid(detail) {
        var last = Resume.lastPart(detail.bvid);

        /* A handoff from bilibili's history names the part that account was
         * last on, and that beats anything this television remembers.
         *
         * It only gets to say "手机上" when the two disagree. This set reports
         * what it plays now, so the server's answer is usually this set's own
         * last part coming back around — announcing that as the phone's would
         * be telling the viewer something false about their own evening. */
        if (handoff && handoff.bvid === detail.bvid && handoff.cid) {
            var elsewhere = !last || last.cid !== handoff.cid;
            var pages0 = detail.pages || [];
            if (!pages0.length) { return handoff.cid; }
            for (var k = 0; k < pages0.length; k++) {
                if (pages0[k].cid === handoff.cid) {
                    if (pages0[k].page > 1) {
                        toast((elsewhere ? "手机上看到 P" : "从 P") + pages0[k].page +
                              "：" + (pages0[k].part || ""));
                    }
                    return handoff.cid;
                }
            }
        }

        if (!last || !last.cid || last.cid === detail.cid) { return detail.cid; }

        var pages = detail.pages || [];
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].cid === last.cid) {
                toast("从 P" + pages[i].page + " 继续：" + (pages[i].part || ""));
                return last.cid;
            }
        }
        /* Opened straight from a feed card, which carries only the first part's
         * cid and no part list. The stored cid can only have come from playing
         * this very video, so it is trustworthy even without the list. */
        if (!pages.length) {
            if (last.page) { toast("从 P" + last.page + " 继续"); }
            return last.cid;
        }
        return detail.cid;
    }

    function playVideo(v, fromPanel) {
        if (!fromPanel) { rememberPosition(); }

        /* A card from bilibili's own history carries where the phone got to.
         * Picking it up is the whole point of showing that section: the phone
         * is where things get searched for, the television is where they get
         * watched. */
        if (v.bvid && v.cid && v.progressMs) {
            handoff = { bvid: v.bvid, cid: v.cid, positionMs: v.progressMs };
        }

        if (v.pages) { play(v, resumeCid(v)); return; }

        /* 推荐, 热门 and 排行 already carry the cid, which is all playback needs.
         * Waiting on a view() round trip just to learn something we were handed
         * put seconds of black screen between the button and the picture. Start
         * immediately and fill in the description, parts and related list behind
         * the video, since only the panel wants them. */
        if (v.cid) {
            var provisional = {
                bvid: v.bvid, aid: v.aid, cid: v.cid, title: v.title, pic: v.pic,
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
            play(d, resumeCid(d));
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

    /* Chapter marks, when the uploader defined any. They arrive with the resume
     * point on the same request, so a marked bar costs nothing extra. */
    function paintChapters() {
        var box = el("player-chapters");
        if (!box) { return; }
        box.innerHTML = "";
        var dur = Player.durationMs() || 0;
        var marks = (playing && playing.chapters) || [];
        if (!dur || marks.length < 2) { return; }
        var html = "";
        for (var i = 0; i < marks.length; i++) {
            var pct = (marks[i].from * 1000) / dur * 100;
            if (!(pct > 0) || pct >= 100) { continue; }   /* 0 is the start, not a mark */
            html += '<div class="tick" style="left:' + pct.toFixed(3) + '%"></div>';
        }
        box.innerHTML = html;
    }

    function chapterAt(ms) {
        var marks = (playing && playing.chapters) || [];
        var t = ms / 1000, best = "";
        for (var i = 0; i < marks.length; i++) {
            if (marks[i].from <= t && (!marks[i].to || t < marks[i].to)) { best = marks[i].title; }
        }
        return best;
    }

    /* Sprite sheets for the scrub preview, fetched the first time a viewer
     * actually scrubs. Most videos are watched straight through, and this is a
     * request and three quarters of a megabyte of images that those videos
     * should never pay for. */
    function loadShots() {
        if (!playing || playing.shots !== undefined) { return; }
        playing.shots = null;                    /* in flight; asked once */
        var session = playing, d = playing.detail;
        API.videoshot(d.bvid, playing.cid, function (s) {
            if (playing !== session) { return; }
            playing.shots = s;
            if (scrub) { paintScrub(); }
        }, function () {});
    }

    /* Which frame of which sheet covers `ms`, as a background-position.
     *
     * `index` names every frame's second when bilibili sends it. On long
     * uploads it does not, and then the frames are evenly spaced — the count
     * has to be assumed full, so the last sheet of a video whose final page is
     * only part filled can show a blank tile at the very end. */
    function paintShot(ms) {
        var thumb = el("scrub-thumb");
        var s = playing && playing.shots;
        if (!thumb) { return; }
        if (!s || !s.sheets.length) { thumb.style.backgroundImage = "none"; return; }

        var per = s.cols * s.rows;
        var i;
        if (s.index.length) {
            var t = ms / 1000;
            i = 0;
            while (i + 1 < s.index.length && s.index[i + 1] <= t) { i++; }
        } else {
            var dur = Player.durationMs() || 1;
            i = Math.round((ms / dur) * (s.sheets.length * per - 1));
        }
        i = Math.max(0, Math.min(s.sheets.length * per - 1, i));

        var sheet = Math.floor(i / per), within = i % per;
        var col = within % s.cols, row = Math.floor(within / s.cols);
        var W = 384, H = 216;
        thumb.style.backgroundImage = "url(" + s.sheets[sheet] + ")";
        thumb.style.backgroundSize = (s.cols * W) + "px " + (s.rows * H) + "px";
        thumb.style.backgroundPosition = (-col * W) + "px " + (-row * H) + "px";
    }

    function enterScrub() {
        if (scrub) { return; }
        if (!Player.durationMs()) { return; }
        scrub = { target: lastKnownPosition, presses: 0, timer: null };
        el("playerui").className = "scrubbing";
        el("player-scrub").className = "";
        el("scrub-preview").className = "";
        loadShots();
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

        /* Clamped in pixels rather than percent: at either end of a long video
         * a centred preview would hang off the panel, and half a thumbnail is
         * worse than none. */
        var track = el("player-track");
        var box = el("scrub-preview");
        var w = (track && track.clientWidth) || 1;
        var half = 192;
        box.style.left = Math.max(half, Math.min(w - half, (pct / 100) * w)) + "px";
        el("scrub-chapter").textContent = chapterAt(scrub.target);
        paintShot(scrub.target);
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
        el("scrub-preview").className = "hidden";
        showChrome();
    }

    var lastKnownPosition = 0;
    var lastKnownDuration = 0;

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

    /* Where a video should start when the position did not come from this
     * television. Set just before play() by whoever knows better — today that
     * is a card from bilibili's own history, so a video left half-watched on
     * the phone carries on here rather than starting again. Consumed once. */
    var handoff = null;

    function play(detail, cid) {
        /* Every per-video piece of player state is cleared here. Leaving any of
         * it behind is invisible until the exact moment it matters: the scrub
         * head seeded from the last video would jump a fresh one straight to its
         * own ending. */
        closeOptions();
        cancelScrub();
        playing = { detail: detail, cid: cid };

        var startMs = Resume.positionMs(detail.bvid, cid);
        var fromPhone = false;
        /* 30 seconds is where `Resume` starts keeping a position, and a handoff
         * has to answer to the same rule: a video someone glanced at for ten
         * seconds on their phone should open at the beginning here, not ten
         * seconds in with a notice about it. */
        if (handoff && handoff.bvid === detail.bvid && handoff.cid === cid &&
                handoff.positionMs >= 30000 && handoff.positionMs > startMs) {
            /* Take the further of the two. Watching on the phone after watching
             * here should win, and the reverse should not be undone by a stale
             * server entry. */
            startMs = handoff.positionMs;
            fromPhone = true;
        }
        handoff = null;

        lastKnownPosition = startMs;
        lastKnownDuration = 0;      /* the previous video's length is not this one's */
        playing.startMs = startMs;
        playing.fromPhone = fromPhone;
        /* The toast waits for `decide()`. bilibili's own record for this video
         * is still in flight at this point and may put the start somewhere
         * else, and announcing a position that is about to change is worse than
         * announcing it a third of a second later. */
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
        Player.startTiming();
        /* Named, so that "one video would not play" can be chased to a bvid
         * instead of guessing which of the evening's videos it was. */
        report("player", detail.bvid + " " + String(detail.title || "").slice(0, 24) +
               " — requesting qn=" + PREFERRED_QN);

        /* Both forms at once. Asking DASH first and progressive from inside its
         * callback put two full round trips to bilibili back to back before a
         * single byte of media was requested — and the answer to one has never
         * had any bearing on how to ask the other. `undefined` means still in
         * flight, `null` means it failed; the decision waits for both. */
        var got = { dash: undefined, prog: undefined, resume: undefined };

        function decide() {
            if (playing !== session) { return; }
            if (got.dash === undefined || got.prog === undefined ||
                    got.resume === undefined) { return; }

            /* bilibili's own record for this video, which knows about every
             * device including this one. It only moves the position within the
             * part already chosen: naming a different part is a decision that
             * belongs upstream, in `resumeCid`, and switching here would mean
             * throwing away the two stream requests already in flight.
             *
             * Same floor as everywhere else — under 30 seconds there is nothing
             * worth resuming, and starting ten seconds in reads as a glitch. */
            var r = got.resume;
            if (r) { playing.chapters = r.chapters || []; }
            if (r && r.cid === cid && r.positionMs >= 30000 &&
                    r.positionMs > playing.startMs) {
                playing.startMs = r.positionMs;
                lastKnownPosition = r.positionMs;
                playing.fromPhone = false;
                playing.fromAccount = true;
            }
            if (playing.startMs) {
                toast((playing.fromPhone ? "接着手机上的进度，从 "
                        : (playing.fromAccount ? "接着上次的进度，从 " : "从 ")) +
                      fmt(playing.startMs) + " 继续播放");
            }

            var dash = got.dash, prog = got.prog;
            var dashQn = 0;
            if (dash) {
                var best = Player.pickDashVideo(dash);
                dashQn = (best && best.id) || 0;
            }
            Player.mark("playurl");

            if (dash && (!prog || dashQn > prog.quality)) { playDash(dash, dashQn); return; }
            if (prog) { startProgressive(prog); return; }
            toast("播放失败：拿不到播放地址");
            stopPlayback();
        }

        API.playurlDash(detail.bvid, cid, PREFERRED_QN, function (dash) {
            if (playing !== session) { return; }
            var best = Player.pickDashVideo(dash);
            report("player", "dash offers qn=" + ((best && best.id) || 0) +
                   " accept=" + (dash.acceptQuality || []).join(","));
            got.dash = dash;
            decide();
        }, function (dashWhy) {
            if (playing !== session) { return; }
            report("player", "no dash (" + dashWhy + ")");
            got.dash = null;
            decide();
        });

        API.playurlProgressive(detail.bvid, cid, PREFERRED_QN, function (r) {
            if (playing !== session) { return; }
            report("player", "progressive gave qn=" + r.quality +
                   " accept=" + (r.accept || []).join(","));
            got.prog = r;
            decide();
        }, function (why) {
            if (playing !== session) { return; }
            report("player", "no durl (" + why + ")");
            got.prog = null;
            decide();
        });

        /* Third of the three, and the only one playback can start without —
         * hence the timer. A resume point is worth a third of a second of
         * waiting and not a second more; a slow or hung answer must not hold a
         * picture that both stream requests are already ready to paint. */
        var resumeTimer = setTimeout(function () {
            if (playing !== session || got.resume !== undefined) { return; }
            got.resume = null;
            decide();
        }, 1200);

        API.playerV2(detail.bvid, cid, function (r) {
            clearTimeout(resumeTimer);
            if (playing !== session || got.resume !== undefined) { return; }
            got.resume = r;
            decide();
        }, function () {
            clearTimeout(resumeTimer);
            if (playing !== session || got.resume !== undefined) { return; }
            got.resume = null;
            decide();
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
        /* Without this the collector says a stream was refused but not which
         * video it was, and a report of "one video would not play" cannot be
         * chased any further than guessing at candidates. */
        var who = playing && playing.detail
            ? playing.detail.bvid + " " + String(playing.detail.title || "").slice(0, 24)
            : "?";
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.setRequestHeader("Range", "bytes=0-1023");
            xhr.timeout = 10000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                /* 403 to a plain fetch is bilibili refusing the content, not a
                 * fault in how AVPlay asks — remembered so the message shown
                 * when everything has been tried can say which it was. */
                if (xhr.status === 403 && playing) { playing.refused = true; }
                report("probe", who + " | " + scheme + " " + host + " avplay=" + why +
                       " xhr=" + xhr.status);
            };
            xhr.ontimeout = function () { report("probe", who + " | " + host + " xhr=timeout"); };
            xhr.onerror = function () { report("probe", who + " | " + host + " xhr=error"); };
            xhr.send();
        } catch (e) {}
    }

    /* What this television plays, sent back to bilibili.
     *
     * The handoff was one-way for a while — the phone is where things get
     * searched for, so that is the direction that mattered — but half of it was
     * missing in a way that showed: a video finished here still sat in the
     * phone's list at the two minute mark, and the merged history put it in the
     * wrong place in time.
     *
     * bilibili's own web player heartbeats every 15 seconds; this reports every
     * 30, plus once when playback stops and once when a video ends. Half the
     * official rate on purpose — this is somebody's real account, and all a
     * faster clock buys is a history that is fresh to fifteen seconds instead
     * of thirty. */
    var lastReport = { key: "", secs: -2, at: 0 };
    var csrfNoted = false;
    var routeNoted = false;

    function reportProgress(secs, force, durSecs) {
        if (!playing || !Auth.isLoggedIn()) { return; }
        if (!Auth.csrf() && !Auth.accessKey()) {
            /* Accounts restored through the web fallback have neither an access
             * token nor a readable CSRF token, so they cannot write. Said once,
             * because otherwise it is invisible: the television would simply
             * never appear in the phone's history and nothing would explain
             * why. */
            if (!csrfNoted) {
                csrfNoted = true;
                report("history", "这个账号既没有 access_key 也没有 csrf（网页扫码进来的），电视上的进度不会同步回 bilibili");
            }
            return;
        }
        /* Opened and abandoned is not watching. -1 means finished and always
         * goes. */
        if (secs >= 0 && secs < 5) { return; }

        /* The last half minute counts as watched to the end — the same line
         * `Resume` draws. Without this the two disagree about the same video:
         * this set would call it finished and start it over, while the phone
         * would have it sitting twenty seconds from the credits, and whichever
         * one the merge trusted would be wrong somewhere. */
        if (secs > 0 && durSecs && secs > durSecs - 30) { secs = -1; }

        var d = playing.detail;
        /* Cards from the feeds carry an aid; the ones that do not are playing
         * from a provisional detail while view() is still in flight. Returning
         * without stamping `lastReport` is the point — otherwise the throttle
         * would start counting from a report that never went out. */
        if (!d.aid) { return; }

        var key = d.bvid + ":" + playing.cid;
        var now = new Date().getTime();
        if (key === lastReport.key) {
            if (secs === lastReport.secs) { return; }            /* paused */
            if (!force && now - lastReport.at < 30000) { return; }
        }
        lastReport = { key: key, secs: secs, at: now };
        API.report(d.aid, playing.cid, secs, function (j, note) {
            /* Once per run of the app: which credential bilibili accepted from
             * this device. Every heartbeat after that is silent — the answer
             * does not change, and a log line per 30 seconds of television
             * would bury everything else. */
            if (!routeNoted) {
                routeNoted = true;
                report("history", "上报成功，" + note);
            }
        }, function (why) {
            report("history", "上报失败 " + d.bvid + " " + secs + "s：" + why);
        });
    }

    function stopPlayback() {
        el("player-loading").className = "hidden";
        var was = playing;
        /* Before `playing` is cleared: this is the position the viewer actually
         * stopped at, and the one the phone should show.
         *
         * Only if something was actually watched, though. `lastKnownPosition`
         * starts life at the resume point, so a video that was opened and never
         * played — the 403s do this — would otherwise be reported at the
         * position it never reached, and would jump to the top of the phone's
         * history as if it had just been watched. */
        if (playing && lastKnownPosition !== playing.startMs) {
            reportProgress(Math.floor(lastKnownPosition / 1000), true,
                           Math.floor(lastKnownDuration / 1000));
        }
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
                /* Which part this is, so 我的 can say P7 and reopening the
                 * video can land back on it. */
                var pg = 0, ptitle = "";
                var pages0 = (d0.pages || []);
                for (var pi = 0; pi < pages0.length; pi++) {
                    if (pages0[pi].cid === playing.cid) {
                        pg = pages0[pi].page;
                        ptitle = pages0[pi].part || "";
                        break;
                    }
                }
                Resume.record(d0.bvid, playing.cid, data.position, data.duration, {
                    bvid: d0.bvid, aid: d0.aid, title: d0.title, pic: d0.pic,
                    author: d0.author, duration: d0.duration, play: d0.play,
                    cid: playing.cid, page: pg, part: ptitle
                });
            }
            lastKnownPosition = data.position;
            lastKnownDuration = data.duration || lastKnownDuration;
            reportProgress(Math.floor(data.position / 1000), false,
                           Math.floor(lastKnownDuration / 1000));
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
        } else if (kind === "quality") {
            /* Adaptation is routine now that the player picks the tier itself,
             * and it moves *up* as often as down. The badge follows it; there is
             * no toast, because the one that used to be here was inherited from
             * a hand-rolled step-down and announced "原画质取不到" every time the
             * picture got better. */
            setQualityBadge(QUALITY_NAMES[data.id] || ("QN " + data.id));
        } else if (kind === "playing") {
            el("player-loading").className = "hidden";
            /* Where the seconds before a picture actually went. Without this,
             * "it takes a few seconds" has at least five candidate causes and
             * no way to tell them apart from the sofa. */
            /* Once per video. The element fires `playing` again after every
             * seek and every resume, and `mark()` only records the first of
             * each — so the line was being printed four or five times per video
             * with the same numbers, which reads like four starts. */
            if (playing && !playing.timed) {
                playing.timed = true;
                report("player", "到画面 " + Player.timings());
            }
            loadMetaForPlaying();
            /* The duration is only real once there is a picture, and the marks
             * are placed as a fraction of it. */
            paintChapters();
        } else if (kind === "buffering") {
            el("player-hint").textContent = data ? "缓冲中…" : HINT;
        } else if (kind === "ended") {
            if (playing) {
                Resume.finished(playing.detail.bvid, playing.cid);
                reportProgress(-1, true);   /* -1 is bilibili's "watched to the end" */
            }
            beginAutoNext();
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
            /* Downgrading restarts the video from the top in the other form.
             * That is right when nothing ever played, and wrong once the viewer
             * is watching — a dropped connection at four minutes in used to
             * throw them back to the beginning. */
            if (lastKnownPosition > 3000) {
                report("player", "播放中出错但已在播，保持不动：" + data);
                return;
            }
            if (playing.canDowngrade && !playing.downgraded) { downgrade(String(data)); return; }
            /* Every route has been tried. If the probes came back 403 the
             * content itself is being withheld — reuploads of films get their
             * streams pulled while the page stays up — and "播放错误：
             * PLAYER_ERROR_CONNECTION_FAILED" sends the viewer looking for a
             * network problem that is not there. */
            var refused = playing.refused || String(data).indexOf("403") >= 0;
            toast(refused
                ? "bilibili 拒绝提供这个视频的画面流（403），换一个试试"
                : "播放错误：" + data);
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
        Auth.cancelLogin();
        /* Backing out of "add an account" belongs on the switcher, not on the
         * home feed — the viewer was one press into a two-press errand. */
        if (state.screen === "login" && Accounts.count()) { renderAccounts(false); return; }
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
                    Auth.cancelLogin();
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

        el("account").onselect = function () {
            Auth.cancelLogin();
            if (Accounts.count()) { renderAccounts(false); }
            else { renderLogin(null); }
        };
        paintAccount();
        refreshActiveProfile();

        /* What this engine actually is. The conventions here assume it is old
         * enough to need ES5, which decides whether a maintained DASH player
         * can be dropped in at all — and that assumption has never been
         * checked against the set. */
        try {
            var es6 = false, blobUrl = false;
            try { es6 = !!new Function("var a=(x)=>x*2;let b=`t`;class C{};return a(1)===2")(); }
            catch (e) { es6 = false; }
            try { blobUrl = !!(window.Blob && URL.createObjectURL(new Blob(["x"]))); }
            catch (e) { blobUrl = false; }
            /* Which codecs this panel will actually accept through MSE.
             *
             * bilibili offers every tier in H.265 and AV1 as well as H.264, and
             * `mpd.js` keeps only the H.264 ones. H.265 carries the same picture
             * in roughly two thirds of the bytes, which is the difference
             * between riding out a slow minute and stalling — so whether that
             * filter is costing anything is worth knowing rather than assuming.
             * Asked here because the answer belongs to the set, not to a
             * guess about what a 2024 Samsung ought to support. */
            var can = function (c) {
                try { return MediaSource.isTypeSupported('video/mp4; codecs="' + c + '"'); }
                catch (e) { return false; }
            };
            report("engine", navigator.userAgent +
                   " | ES6=" + es6 +
                   " | MSE=" + (typeof MediaSource !== "undefined") +
                   " | Blob URL=" + blobUrl +
                   " | Promise=" + (typeof Promise !== "undefined") +
                   " | fetch=" + (typeof fetch !== "undefined") +
                   " | avc1=" + can("avc1.640028") +
                   " | hev1=" + can("hev1.1.6.L120.90") +
                   " | hvc1=" + can("hvc1.1.6.L120.90") +
                   " | av01=" + can("av01.0.08M.08"));
        } catch (e) { report("engine", "probe failed: " + e.message); }

        /* A set with more than one person on it asks before showing anyone's
         * recommendations — the same thing a television does when it is shared.
         * With one account there is nothing to ask, and the selftest needs the
         * grid to be what boots. */
        var shared = Accounts.count() > 1;
        var selftest = (typeof SELFTEST !== "undefined" && SELFTEST &&
                        typeof SelfTest !== "undefined");
        if (shared && !selftest) { renderAccounts(true); }
        else { loadFeed("rcmd"); }

        /* Constructing Shaka measured about seven hundred milliseconds, and it
         * is built once and kept — so the only thing in question is when. Doing
         * it here spends it while the viewer is looking at the grid instead of
         * at the black screen before their first video. Late enough that the
         * feed has painted first: a busy main thread during that paint is worse
         * than a slow first play. */
        setTimeout(function () {
            try { Player.prewarm(); } catch (e) {}
        }, 1200);

        if (selftest) { SelfTest.run(); }
    };
})();
