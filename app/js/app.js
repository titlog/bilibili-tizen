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
    var actionView = null;
    var interactionCache = {};

    function el(id) { return document.getElementById(id); }

    /* There is no console on a retail set and dlog is closed, so anything that
     * throws is posted to tools/collect.mjs instead. Silent when unset. */
    /* The collector lives on whichever machine last ran deploy.sh, so in the
     * living room it is usually not there at all. An unanswered POST holds its
     * socket until the stack gives up, and this fires every thirty seconds
     * while a video plays — so it gets a short timeout and gives up entirely
     * after a few refusals. A television in normal use should not spend its
     * evening dialling a laptop that went to the office. */
    /* Five misses stop the dialling, but they must not stop it *forever*. The
     * permanent form cost a diagnosis on 2026-08-12: the collector had been up
     * all day, the television suspended and woke with its network a few seconds
     * behind, five reports missed into that gap, and the channel was dead for
     * the rest of the process — a playback failure at 19:00 left no trace at
     * all while `curl` to the collector answered 200. Reinstalling was the only
     * cure and CLAUDE.md had to warn readers about it.
     *
     * So: sleep, don't die. After the fifth miss nothing is sent for five
     * minutes, then exactly one line is allowed through as a probe — it either
     * lands (misses reset, the channel is back) or re-arms the sleep for
     * another five minutes. The cost of an evening with no laptop is one
     * three-second XHR per five minutes, and only while something is happening:
     * report() is called by events, so an idle television sends nothing. */
    var reportMisses = 0, reportWakeAt = 0;
    var REPORT_SLEEP = 300000;

    /* A runaway rebuild loop once wrote three lines a second for minutes —
     * hundreds of collector rows, and as many POSTs riding the same network
     * the player was already dying on, each one more fuel for the CDN's burst
     * limiter. The bucket makes any future loop self-muffling: a burst of 20
     * passes untouched (an incident's whole ladder fits), then one line a
     * second, and whatever was dropped is admitted to on the next line out. */
    var reportTokens = 20, reportRefillAt = 0, reportDropped = 0;

    var reportEverOk = false;   /* a collector has answered at least once this run */

    function report(kind, detail) {
        /* Every line also goes to the diagnostics ring (diag.js), scrubbed
         * there; what Diag.priv() wrapped reaches the collector unmarked. */
        Diag.record(kind, detail);
        detail = Diag.plain(detail);
        if (!REPORT_TO) { return; }
        var now = new Date().getTime();
        if (reportMisses >= 5) {
            if (!reportWakeAt) { reportWakeAt = now + REPORT_SLEEP; return; }
            if (now < reportWakeAt) { return; }
            /* One probe per window: back to four, so a single failure trips the
             * fifth miss again and the next call opens a fresh window rather
             * than spending five more sockets to relearn the same answer. */
            reportWakeAt = 0;
            reportMisses = 4;
        }
        if (reportRefillAt) {
            reportTokens = Math.min(20, reportTokens + (now - reportRefillAt) / 1000);
        }
        reportRefillAt = now;
        if (reportTokens < 1) { reportDropped++; return; }
        reportTokens -= 1;
        if (reportDropped) {
            detail = "（限速丢弃了 " + reportDropped + " 行）" + detail;
            reportDropped = 0;
        }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", REPORT_TO, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.timeout = 3000;
            xhr.onload = function () { reportMisses = 0; reportEverOk = true; };
            xhr.onerror = xhr.ontimeout = function () { reportMisses++; };
            xhr.send(JSON.stringify({ event: "log", detail: { msg: kind + ": " + detail } }));
        } catch (e) {}
    }

    /* Counted for self-update's boot check (end of window.onload): a launch
     * that threw on the way up does not get to call its code good. */
    var jsErrors = 0;
    window.onerror = function (msg, src, line) {
        jsErrors++;
        /* Boot.scriptName: an update's scripts run from blob: urls, and a uuid
         * names no file. */
        var file = typeof Boot !== "undefined" ? Boot.scriptName(src) : String(src).split("/").pop();
        report("js error", msg + " @" + file + ":" + line);
        Diag.incident("js 错误：" + msg + " @" + file + ":" + line);
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

    /* A toast that tells the viewer something failed. Toasts also confirm
     * things (已点赞, 登录成功) and guide (先输入关键词), so the failures are
     * named here rather than inferred from toast(): each one sends the recent
     * log to the developer (diag.js), with these words as the reason. */
    function trouble(text) {
        toast(text);
        Diag.incident(text);
    }

    /* Refusals that logging in answers, said as that to a viewer on no account
     * (10-25: 「需要登录才能用的，就提示用户先登录，不要默默报错」). -101 is
     * bilibili's 「账号未登录」; -352 is the risk check that catches requests
     * carrying no account — 排行 and the zone tabs on four sets with none,
     * 10-22 to 10-24, never on a signed-in one. Empty when signed in, and for
     * any other answer, which logging in would not change. */
    function loginNeeded(why) {
        if (Auth.isLoggedIn() || !/code -(?:101|352)\b/.test(String(why))) { return ""; }
        return "没登录时 B 站不给，先去「我的」扫码登录再试";
    }

    /* Errors used to be terminal: the only escape from "加载失败" was to switch
     * tab and come back. */
    function showError(message, retry) {
        Diag.incident(message);
        setScreen('<div class="empty">' + esc(message) +
            '<div class="actions" style="justify-content:center;margin-top:32px">' +
            '<div class="btn focusable" id="btn-retry">重试</div></div></div>');
        var b = el("btn-retry");
        if (b) { b.onselect = retry; }
        Nav.reset("#btn-retry");
    }

    function bindTab(tab) {
        tab.onselect = function () {
            var s = tab.getAttribute("data-screen");
            Auth.cancelLogin();
            if (s === "search") { renderSearch(); }
            else if (s === "mine") {
                mineView = { kind: "history", id: 0, title: "" };
                renderMine();
            }
            else if (s === "settings") { renderSettings(); }
            /* Pressing the tab you are already on reloads it; coming
             * back to a tab restores where you were, which is what a
             * television expects — refetching and jumping to the first
             * card loses your place every time you glance elsewhere. */
            else { loadFeed(s, state.screen !== s); }
        };
    }

    function markTab() {
        var tabs = document.querySelectorAll("#tabs .tab");
        var focused = Nav.current();
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute("data-screen") === state.screen;
            /* Rebuilding className used to strip "focused" from the tab the user
             * was standing on, so the ring vanished for as long as the feed took
             * to load. */
            var screenOf = tabs[i].getAttribute("data-screen");
            tabs[i].className = "tab focusable" + (TAB_NAMES[screenOf] ? " user-tab" : "") +
                                (on ? " active" : "") +
                                (tabs[i] === focused ? " focused" : "");
            /* The bar scrolls sideways now: with the focus down in the grid,
             * the highlighted tab still has to be in sight. */
            if (on && !(focused && focused.parentNode === tabs[i].parentNode)) { Nav.reveal(tabs[i]); }
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
        /* Which route is carrying the session. It used to name the Cookie header
         * first, which is exactly how the header went four days without anyone
         * noticing it arrives nowhere: this line said 「route=Cookie 头，服务器
         * 认得 X」 while the jar did the work. It now names what actually
         * travels, and `whoami` keeps measuring rather than asserting. */
        var route = Auth.accessKey() ? "access_key"
                  : (Auth.jarIsOurs() ? "cookie jar" : "无凭证");
        API.nav(function (me) {
            report("account", Accounts.count() + " 个账号，当前 route=" + route +
                   "，服务器" + (me.isLogin ? ("认得 " + Diag.priv(me.uname)) : "不认这个会话"));
            if (!me.isLogin) { return; }
            if (!Accounts.describe(acc.id, me)) {
                report("account", "服务器答的是 mid=" + me.mid + " " + Diag.priv(me.uname) +
                       "，而活动账号 " + acc.id + " 是 mid=" + acc.mid +
                       " —— 这次请求没带上这个账号的会话，身份不采信");
                return;
            }
            paintAccount();
        }, function (why) { report("account", "route=" + route + "，nav 失败 " + why); });
    }

    /* Which account the server answers as, and by what route it learned.
     *
     * The whole account layer rests on one measured fact — that this firmware
     * lets a widget set a Cookie header — and that measurement was taken with
     * one account on the set, where the header and the engine's own jar cannot
     * disagree. It therefore never separated "our header is read" from "the
     * engine had a session anyway"; `account:` says 服务器认得 X in both cases.
     * With two people on the television they stop agreeing, and one of them
     * serves the wrong person's name.
     *
     * The bare request is the discriminator. No Cookie header, no jar, cache
     * busted: if the server still knows who we are, the session is not ours to
     * choose and no amount of switching will move it. */
    function whoami(where) {
        var acc = Accounts.active();
        var head = Auth.cookieHeader();
        report("whoami", where + " 活动=" + (acc ? acc.id : "访客") +
               " access_key=" + (Auth.accessKey() ? "有" : "无") +
               " header=" + (head ? ("有 " + fingerprint(head)) : "无") +
               " jar主=" + (Accounts.jarOwner() || "无") +
               " withCred=" + (Auth.jarIsOurs() ? "是" : "否") +
               " | " + storedAccounts());

        var steps = [
            ["常规", null],
            ["只有 Cookie 头·不带 access_key", { noKey: true, bust: true }],
            ["裸请求·什么都不带", { bare: true, bust: true }]
        ];
        /* One at a time so the lines read in order, and so a cached response
         * cannot be handed from one variant to the next. */
        (function next(i) {
            if (i >= steps.length) { return; }
            API.nav(function (me) {
                report("whoami", where + " " + steps[i][0] + " → isLogin=" + me.isLogin +
                       " mid=" + me.mid + " uname=" + Diag.priv(me.uname || "-") +
                       /* Only on the arm that carries the session — the other
                        * two are anonymous by construction and would print an
                        * absence that means nothing. */
                       (steps[i][1] ? "" :
                        " 会员=" + (me.vipLabel || (me.vipStatus ? "有(无名称)" : "无")) +
                        "(status=" + me.vipStatus + " type=" + me.vipType + ")"));
                next(i + 1);
            }, function (why) {
                report("whoami", where + " " + steps[i][0] + " → 失败 " + why);
                next(i + 1);
            }, steps[i][1]);
        })(0);
    }

    /* A stable, non-reversible stand-in for a credential. SESSDATA is the thing
     * a session *is* — logging it would put an account in the collector and in
     * whatever terminal scrollback outlives it — but two accounts holding the
     * same one is exactly what needs to be visible. */
    function fingerprint(s) {
        try { return MD5(String(s)).slice(0, 8); } catch (e) { return "?"; }
    }

    function storedAccounts() {
        var list = Accounts.all(), out = [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i], s = a.session || {};
            out.push(a.id + " mid=" + (a.mid || 0) + " " + Diag.priv(a.uname || "-") +
                     " 凭证=" + (s.SESSDATA ? fingerprint(s.SESSDATA)
                                            : (s.viaCookieJar ? "在 jar 里" : "无")));
        }
        return out.length ? out.join("；") : "没有账号";
    }

    /* The one path an account change takes. Everything personal has to be let
     * go of here: the feed cache holds the previous account's recommendations,
     * and serving those under a new name is both wrong and invisible. */
    function switchTo(id) {
        if (playing) { stopPlayback(); }
        upReturn = null;
        Auth.cancelLogin();
        Resume.flush();          /* into the outgoing account's namespace */
        Accounts.switchTo(id);
        feedCache = {};
        mineLibraryCache = {};
        mineView = { kind: "history", id: 0, title: "" };
        /* Another account, another history. */
        serverHistory = { at: 0, items: null };
        state.query = "";
        state.results = null;
        paintAccount();

        var acc = Accounts.active();
        if (acc && Accounts.needsRelogin(acc)) {
            trouble("这个账号的登录凭证已经不在了，需要重新扫码");
            renderLogin(acc.id);
            return;
        }
        refreshActiveProfile();
        loadFeed("rcmd");
    }

    /* ---------------- grid of videos ---------------- */

    /* Cards per row, a setting because the right answer is the room: how big
     * the panel is and how far the sofa is from it. Three is the default and
     * what this set settled on (2026-09-16, see app.css); four and five are
     * PR #2's, for a closer seat or a smaller screen. Every width fills the
     * same 1792px: 3×576+2×32, 4×430+3×24, 5×344+4×18. */
    var GRID_WIDTHS = { 3: 576, 4: 430, 5: 344 };

    function gridColumns() {
        var n = Settings.get("gridColumns", 3);
        return GRID_WIDTHS[n] ? n : 3;
    }

    function applyGridDensity() {
        document.body.className = document.body.className.replace(/\s*density-[45]/g, "");
        if (gridColumns() !== 3) { document.body.className += " density-" + gridColumns(); }
        /* Covers at the card's own width — five across do not need 576px
         * images, and three across should not be stretching 344px ones. */
        API.setCardWidth(GRID_WIDTHS[gridColumns()]);
    }

    function publishedDate(seconds) {
        var n = Number(seconds) || 0;
        if (n > 100000000000) { n = Math.floor(n / 1000); }
        if (n < 1230768000 || n > new Date().getTime() / 1000 + 31536000) { return ""; }
        /* Match bilibili's publication day (UTC+8, the site's own clock),
         * rather than the TV's local day; an evening west of UTC is often
         * already tomorrow there. */
        var d = new Date((n + 8 * 3600) * 1000);
        function two(v) { return v < 10 ? "0" + v : String(v); }
        return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate());
    }

    function cardHtml(v, i) {
        /* 直播: a red badge where the length goes, who and what, how many. */
        if (v.live) {
            return '<div class="card focusable" data-i="' + i + '">' +
                   '<div class="thumb"><img src="' + esc(v.pic) + '" alt="">' +
                   '<span class="dur live-badge">直播</span></div>' +
                   '<div class="card-title">' + esc(v.title) + '</div>' +
                   '<div class="card-info"><div class="card-byline">' +
                   (v.followed ? '<span class="card-follow">关注</span>' : "") +
                   '<span class="card-author">' + esc(v.author) + '</span>' +
                   (v.area ? '<span class="card-views" data-short="">· ' + esc(v.area) + '</span>' : "") +
                   '</div>' +
                   (v.online ? '<span class="card-info-date" data-compact="' + esc(v.online) + '">' +
                       esc(v.online) + '</span>' : "") +
                   '</div></div>';
        }
        /* Server-side history carries its own progress; everything else asks
         * the local record. */
        var seen = (typeof v.seen === "number") ? v.seen : Resume.fraction(v.bvid);
        var date = publishedDate(v.publishedAt);
        var views = v.play ? String(v.play) : "";
        return '<div class="card focusable" data-i="' + i + '">' +
               '<div class="thumb"><img src="' + esc(v.pic) + '" alt="">' +
               '<span class="dur">' + esc(v.duration) + '</span>' +
               (seen ? '<span class="seen" style="width:' + Math.round(seen * 100) + '%"></span>' : "") +
               '</div>' +
               '<div class="card-title">' + esc(v.title) + '</div>' +
               '<div class="card-info"><div class="card-byline">' +
               /* Which part you were on, on the history cards — "看到一半" is
                * not much use on a 24-part upload without it. */
               (v.page ? '<span class="card-part">P' + esc(v.page) + '</span>' : "") +
               '<span class="card-author">' + esc(v.author) + '</span>' +
               (views ? '<span class="card-views" data-short="· ' + esc(views) + '">· ' +
                   esc(views) + '次</span>' : "") + '</div>' +
               (date ? '<span class="card-info-date" data-compact="' + esc(date.replace(/-/g, "")) +
                   '">' + esc(date) + '</span>' : "") +
               '</div>' +
               '</div>';
    }

    function bindCardAction(card, video, folderId) {
        /* Like / coin / favourite are for videos; a live room has none of them. */
        if (video && video.live) { return; }
        card.onlongselect = function () { openActionMenu(video, folderId || 0); };
    }

    function actionCurrent(view) {
        return actionView === view && activeAccountId() === view.accountId;
    }

    function rememberActionState(view) {
        interactionCache[view.accountId + ":" + view.video.bvid] = {
            liked: view.liked, coins: view.coins,
            favoured: !!(view.folders && view.folders.some(function (f) { return f.selected; }))
        };
        /* The panel's own copy of this video goes stale; it re-reads on next paint. */
        if (pa && pa.key === view.accountId + ":" + view.video.bvid) {
            pa = null;
            if (optionsOpen) { paintPanelActions(); loadPanelActions(); }
        }
    }

    function invalidateFavoriteLibrary() {
        for (var key in mineLibraryCache) {
            if (mineLibraryCache.hasOwnProperty(key) &&
                    (/:(folders|videos):/).test(key)) { delete mineLibraryCache[key]; }
        }
    }

    function closeActionMenu() {
        if (!actionView) { return; }
        if (actionView.busy) { toast("正在提交，请等待结果"); return; }
        var view = actionView, prior = view.focusBefore;
        actionView = null;
        el("video-actions").className = "hidden";
        el("video-actions-box").innerHTML = "";
        if (view.changedFolderId && !playing && state.screen === "mine" &&
                mineView.kind === "videos" && mineView.id === view.changedFolderId) {
            renderMineLibrary(false);
        } else if (prior && prior.offsetParent !== null) { Nav.focus(prior); }
        else if (playing && optionsOpen) { Nav.reset("#panel-like"); }
        else { Nav.reset("#screen .card"); }
    }

    function paintActionMenu(focusId) {
        var view = actionView;
        if (!view) { return; }
        var box = el("video-actions-box"), html =
            '<div class="action-title">' + esc(view.video.title || "视频操作") + '</div>' +
            '<div class="action-row"><div class="action-choice focusable" id="action-close">返回</div></div>';
        if (view.loading) {
            html += '<div class="action-status">正在读取点赞、投币与收藏状态…</div>';
        } else if (view.confirmCoin) {
            html += '<div class="action-status">确定为此视频投 ' + view.confirmCoin +
                ' 枚硬币？投币成功后不能撤回，也不会同时点赞。</div>' +
                '<div class="action-row"><div class="action-choice focusable" id="action-cancel">取消</div>' +
                '<div class="action-choice danger focusable" id="action-confirm">确认投币</div></div>';
        } else {
            if (view.error) { html += '<div class="action-error">' + esc(view.error) + '</div>'; }
            if (view.busy) { html += '<div class="action-status">正在提交，请稍候…</div>'; }
            var canWrite = !view.busy && API.videoActionReady();
            html += '<div class="action-label">视频互动</div><div class="action-row">';
            if (view.liked !== null) {
                html += '<div class="action-choice' + (view.liked ? ' active' : '') +
                    (canWrite ? ' focusable' : ' disabled') + '" id="action-like">' +
                    (view.liked ? '已点赞 · 取消' : '点赞') + '</div>';
            }
            if (view.coins !== null) {
                html += '<div class="action-choice disabled">已投 ' + view.coins + ' / 2 枚</div>';
            }
            html += '</div>';
            if (view.coins !== null && view.coins < 2) {
                html += '<div class="action-row">' +
                    '<div class="action-choice' + (canWrite ? ' focusable' : ' disabled') +
                    '" id="action-coin-1">投 1 枚</div>' +
                    (view.coins === 0 ? '<div class="action-choice' +
                    (canWrite ? ' focusable' : ' disabled') + '" id="action-coin-2">投 2 枚</div>' : '') +
                    '</div>';
            }
            html += '<div class="action-label">收藏夹</div>';
            if (view.folders && view.folders.length) {
                for (var i = 0; i < view.folders.length; i++) {
                    var folder = view.folders[i];
                    html += '<div class="action-row"><div class="action-choice' +
                        (folder.selected ? ' active' : '') +
                        (canWrite ? ' focusable' : ' disabled') + '" id="action-folder-' + i + '">' +
                        (folder.selected ? '★ 从「' : '☆ 加入「') + esc(folder.title) +
                        (folder.selected ? '」移出' : '」') + '</div></div>';
                }
            } else if (view.folders) {
                html += '<div class="action-status">还没有收藏夹</div>';
            }
            if (view.statusFailed) {
                html += '<div class="action-row"><div class="action-choice focusable" id="action-retry">重新读取状态</div></div>';
            }
        }
        box.innerHTML = html;
        el("action-close").onselect = closeActionMenu;
        if (el("action-cancel")) {
            el("action-cancel").onselect = function () { view.confirmCoin = 0; paintActionMenu("action-coin-1"); };
            el("action-confirm").onselect = function () {
                var amount = view.confirmCoin;
                view.confirmCoin = 0;
                mutateAction(view, "coin", amount);
            };
        }
        if (el("action-like") && canWrite) {
            el("action-like").onselect = function () { mutateAction(view, "like", !view.liked); };
        }
        for (var n = 1; n <= 2; n++) {
            (function (amount) {
                var b = el("action-coin-" + amount);
                if (b && canWrite) { b.onselect = function () {
                    view.confirmCoin = amount; paintActionMenu("action-cancel");
                }; }
            })(n);
        }
        if (view.folders && canWrite) {
            for (var j = 0; j < view.folders.length; j++) {
                (function (index) {
                    var b = el("action-folder-" + index);
                    if (b) { b.onselect = function () { mutateAction(view, "favorite", index); }; }
                })(j);
            }
        }
        if (el("action-retry")) { el("action-retry").onselect = function () { loadActionState(view); }; }
        Nav.reset(focusId && el(focusId) ? "#" + focusId : "#action-close");
    }

    function mutateAction(view, kind, value) {
        if (!actionCurrent(view) || view.busy || !API.videoActionReady()) { return; }
        view.busy = true; view.error = "";
        paintActionMenu("action-close");
        function failed(why) {
            if (!actionCurrent(view)) { return; }
            view.busy = false;
            view.error = "操作没有成功：" + why;
            report("action", kind + " 失败 " + why);
            paintActionMenu("action-close");
        }
        function succeeded() {
            if (!actionCurrent(view)) { return; }
            view.busy = false;
            if (kind === "like") { view.liked = value; toast(value ? "已点赞" : "已取消点赞"); }
            if (kind === "coin") { view.coins += value; toast("已投 " + value + " 枚硬币"); }
            if (kind === "favorite") {
                var folder = view.folders[value];
                folder.selected = !folder.selected;
                view.changedFolderId = folder.id;
                invalidateFavoriteLibrary();
                toast(folder.selected ? "已加入「" + folder.title + "」" : "已从「" + folder.title + "」移出");
            }
            rememberActionState(view);
            paintActionMenu(kind === "like" ? "action-like" :
                            kind === "favorite" ? "action-folder-" + value : "action-close");
        }
        if (kind === "like") { API.videoLike(view.aid, value, succeeded, failed); }
        else if (kind === "coin") { API.videoCoin(view.aid, value, succeeded, failed); }
        else if (kind === "favorite") {
            API.videoFavorite(view.aid, view.folders[value].id,
                              !view.folders[value].selected, succeeded, failed);
        }
    }

    function loadActionState(view) {
        if (!actionCurrent(view)) { return; }
        view.loading = true; view.statusFailed = false; view.error = "";
        view.liked = null; view.coins = null; view.folders = null;
        paintActionMenu("action-close");
        var left = 3;
        function done() {
            if (!actionCurrent(view)) { return; }
            left--;
            if (left) { return; }
            view.loading = false;
            if (view.statusFailed) { view.error = "部分状态读取失败；未确认的操作暂不可用。"; }
            rememberActionState(view);
            paintActionMenu(view.liked !== null ? "action-like" : "action-close");
        }
        API.videoLikeState(view.aid, function (liked) { view.liked = liked; done(); },
            function (why) { view.statusFailed = true; report("action", "点赞状态 " + why); done(); });
        API.videoCoinState(view.aid, function (coins) { view.coins = coins; done(); },
            function (why) { view.statusFailed = true; report("action", "投币状态 " + why); done(); });
        API.favoriteFolders(Accounts.active().mid, function (folders) {
            view.folders = folders;
            if (view.sourceFolderId) {
                for (var i = 0; i < folders.length; i++) {
                    if (folders[i].id === view.sourceFolderId) { folders[i].selected = true; }
                }
            }
            done();
        }, function (why) { view.statusFailed = true; report("action", "收藏夹状态 " + why); done(); }, view.aid);
    }

    function openActionMenu(video, sourceFolderId) {
        if (!video || !video.bvid || actionView) { return; }
        if (pendingNext) { stopCountdown(); }
        var view = actionView = {
            video: video, sourceFolderId: sourceFolderId || 0,
            accountId: activeAccountId(), focusBefore: Nav.current(),
            aid: Number(video.aid) || 0, liked: null, coins: null, folders: null,
            loading: true, busy: false, confirmCoin: 0, statusFailed: false,
            changedFolderId: 0, error: ""
        };
        el("video-actions").className = "";
        if (!Auth.isLoggedIn()) {
            view.loading = false; view.error = "请先在「我的」扫码登录，才能点赞、投币或收藏。";
            paintActionMenu("action-close"); return;
        }
        if (!API.videoActionReady()) {
            view.loading = false;
            view.error = "当前登录方式不能提交视频操作，请用电视二维码重新登录。";
            paintActionMenu("action-close"); return;
        }
        if (!Accounts.active() || !Accounts.active().mid) {
            view.loading = false; view.error = "还没有读取到账号 UID，请稍后重试。";
            paintActionMenu("action-close"); return;
        }
        paintActionMenu("action-close");
        if (view.aid) { loadActionState(view); return; }
        API.view(video.bvid, function (full) {
            if (!actionCurrent(view)) { return; }
            view.aid = Number(full.aid) || 0;
            if (!view.aid) {
                view.loading = false; view.error = "没有取得视频编号，无法提交操作。";
                paintActionMenu("action-close"); return;
            }
            video.aid = view.aid;
            loadActionState(view);
        }, function (why) {
            if (!actionCurrent(view)) { return; }
            view.loading = false; view.error = "视频资料读取失败：" + why;
            paintActionMenu("action-close");
        });
    }

    /* ---------------- 点赞 / 投币 / 收藏 in the play panel (2026-10-20) ----------------
     *
     * Three buttons, as on the web page. The viewer: 「能不能用三个按钮来表示？现在用
     * 一个弹窗、二次弹窗，不好看呀！交互也不顺畅，就和网页的三个按钮逻辑保持一致就好」.
     * 点赞 toggles. 投币 opens 投 1 枚 / 投 2 枚 in the row under the buttons, and
     * likes as well, as the web page's 「同时点赞内容」 (ticked by default) does —
     * picking the count is the one confirmation, as the web page asks once. 收藏
     * toggles the account's folder when it has one, and opens the folders in that
     * row when it has several. Lit buttons and counts say what was done; success
     * gets no toast. The long-press menu on cards is unchanged. */
    var pa = null;   /* this video's: key, aid, liked, coins, folders, loading, loaded, busy, more, d */

    function panelActState() {
        if (!playing || !playing.detail) { return null; }
        var key = activeAccountId() + ":" + playing.detail.bvid;
        if (!pa || pa.key !== key) {
            pa = { key: key, aid: 0, liked: null, coins: null, folders: null, loading: false,
                   loaded: false, busy: false, more: "", d: { like: 0, coin: 0, fav: 0 } };
        }
        return pa;
    }

    function favouredOf(s) {
        return !!(s.folders && s.folders.some(function (f) { return f.selected; }));
    }

    function coinLimit() {
        return playing && playing.detail && playing.detail.copyright === 2 ? 1 : 2;
    }

    function setLit(node, on) {
        node.className = node.className.replace(/(^|\s)on(?=\s|$)/g, "") + (on ? " on" : "");
    }

    function paintPanelActions(focusId) {
        var s = panelActState();
        if (!s) { return; }
        var st = playing.detail.stat || null;
        /* The deltas count against one stat object: view()'s fresh one already
         * holds what was done (review, 10-20). */
        if (s.statRef !== st) { s.statRef = st; s.d = { like: 0, coin: 0, fav: 0 }; }
        function num(key) { return st ? " " + API.countText(Math.max(0, st[key] + s.d[key])) : ""; }
        var like = el("panel-like"), coin = el("panel-coin"), fav = el("panel-fav");
        like.textContent = (s.liked ? "已点赞" : "点赞") + num("like");
        coin.textContent = (s.coins ? "已投币" : "投币") + num("coin");
        fav.textContent = (favouredOf(s) ? "已收藏" : "收藏") + num("fav");
        setLit(like, !!s.liked);
        setLit(coin, !!s.coins);
        setLit(fav, favouredOf(s));
        /* 弹幕 on/off ahead of them (2026-10-20). The level stays the settings
         * page's: off and back on returns to 少 / 标准 / 多, whichever it was. */
        var dmOn = danmakuLevel() !== "off", dmBtn = el("panel-dm");
        dmBtn.textContent = "弹幕 " + (dmOn ? "开" : "关");
        setLit(dmBtn, dmOn);
        dmBtn.onselect = function () {
            var cur = danmakuLevel();
            if (cur !== "off") {
                /* Kept before switching off: a level chosen before this build
                 * never went through the setter that records it. */
                Settings.set("danmakuOnLevel", cur);
                setDanmakuLevel("off");
            } else {
                var back = Settings.get("danmakuOnLevel", "normal");
                if (DM_LEVELS.indexOf(back) < 1) { back = "normal"; }
                setDanmakuLevel(back);
            }
            paintPanelActions("panel-dm");
        };
        like.onselect = pressLike;
        coin.onselect = pressCoin;
        fav.onselect = pressFav;
        /* The choice row is rebuilt below; a ring inside it would be left on a
         * detached node (review, 10-20). Same id if it is still there, else
         * the button that opened the row. */
        var ring = Nav.current(), rowBox = el("panel-act-more");
        var keepId = ring && ring.id && rowBox.contains(ring) ? ring.id : "";
        paintActMore();
        var target = focusId || keepId;
        if (target && el(target)) { Nav.focus(el(target)); }
        else if (keepId && s.opener && el(s.opener)) { Nav.focus(el(s.opener)); }
    }

    function paintActMore() {
        var box = el("panel-act-more"), s = pa, html = "";
        if (!s || !s.more || !playing || s.key !== activeAccountId() + ":" + playing.detail.bvid) {
            box.className = "act-more hidden";
            box.innerHTML = "";
            return;
        }
        if (s.more === "coin") {
            html += '<span class="act-hint">投出去不能撤回' + (s.liked === false ? "，会同时点赞" : "") + '</span>';
            var left = coinLimit() - (s.coins || 0);
            for (var n = 1; n <= Math.min(2, left); n++) {
                html += '<div class="btn ghost focusable" id="act-coin-' + n + '">投 ' + n + ' 枚</div>';
            }
        } else {
            for (var i = 0; i < s.folders.length; i++) {
                var f = s.folders[i];
                html += '<div class="btn ghost focusable' + (f.selected ? " on" : "") + '" id="act-fav-' + i + '">' +
                        (f.selected ? "★ " : "☆ ") + esc(f.title) + '</div>';
            }
        }
        box.innerHTML = html;
        box.className = "act-more";
        for (var c = 1; c <= 2; c++) {
            (function (count) {
                var b = el("act-coin-" + count);
                if (b) { b.onselect = function () { giveCoins(count); }; }
            })(c);
        }
        if (s.more === "fav") {
            for (var j = 0; j < s.folders.length; j++) {
                (function (index) {
                    el("act-fav-" + index).onselect = function () { toggleFolder(index); };
                })(j);
            }
        }
    }

    /* The ring onto the opened row's first choice. */
    function focusActMore() {
        var first = el("panel-act-more").querySelector(".focusable");
        if (first) { Nav.focus(first); }
    }

    /* Back out of an open choice row: true when there was one. */
    /* Back out of an open choice row: true when there was one. From 返回 only
     * when the ring is in that row or on the button that opened it — from down
     * in the related grid 返回 means the panel (review, 10-20). */
    function closeActMore(always) {
        if (!pa || !pa.more) { return false; }
        var back = pa.more === "coin" ? "panel-coin" : "panel-fav";
        var cur = Nav.current();
        var near = !!cur && (el("panel-act-more").contains(cur) || cur.id === back);
        if (!always && !near) { return false; }
        pa.more = "";
        paintActMore();
        if (near && el(back)) { Nav.focus(el(back)); }
        return true;
    }

    function rememberPanel(s) {
        interactionCache[s.key] = { liked: s.liked, coins: s.coins, favoured: favouredOf(s) };
    }

    /* The three states, once per video and account, when the panel first opens
     * with an aid in hand (absorbMeta asks again when view() brings one). One
     * that failed to read is asked again at the next open or press — marking
     * it read left that button dead for the rest of the video (review, 10-20). */
    function loadPanelActions() {
        var s = panelActState();
        if (!s || s.loaded || s.loading) { return; }
        if (!Auth.isLoggedIn() || !API.videoActionReady()) { return; }
        var me = Accounts.active(), aid = Number(playing.detail.aid) || 0;
        if (!me || !me.mid || !aid) { return; }
        s.loading = true;
        s.aid = aid;
        var left = 3;
        var tag = videoTag(playing.detail);
        function done() {
            if (pa !== s || --left) { return; }
            s.loading = false;
            s.loaded = s.liked !== null && s.coins !== null && s.folders !== null;
            rememberPanel(s);
            report("action", tag + " 状态：点赞=" + (s.liked === null ? "?" : s.liked ? "已赞" : "没赞") +
                   " 投币=" + (s.coins === null ? "?" : s.coins + "/" + coinLimit()) +
                   " 收藏夹 " + (s.folders ? s.folders.length + " 个、在 " +
                       s.folders.filter(function (f) { return f.selected; }).length + " 个里" : "?"));
            if (optionsOpen) { paintPanelActions(); }
        }
        function failed(what) {
            return function (why) { report("action", what + "状态 " + why); done(); };
        }
        if (s.liked === null) { API.videoLikeState(aid, function (v) { s.liked = v; done(); }, failed("点赞")); } else { done(); }
        if (s.coins === null) { API.videoCoinState(aid, function (v) { s.coins = v; done(); }, failed("投币")); } else { done(); }
        if (s.folders === null) {
            API.favoriteFolders(me.mid, function (v) { s.folders = v; done(); }, failed("收藏夹"), aid);
        } else { done(); }
    }

    /* What every press checks first; each answer is a toast, never a dialog.
     * `field` is the state that press needs. */
    function actReady(s, field, what) {
        if (!s) { return false; }
        if (!Auth.isLoggedIn()) { toast("先在「我的」扫码登录，才能点赞、投币和收藏"); return false; }
        if (!API.videoActionReady()) { toast("这个账号是网页扫码登录的，提交不了，请用电视二维码重新登录"); return false; }
        if (s.busy) { toast("正在提交，稍等"); return false; }
        if (s[field] === null) {
            loadPanelActions();
            toast(s.loading ? "正在读取" + what + "状态，稍等一下再按" : "还没拿到这个视频的编号，稍等一下再按");
            return false;
        }
        return true;
    }

    function pressLike() {
        var s = panelActState();
        if (!actReady(s, "liked", "点赞")) { return; }
        var want = !s.liked, tag = videoTag(playing.detail);
        s.busy = true;
        API.videoLike(s.aid, want, function (res) {
            if (pa !== s) { return; }
            s.busy = false;
            s.liked = want;
            /* 65006 (already liked) is a success whose count already has it. */
            if (!(res && res.already)) { s.d.like += want ? 1 : -1; }
            report("action", (want ? "点赞了 " : "取消点赞 ") + tag);
            rememberPanel(s);
            if (optionsOpen) { paintPanelActions(); }
        }, function (why) {
            if (pa !== s) { return; }
            s.busy = false;
            report("action", "like 失败 " + why);
            trouble("点赞没成功：" + why);
        });
    }

    function pressCoin() {
        var s = panelActState();
        if (!actReady(s, "coins", "投币")) { return; }
        if (coinLimit() - s.coins <= 0) { toast("这个视频已经投过 " + s.coins + " 枚了"); return; }
        if (s.more === "coin") { closeActMore(true); return; }
        s.more = "coin";
        s.opener = "panel-coin";
        paintActMore();
        focusActMore();
    }

    function giveCoins(n) {
        var s = pa;
        if (!s || !playing) { return; }
        if (s.busy) { toast("正在提交，稍等"); return; }
        var alsoLike = s.liked === false, tag = videoTag(playing.detail);
        s.busy = true;
        API.videoCoin(s.aid, n, function () {
            if (pa !== s) { return; }
            s.busy = false;
            s.coins += n;
            s.d.coin += n;
            if (alsoLike) { s.liked = true; s.d.like += 1; }
            report("action", "投了 " + n + " 枚" + (alsoLike ? "（同时点赞）" : "") + " " + tag);
            s.more = "";
            rememberPanel(s);
            if (optionsOpen) { paintPanelActions(); }
            toast("投币成功");
        }, function (why) {
            if (pa !== s) { return; }
            s.busy = false;
            report("action", "coin 失败 " + why);
            trouble("投币没成功：" + why);
        }, alsoLike);
    }

    function pressFav() {
        var s = panelActState();
        if (!actReady(s, "folders", "收藏夹")) { return; }
        if (!s.folders.length) { toast("这个账号还没有收藏夹"); return; }
        if (s.folders.length === 1) { toggleFolder(0); return; }
        if (s.more === "fav") { closeActMore(true); return; }
        s.more = "fav";
        s.opener = "panel-fav";
        paintActMore();
        focusActMore();
    }

    function toggleFolder(i) {
        var s = pa;
        if (!s || !playing || !s.folders || !s.folders[i]) { return; }
        if (s.busy) { toast("正在提交，稍等"); return; }
        var f = s.folders[i], add = !f.selected, before = favouredOf(s), tag = videoTag(playing.detail);
        s.busy = true;
        API.videoFavorite(s.aid, f.id, add, function () {
            /* The library is stale whatever happened to the panel meanwhile. */
            invalidateFavoriteLibrary();
            if (pa !== s) { return; }
            s.busy = false;
            f.selected = add;
            if (favouredOf(s) !== before) { s.d.fav += add ? 1 : -1; }
            report("action", (add ? "收藏到「" : "从「") + Diag.priv(f.title) + (add ? "」 " : "」移出 ") + tag);
            rememberPanel(s);
            if (optionsOpen) { paintPanelActions(); }
        }, function (why) {
            if (pa !== s) { return; }
            s.busy = false;
            report("action", "favorite 失败 " + why);
            trouble("收藏没成功：" + why);
        });
    }

    /* ---------------- 关注 (2026-10-20) ----------------
     *
     * The viewer: 「增加一个关注 UP 主的功能」. Beside the uploader's chip in the
     * play panel and on their page, the way the web page puts 「+ 关注」 by the
     * name: pink 「+ 关注」, grey 「已关注」, a press toggles. No confirmation for
     * unfollowing — pressing again undoes it. Read once per account and
     * uploader; not shown for yourself or when signed out. */
    var followKnown = {};   /* account:mid → true / false, once read */
    var followBusy = false;
    /* One read at a time per uploader, and a read that started before a press
     * does not overwrite what the press set (review, 10-20). */
    var followLoading = {}, followVer = {};

    function followKey(mid) { return activeAccountId() + ":" + mid; }

    function paintFollow(node, mid) {
        if (!node) { return; }
        var me = Accounts.active();
        if (!mid || !Auth.isLoggedIn() || (me && String(me.mid) === String(mid))) {
            node.className = "opt-follow hidden";
            return;
        }
        var on = followKnown[followKey(mid)] === true;
        var ring = /(^|\s)focused(\s|$)/.test(node.className);
        node.textContent = on ? "已关注" : "+ 关注";
        node.className = "opt-follow focusable" + (on ? " on" : "") + (ring ? " focused" : "");
        node.onselect = function () { pressFollow(node, mid); };
    }

    function loadFollow(node, mid) {
        paintFollow(node, mid);
        var key = followKey(mid);
        if (!node || !mid || !Auth.isLoggedIn() || followKnown[key] !== undefined || followLoading[key]) { return; }
        followLoading[key] = true;
        var ver = followVer[key] || 0;
        API.followState(mid, function (on) {
            followLoading[key] = false;
            if ((followVer[key] || 0) === ver) { followKnown[key] = on; }
            if (node.parentNode) { paintFollow(node, mid); }
        }, function (why) {
            followLoading[key] = false;
            report("action", "关注状态 " + why);
        });
    }

    function pressFollow(node, mid) {
        if (!API.videoActionReady()) { toast("这个账号是网页扫码登录的，提交不了，请用电视二维码重新登录"); return; }
        var key = followKey(mid);
        if (followKnown[key] === undefined) {
            loadFollow(node, mid);   /* asks again when the first read failed */
            toast("正在读取关注状态，稍等一下再按");
            return;
        }
        if (followBusy) { toast("正在提交，稍等"); return; }
        var want = !followKnown[key];
        followBusy = true;
        API.follow(mid, want, function () {
            followBusy = false;
            followKnown[key] = want;
            followVer[key] = (followVer[key] || 0) + 1;
            report("action", (want ? "关注了 UP 主 " : "取消关注 UP 主 ") + Diag.priv(mid));
            /* 我的 → 关注的 UP 主 is a cached list; it is wrong now. */
            for (var k in mineLibraryCache) {
                if (mineLibraryCache.hasOwnProperty(k) && /:following:/.test(k)) { delete mineLibraryCache[k]; }
            }
            if (node.parentNode) { paintFollow(node, mid); }
        }, function (why) {
            followBusy = false;
            report("action", "关注失败 " + why);
            trouble((want ? "关注" : "取消关注") + "没成功：" + why);
        });
    }

    /* Four-column cards put metadata on one row. Preserve the UP name first:
     * shave the date punctuation, then the viewing-count suffix, and only let
     * the browser ellipsize the name when even those savings are insufficient.
     * Measure the actual TV font instead of guessing Chinese glyph widths. */
    function fitCardMeta(root) {
        if (gridColumns() !== 4 || !root) { return; }
        var rows = root.querySelectorAll(".card-info");
        for (var i = 0; i < rows.length; i++) {
            var author = rows[i].querySelector(".card-author");
            var date = rows[i].querySelector(".card-info-date");
            var views = rows[i].querySelector(".card-views");
            if (!author) { continue; }
            if (date && author.scrollWidth > author.clientWidth + 1) {
                date.textContent = date.getAttribute("data-compact");
            }
            if (views && author.scrollWidth > author.clientWidth + 1) {
                views.textContent = views.getAttribute("data-short");
            }
        }
    }

    /* What is half-watched, newest first, for one full row at this density.
     *
     * Finished videos are dropped: the row exists to answer "what was I in the
     * middle of", and something watched to the end is not an answer to that. */
    function resumeRowItems() {
        var merged = mergeHistory(Resume.recent(20), serverHistory.items || []);
        /* Filtered here rather than at either source, because a taken-down
         * video reaches this row down two separate paths — this television's
         * own record and the account's server history — and removing it from
         * one leaves the card standing, delivered by the other. 我的 still
         * lists it: it was watched, and that stays true after the takedown. */
        var dead = Resume.dead();
        var out = [];
        for (var i = 0; i < merged.length && out.length < gridColumns(); i++) {
            if ((merged[i].seen || 0) >= 0.95) { continue; }
            if (dead[merged[i].bvid]) { continue; }
            out.push(merged[i]);
        }
        return out;
    }

    /* What the strip is currently showing, as one comparable string. The server
     * history arrives on its own schedule and can be later than the feed, and
     * then the strip painted with it differs from the strip painted without —
     * this is how that difference is noticed without repainting on every
     * response. Which part is in it counts: on a 24-part upload, "carry on"
     * pointing at the wrong episode is the whole of the answer being wrong. */
    var resumeRowSig = "";

    function rowSignature(items) {
        var parts = [];
        for (var i = 0; i < items.length; i++) {
            parts.push(items[i].bvid + "@" + (items[i].cid || 0) + "@" +
                       Math.round((items[i].progressMs || 0) / 1000));
        }
        return parts.join(",");
    }

    /* An empty 稍后再看 is the normal state of a list nobody has added to yet,
     * and 「没有内容」 reads as a fault. It is also the one screen where saying
     * how the list gets filled is the whole feature: the adding happens on a
     * phone, somewhere else entirely. Same text on the cache-restore path —
     * the second visit used to lose it. */
    function emptyTextFor(kind) {
        if (isUp(kind)) { return "这位 UP 主还没有投稿"; }
        if (kind === "live") { return "现在没有能看的直播"; }
        return kind === "toview"
            ? "稍后再看是空的 —— 在手机或网页上点「稍后再看」，加进去的视频就会出现在这里"
            : undefined;
    }

    /* Who the grid belongs to, above it. Not focusable: there is nothing to do
     * with it, and a ring that stops on a heading is a press wasted. The face
     * comes with view(), so a page reached from a card that never played shows
     * the name and a letter instead. */
    function upHeadHtml(kind) {
        var info = upInfo[kind] || {};
        var name = info.name || "UP 主";
        return '<div class="up-head" id="up-head">' +
               (info.face ? '<img class="up-face" src="' + esc(info.face) + '" alt="">'
                          : '<span class="up-initial">' + esc(name.charAt(0)) + '</span>') +
               '<div class="up-name">' + esc(name) + '<span class="up-sub">的投稿</span></div>' +
               '<span class="opt-follow hidden" id="up-follow"></span>' +
               '</div>';
    }

    /* 返回 from a video used to rebuild the whole grid: 190–260 ms of one
     * frame for 27 cards on this set (10-22, backTimer), plus every cover asked
     * for again. The grid is still in the document behind the player, so when
     * it is the one this tab drew, with every card the cache has, it is shown
     * as it is, and only what watching changed is redrawn: the progress bars
     * of what was played (playedSinceGrid) and 继续观看. */
    var playedSinceGrid = {};

    /* Each feed tab's grid, kept when another screen takes #screen. Rebuilt,
     * 27 cards took 50–75 ms of script and 140–230 ms to the first frame
     * (10-22) on every tab switch and every way back from UP 主页 / 我的 / 设置,
     * and every cover was asked for again. The cards themselves are kept,
     * detached, for the last three tabs; a stash belongs to the exact list
     * it was drawn from (feedCache[kind].items), so a refetch or a cache reset
     * retires it without anyone having to say so. Everything that replaces
     * #screen goes through setScreen. */
    var gridStash = {}, stashOrder = [], STASH_MAX = 3;
    function stashGrid() {
        var grid = el("feed-grid"), kind = grid && grid.__for;
        var c = kind && feedCache[kind];
        if (!c || grid.querySelectorAll(".card").length !== c.items.length) { return; }
        var frag = document.createDocumentFragment(), top = screenEl.scrollTop;
        while (screenEl.firstChild) { frag.appendChild(screenEl.firstChild); }
        gridStash[kind] = { frag: frag, items: c.items, scrollTop: top };
        for (var i = stashOrder.length - 1; i >= 0; i--) {
            var k = stashOrder[i];
            if (k === kind || !feedCache[k] || !gridStash[k] || gridStash[k].items !== feedCache[k].items) {
                if (k !== kind) { delete gridStash[k]; }
                stashOrder.splice(i, 1);
            }
        }
        stashOrder.push(kind);
        while (stashOrder.length > STASH_MAX) { delete gridStash[stashOrder.shift()]; }
    }
    function setScreen(html) {
        stashGrid();
        screenEl.innerHTML = html;
    }
    /* The kept grid for this tab back on screen, if it is still this list. */
    function unstashGrid(kind, cached) {
        var st = gridStash[kind];
        if (!st) { return false; }
        delete gridStash[kind];
        for (var i = 0; i < stashOrder.length; i++) { if (stashOrder[i] === kind) { stashOrder.splice(i, 1); break; } }
        if (st.items !== cached.items) { return false; }
        /* The first watched video makes 继续观看 appear: that needs the full draw. */
        if (kind === "rcmd" && !st.frag.querySelector("#resume-row") && resumeRowItems().length) { return false; }
        setScreen("");
        screenEl.appendChild(st.frag);
        screenEl.scrollTop = st.scrollTop;
        return true;
    }
    function gridIntact(kind, cached) {
        var grid = el("feed-grid");
        if (!grid || grid.__for !== kind) { return false; }
        if (grid.querySelectorAll(".card").length !== cached.items.length) { return false; }
        /* The first watched video makes 继续观看 appear: the grid has to move down for it. */
        if (kind === "rcmd" && !el("resume-row") && resumeRowItems().length) { return false; }
        return true;
    }
    function refreshPlayedBars() {
        var cards = screenEl.querySelectorAll("#feed-grid .card");
        for (var i = 0; i < cards.length; i++) {
            var v = cards[i].__video;
            if (!v || !playedSinceGrid[v.bvid] || typeof v.seen === "number") { continue; }
            var seen = Resume.fraction(v.bvid), thumb = cards[i].querySelector(".thumb");
            if (!thumb) { continue; }
            var bar = thumb.querySelector(".seen");
            if (!seen) { if (bar) { thumb.removeChild(bar); } continue; }
            if (!bar) {
                bar = document.createElement("span");
                bar.className = "seen";
                thumb.appendChild(bar);
            }
            bar.style.width = Math.round(seen * 100) + "%";
        }
        playedSinceGrid = {};
    }

    function renderGrid(items, emptyText) {
        var head = isUp(state.screen) ? upHeadHtml(state.screen) : "";
        if (!items.length) {
            setScreen(head + '<div class="empty">' + esc(emptyText || "没有内容") + '</div>');
            if (head) { loadFollow(el("up-follow"), state.screen.slice(3)); }
            return;
        }

        /* Only on the home tab, and only when there is something to carry on
         * with. Turning the television on and finding the half-watched thing
         * already under the cursor is what a television is supposed to do; the
         * alternative was 我的, two presses and a wait away. */
        var resume = (state.screen === "rcmd") ? resumeRowItems() : [];
        resumeRowSig = rowSignature(resume);

        var html = head;
        if (resume.length) {
            html += '<div class="section">继续观看</div><div id="resume-row"></div>' +
                    '<div class="section">推荐</div>';
        }
        html += '<div class="grid" id="feed-grid">';
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], i); }
        setScreen(html + "</div>");
        el("feed-grid").__for = state.screen;
        delete gridStash[state.screen];   /* this draw supersedes a kept one */
        playedSinceGrid = {};
        if (head) { loadFollow(el("up-follow"), state.screen.slice(3)); }
        fitCardMeta(el("feed-grid"));

        if (resume.length) { paintCards(el("resume-row"), resume); }

        /* Scoped to the feed's own grid. The resume cards carry a `data-i` too,
         * into a different array — reading them as feed indices would open the
         * wrong video. */
        var cards = screenEl.querySelectorAll("#feed-grid .card");
        for (var j = 0; j < cards.length; j++) {
            (function (card, v) {
                card.__video = v;
                card.onselect = function () { playVideo(v); };
                bindCardAction(card, v);
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
        fitCardMeta(container);

        var cards = container.querySelectorAll(".card");
        for (var j = 0; j < cards.length; j++) {
            (function (card) {
                card.__video = items[Number(card.getAttribute("data-i"))];
                card.onselect = function () {
                    playVideo(items[Number(card.getAttribute("data-i"))]);
                };
                bindCardAction(card, card.__video);
            })(cards[j]);
        }
    }

    /* A card grid that arrives a few rows at a time, growing as the focus walks
     * into it.
     *
     * Both lists of related videos — the panel over a playing video, and the
     * end-of-video chooser — used to be truncated (16 and 4), and the reason was
     * never layout. Every thumbnail is an image request, and both of these
     * screens are up at a moment when something else wants the link: the panel
     * sits over a stream that is buffering, and the chooser has a countdown
     * about to start one. This is the same constraint that made the metadata
     * fetches wait for the first frame and cut the home grid down from a hundred
     * cards — a hundred `img` tags all set off at once, on a set that is not
     * quick about any of it.
     *
     * A cap is the wrong answer to that, though: it silently decides the viewer
     * has seen enough. Pacing is the right one. The first screenful goes up
     * immediately, the rest follows the ring down — and by the time the ring is
     * moving, the viewer is choosing rather than watching, which is exactly when
     * the link is free.
     *
     * Appended, never repainted: re-rendering the grid would put every thumbnail
     * already on screen back on the wire, which is the cost this exists to
     * avoid. `pick` is what a card means when it is chosen, which is the only
     * thing the two callers disagree about. */
    function cardPager(boxId, pick) {
        var items = [], shown = 0;

        function grow(upto) {
            upto = Math.min(upto, items.length);
            if (upto <= shown) { return; }
            var box = el(boxId);
            var grid = box.querySelector(".grid");
            if (!grid) {
                box.innerHTML = '<div class="grid"></div>';
                grid = box.querySelector(".grid");
            }
            var html = "";
            for (var i = shown; i < upto; i++) { html += cardHtml(items[i], i); }
            grid.insertAdjacentHTML("beforeend", html);
            fitCardMeta(grid);
            shown = upto;
            /* Only the new cards need wiring — the ones already up kept their
             * onselect through the append. */
            var cards = grid.querySelectorAll(".card");
            for (var c = 0; c < cards.length; c++) {
                if (cards[c].onselect) { continue; }
                (function (node, v) {
                    /* Dwell-prefetched like any grid: the chooser screen's
                     * copy always, the panel's only while the video under it
                     * is steady (prefetchAllowed). */
                    node.__video = v;
                    node.onselect = function () { if (v) { pick(v); } };
                    bindCardAction(node, v);
                })(cards[c], items[Number(cards[c].getAttribute("data-i"))]);
            }
        }

        return {
            reset: function (list, first) {
                items = list || [];
                shown = 0;
                el(boxId).innerHTML = "";
                if (first) { grow(first); }
            },
            /* Dropped with the screen: twenty-odd decoded thumbnails left
             * behind a playing video is memory this set does not have spare. */
            clear: function () { items = []; shown = 0; el(boxId).innerHTML = ""; },
            total: function () { return items.length; },
            shown: function () { return shown; },
            /* Paint up to this many cards — to put the ring on a deep one. */
            grow: function (upto) { grow(upto); },
            /* The focus-nears-the-end trigger, the same shape the feeds use.
             * Nothing is fetched here — the list has been in hand since playback
             * started; what is being paced is thumbnails, not requests. */
            follow: function (focused, page) {
                if (shown >= items.length) { return; }
                if (!focused || !focused.getAttribute) { return; }
                if (focused.getAttribute("data-i") === null) { return; }
                if (!/(^|\s)card(\s|$)/.test(focused.className)) { return; }
                var box = el(boxId);
                if (!box || !box.contains(focused)) { return; }
                /* Column one of the last row must reveal the next row too. */
                if (Number(focused.getAttribute("data-i")) < shown - gridColumns()) { return; }
                grow(shown + page);
            }
        };
    }

    /* Picking from the chooser: the video belongs in `playedInChain`, or the
     * autoplay chain can queue it again later the same evening — that set exists
     * for exactly this. `fromPanel` because the browse screen is hidden here, so
     * rememberPosition would read scrollTop as 0 and write that over the
     * remembered feed position while keeping the deep card index, landing the
     * viewer at the top of the grid with the ring off screen. */
    /* 我的's history was painted whole — up to a hundred cards from innerHTML,
     * once from this set's record and again when the server's arrived — and
     * one frame of it took 590 ms here (10-22, perf: 按键). Three rows, then
     * more as the ring walks down, like the panel. */
    var histGrid = cardPager("hist", function (v) { playVideo(v); });
    function histPage() { return gridColumns() * 3; }

    var nextupGrid = cardPager("nextup-related", function (v) {
        if (v.bvid) { playedInChain[v.bvid] = 1; }
        backStack = [];   /* the video behind the chooser has ended; nothing to return to */
        playVideo(v, true);
    });
    /* Picking from the panel: same `fromPanel` reason, and the panel has to come
     * down first or the new video starts underneath it.
     *
     * And 返回 from the video picked comes back here (2026-10-20, the viewer:
     * 「从相关推荐点进去之后再按返回，应该回到这个相关推荐，而不是一下子跳回到
     * 首页」): the video being left, where it was, and which card was picked
     * go on `backStack`, and backFromPlayer() replays it from that second with
     * the panel open and the ring on that card. */
    var panelGrid = cardPager("opt-related", function (v) {
        if (playing && playing.detail) {
            backStack.push({ detail: playing.detail, cid: playing.cid,
                             at: Player.hasPosition() ? Player.position() : lastKnownPosition,
                             pick: (playing.detail.related || []).indexOf(v) });
            if (backStack.length > BACK_MAX) { backStack.shift(); }
        }
        closeOptions();
        playVideo(v, true);
    });
    var backStack = [], BACK_MAX = 10, returning = null;

    /* 返回 while a video plays: one step back along the related picks, or out
     * to the grid when there were none. */
    function backFromPlayer() {
        var prev = backStack.pop();
        if (!prev) { stopPlayback(); return; }
        returnTo(prev);
    }

    /* Replay a video that was left for a related pick or for its uploader's
     * page, from the second it was left, with the panel open on what was
     * pressed: a related card (`pick`) or the uploader chip (`focus`). */
    function returnTo(prev) {
        report("player", "返回：回到 " + videoTag(prev.detail) + " 的 " + fmt(prev.at) +
               (prev.focus ? "（从 UP 主页回来）" : "，打开相关推荐"));
        if (prev.stack) { backStack = prev.stack; }
        returning = prev;
        play(prev.detail, prev.cid);
        /* At once, not on the first frame: the list is in hand (it rides on the
         * detail), and opening it a second or two later read as the panel
         * jumping up under a video that had already started (the viewer,
         * 10-20). The video loads in the strip above it. */
        if (prev.focus) {
            openOptions();
            if (el(prev.focus)) { Nav.focus(el(prev.focus)); }
        } else {
            reopenRelated(prev.pick);
        }
    }

    /* The exits that say 「播放失败」: a video picked from the related list
     * that cannot play goes back to the one it was picked from, toast and all,
     * rather than out to the grid — the same complaint as 返回 had. */
    function failOut() {
        if (chargeOnly()) {
            report("player", "播放失败的是充电专属视频 " + videoTag(playing.detail) + "，没充电拿不到完整版");
            toast("这是 UP 主的充电专属视频，给 UP 主充电之后才能看");
        }
        if (playing && backStack.length) { backFromPlayer(); return; }
        stopPlayback();
    }

    /* The returned-to video's panel, the ring on the card that was picked. */
    function reopenRelated(pick) {
        openOptions();
        var d = playing && playing.detail;
        if (!d || !d.related || pick < 0 || pick >= d.related.length) { return; }
        var cols = gridColumns();
        panelGrid.grow((Math.floor(pick / cols) + 2) * cols);
        var card = document.querySelector('#opt-related .card[data-i="' + pick + '"]');
        if (card) { Nav.focus(card); }
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
        var all = [];
        /* Emptied on this set (设置 → 清空观看记录): the account's own history
         * is left alone and hidden up to that moment instead. */
        var cut = Resume.clearedAt();
        if (cut) { server = server.filter(function (c) { return (c.at || 0) > cut; }); }
        /* Copies, because the merge writes to the cards it keeps and both
         * inputs outlive it — the server's list is cached for a minute and
         * handed to this twice, once for the home strip and once for 我的. */
        for (var c0 = 0; c0 < local.length + server.length; c0++) {
            var from = c0 < local.length ? local[c0] : server[c0 - local.length];
            var copy = {};
            for (var f in from) { if (from.hasOwnProperty(f)) { copy[f] = from[f]; } }
            all.push(copy);
        }
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
            /* aid belongs to the archive, not to the part, so it carries across
             * even when the two sides name different parts — and it has to
             * carry: the local card never has one (resume.js does not store it)
             * while the server's always does, so every video watched on this
             * television most recently — which is to say the whole top of 继续
             * 观看 — reached the player without an aid, and so without a way to
             * mint the app-endpoint strong token when the CDN refuses the web
             * one. withAid() now buys it back with a round trip; this saves the
             * round trip. */
            if (!winner.aid && loser.aid) { winner.aid = loser.aid; }

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

    /* There is a ceiling, and it is about thumbnails rather than about rows.
     * Every card fetches a picture, and 08-15 measured this set completing
     * concurrent requests to one host strictly one at a time, about 21ms apart —
     * so a screen of 270 cards is 270 queued image requests down the same pipe
     * the player uses. A hundred is roughly six seconds of that at worst, deep
     * enough that the complaint it answers ("历史太少") does not come back, and
     * shallow enough to stay a list rather than a download. If it ever needs to
     * be deeper, page it in as the focus nears the end the way the feed does —
     * do not simply raise this. */
    var HISTORY_CAP = 100;
    /* The first paint is local-only and exists so the screen is never empty; it
     * is replaced a round trip later by the merged list. Building the full
     * hundred twice makes the open *slower* than the old forty-card version it
     * was meant to improve on — a hundred <img> elements go on the wire the
     * moment they exist, down a pipe this set serves one at a time. Two screens'
     * worth is enough to look full while the real list is on its way. */
    var HISTORY_FIRST_PAINT = 24;

    function capHistory(items, limit) {
        var n = limit || HISTORY_CAP;
        return items.length > n ? items.slice(0, n) : items;
    }

    /* bilibili's own history, held briefly. Two screens want it — the home
     * strip and 我的 — and asking twice inside a minute for the same two dozen
     * entries is a request a television has no reason to make. Fetched once at
     * startup so the home screen has it by the time the feed paints, rather
     * than inserting a row under someone who has already started navigating. */
    var serverHistory = { at: 0, items: null };
    var historyOwner = null;   /* which account the in-flight chain is for */

    function activeAccountId() {
        return (typeof Accounts !== "undefined") ? Accounts.activeId() : "";
    }

    /* Callers waiting on the chain that is already running. Without this, three
     * pages become six: `freshHome()` clears the cache and then both it and the
     * `loadFeed` it calls ask for history, and neither can see the other's
     * request — six round trips down a pipe measured as strictly serialized, at
     * the one moment (a wake) this set's network is documented to be slowest.
     * The settled-cache check cannot cover it, because during the fetch there
     * is nothing settled to check. */
    var historyWaiters = null;

    function fetchServerHistory(onOk, onFail) {
        /* Only a complete answer is worth reusing: a cached first page would
         * pin the list at 24 entries for the next minute, which is the very
         * shortfall the paging was added for. */
        if (serverHistory.items && serverHistory.complete &&
                (new Date().getTime() - serverHistory.at) < 60000) {
            onOk(serverHistory.items, serverHistory.items.length, true);
            return;
        }
        /* A chain belongs to the account it was started for. Joining one that
         * another account started — boot fires renderAccounts and this fetch
         * together, and a face picked within the ~2 s the three pages take is
         * exactly that — delivered A's phone history into B's 继续观看 and
         * cached it as B's for a minute. The old chain's answers are dropped
         * on arrival; a new chain starts for the new owner. */
        var owner = activeAccountId();
        if (historyWaiters && historyOwner === owner) {
            historyWaiters.push({ ok: onOk, fail: onFail }); return;
        }
        historyWaiters = [{ ok: onOk, fail: onFail }];
        historyOwner = owner;

        /* Called once per page with everything so far — the cache and every
         * caller take the growing list as it comes. `done` is forwarded: 我的
         * uses it to repaint on the first page and the last one rather than on
         * all three. */
        API.history(function (items, rawCount, done) {
            if (activeAccountId() !== owner) {
                report("history", "服务端历史回来时账号已经切换，丢弃这份");
                /* And let go of the chain, if it is still this one: a later
                 * switch back would otherwise join a chain that has already
                 * finished and wait on it forever. */
                if (historyOwner === owner) { historyWaiters = null; }
                return;
            }
            serverHistory = { at: new Date().getTime(), items: items, complete: !!done };
            var list = historyWaiters || [];
            if (done) { historyWaiters = null; }
            for (var i = 0; i < list.length; i++) { list[i].ok(items, rawCount, !!done); }
        }, function (why) {
            if (activeAccountId() !== owner) {
                if (historyOwner === owner) { historyWaiters = null; }
                return;
            }
            var list = historyWaiters || [];
            historyWaiters = null;
            for (var i = 0; i < list.length; i++) {
                if (list[i].fail) { list[i].fail(why); }
            }
        });
    }

    /* Feeds are cached so that coming back from a video lands where the user
     * left off instead of refetching and dumping focus on the first card. */
    var feedCache = {};

    /* An uploader's page is one more feed kind, "up:<mid>", so paging, the
     * position cache and the restore-on-return all come from loadFeed for
     * free. What it needs on top is one level of "where did I come from":
     * 返回 on an uploader page goes back to the tab it was opened from, at
     * the card that was picked — not to 推荐. One level, not a stack: nobody
     * goes three screens deep from a sofa, and a stack turns 返回 into six
     * presses to get out. Following an uploader from a video found on
     * another uploader's page keeps the original origin, so 返回 still lands
     * on the tab the browsing started from. */
    var upFrom = "rcmd";
    /* Set when the UP page was opened from the play panel: what 返回 on that
     * page goes back to. Keyed to the page and cleared by every other way onto
     * an UP page (openUp) and by switching account; leaving by a tab and
     * coming back to the same page some other way starts clean. */
    var upReturn = null;
    var upInfo = {};        /* kind -> {mid, name, face}, for the page header */
    function isUp(kind) { return String(kind || "").indexOf("up:") === 0; }
    function upMid(kind) { return Number(String(kind).slice(3)) || 0; }
    /* The tab that stands for a screen in the bar. An uploader page has no
     * tab of its own — the ring falls back to the tab it came from. */
    function tabSelectorFor(kind) {
        return '#tabs .tab[data-screen="' + (isUp(kind) ? upFrom : kind) + '"]';
    }
    function showScreen(kind, restore) {
        if (kind === "search") { renderSearch(); }
        else if (kind === "mine") { renderMine(); }
        else if (kind === "settings") { renderSettings(); }
        else { loadFeed(kind, restore); }
    }
    function openUp(mid, name, face) {
        if (!mid) { trouble("拿不到这位 UP 主的资料"); return; }
        /* Any way in but the panel's starts with nothing to go back to; the
         * panel sets its return after this call. A stale one replayed a video
         * from hours before when the page was reached again from 我的 (review,
         * 10-20). */
        upReturn = null;
        var kind = "up:" + mid;
        if (!isUp(state.screen)) { upFrom = state.screen; }
        var held = upInfo[kind] || {};
        upInfo[kind] = { mid: mid, name: name || held.name || "", face: face || held.face || "" };
        loadFeed(kind, true);
    }

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
    /* 人工智能 (1011) and 科技数码 (1012) were tabs until 2026-08-15 and were
     * taken out of the bar because nobody in this room watches them.
     *
     * ⟶ 2026-10-18 the viewer asked to choose (「自选分区页签」), so every zone
     * is here: the 30 public main zones of the current layout, in the site's
     * own order. bilibili still publishes no list; this one is the community's
     * (pskdje/bilibili-API-collect, docs/video/video_zone_v2.md). It agrees with
     * every id above, and 1008 (游戏) answered ranking with shooters and RPGs
     * when checked. Which ones are tabs, and where, is 设置 → 顶栏 (below); the
     * bar scrolls sideways when they do not fit. The kind is the zone's own
     * slug, which is what food and dance already were. */
    var ZONE_LIST = [
        ["douga", "动画", 1005], ["game", "游戏", 1008], ["kichiku", "鬼畜", 1007],
        ["music", "音乐", 1003], ["dance", "舞蹈", 1004], ["cinephile", "影视", 1001],
        ["ent", "娱乐", 1002], ["knowledge", "知识", 1010], ["tech", "科技数码", 1012],
        ["information", "资讯", 1009], ["food", "美食", 1020], ["shortplay", "小剧场", 1021],
        ["car", "汽车", 1013], ["fashion", "时尚美妆", 1014], ["sports", "体育运动", 1018],
        ["animal", "动物", 1024], ["vlog", "vlog", 1029], ["painting", "绘画", 1006],
        ["ai", "人工智能", 1011], ["home", "家装房产", 1015], ["outdoors", "户外潮流", 1016],
        ["gym", "健身", 1017], ["handmake", "手工", 1019], ["travel", "旅游出行", 1022],
        ["rural", "三农", 1023], ["parenting", "亲子", 1025], ["health", "健康", 1026],
        ["emotion", "情感", 1027], ["life_joy", "生活兴趣", 1030], ["life_experience", "生活经验", 1031]
    ];
    var ZONES = {};
    for (var zi = 0; zi < ZONE_LIST.length; zi++) { ZONES[ZONE_LIST[zi][0]] = ZONE_LIST[zi][2]; }

    /* The whole top bar is the viewer's (2026-10-18: 「直播 动态 排行 稍后 热门
     * 我的都可以设置，只是第一个默认推荐就好了，其次顺序也可以允许用户调整」).
     * 推荐 is first and 搜索 / 设置 are last, fixed — 设置 is the way back to
     * this choice, and 推荐 is what the set opens on. Between them, whatever is
     * in `tabs`, in its order: the built-in pages and the zones alike. The
     * default is the bar as it was when this was asked for, which the viewer
     * named as the default for the release. */
    var CORE_TABS = [["live", "直播"], ["dynamic", "动态"], ["mine", "我的"],
                     ["toview", "稍后"], ["popular", "热门"], ["ranking", "排行"]];
    var TAB_NAMES = {};
    for (var ti = 0; ti < CORE_TABS.length; ti++) { TAB_NAMES[CORE_TABS[ti][0]] = CORE_TABS[ti][1]; }
    for (var tz = 0; tz < ZONE_LIST.length; tz++) { TAB_NAMES[ZONE_LIST[tz][0]] = ZONE_LIST[tz][1]; }
    var DEFAULT_TABS = ["live", "dynamic", "mine", "toview", "popular", "ranking", "food", "dance"];
    function chosenTabs() {
        var v = Settings.get("tabs", null);
        if (!v || typeof v.length !== "number") { v = DEFAULT_TABS; }
        var out = [];
        for (var i = 0; i < v.length; i++) {
            if (TAB_NAMES[v[i]] && out.indexOf(v[i]) < 0) { out.push(v[i]); }
        }
        return out;
    }
    /* Everything that can be a tab and is not one now: the pages first, then
     * the zones in the site's order. */
    function spareTabs() {
        var on = chosenTabs(), out = [], i;
        for (i = 0; i < CORE_TABS.length; i++) { if (on.indexOf(CORE_TABS[i][0]) < 0) { out.push(CORE_TABS[i][0]); } }
        for (i = 0; i < ZONE_LIST.length; i++) { if (on.indexOf(ZONE_LIST[i][0]) < 0) { out.push(ZONE_LIST[i][0]); } }
        return out;
    }
    function tabNames(list) {
        return list.length ? list.map(function (k) { return TAB_NAMES[k]; }).join("、") : "无";
    }
    /* The chosen tabs, between 推荐 and 搜索. Rebuilt from scratch: the bar is
     * small, and a change in 设置 should look the same as a fresh start. */
    function renderUserTabs() {
        var bar = el("tabs"), before = document.querySelector('#tabs .tab[data-screen="search"]');
        var old = document.querySelectorAll("#tabs .user-tab");
        for (var i = 0; i < old.length; i++) { bar.removeChild(old[i]); }
        var list = chosenTabs();
        for (var j = 0; j < list.length; j++) {
            var t = document.createElement("div");
            t.className = "tab focusable user-tab";
            t.setAttribute("data-screen", list[j]);
            t.textContent = TAB_NAMES[list[j]];
            bar.insertBefore(t, before);
            bindTab(t);
        }
        markTab();
    }

    /* 设置 → 顶栏. Two rows of chips: the bar as it stands, in order, with the
     * fixed three shown but not focusable; and everything that could be on it.
     * 确认 on a spare adds it at the end. 确认 on one in the bar picks it up:
     * 左 / 右 move it (the bar above moves with it), 下 takes it off the bar,
     * 确认 / 上 / 返回 put it down. While one is picked up the keys are this
     * row's (barPickKey, ahead of everything in Nav.onKey). */
    var barPick = null;
    function paintBarChips(focus) {
        var list = chosenTabs(), spare = spareTabs(), html = '<div class="opt fixed">推荐</div>', i;
        for (i = 0; i < list.length; i++) {
            html += '<div class="opt focusable' + (barPick === list[i] ? " picked" : "") +
                    '" data-tab="' + list[i] + '">' + esc(TAB_NAMES[list[i]]) + '</div>';
        }
        html += '<div class="opt fixed">搜索</div><div class="opt fixed">设置</div>';
        el("bar-chips").innerHTML = html;
        html = "";
        for (i = 0; i < spare.length; i++) {
            html += '<div class="opt focusable" data-spare="' + spare[i] + '">' + esc(TAB_NAMES[spare[i]]) + '</div>';
        }
        el("spare-chips").innerHTML = html || '<div class="me-sub">全都在顶栏上了</div>';
        var chips = document.querySelectorAll("#bar-chips .opt.focusable");
        for (i = 0; i < chips.length; i++) {
            (function (chip) {
                chip.onselect = function () {
                    barPick = chip.getAttribute("data-tab");
                    paintBarChips({ bar: barPick });
                };
            })(chips[i]);
        }
        chips = document.querySelectorAll("#spare-chips .opt");
        for (i = 0; i < chips.length; i++) {
            (function (chip, at) {
                chip.onselect = function () {
                    var k = chip.getAttribute("data-spare"), now = chosenTabs();
                    now.push(k);
                    Settings.set("tabs", now);
                    renderUserTabs();
                    /* Stay in this row, on whatever took its place: adding
                     * three in a row should be three presses of 确认. */
                    var rest = spareTabs();
                    paintBarChips(rest.length ? { spare: rest[Math.min(at, rest.length - 1)] } : { bar: k });
                    report("settings", "顶栏加上 " + TAB_NAMES[k] + "：" + tabNames(chosenTabs()));
                };
            })(chips[i], i);
        }
        if (focus) {
            var target = focus.bar ? document.querySelector('#bar-chips .opt[data-tab="' + focus.bar + '"]')
                                   : document.querySelector('#spare-chips .opt[data-spare="' + focus.spare + '"]');
            if (target) { Nav.focus(target); }
        }
    }
    function barPickKey(k) {
        var list = chosenTabs(), at = list.indexOf(barPick), picked = barPick;
        if (at < 0) { barPick = null; paintBarChips(); return true; }
        if (k === Nav.KEY.LEFT || k === Nav.KEY.RIGHT) {
            var to = at + (k === Nav.KEY.RIGHT ? 1 : -1);
            if (to >= 0 && to < list.length) {
                list.splice(at, 1);
                list.splice(to, 0, picked);
                Settings.set("tabs", list);
                renderUserTabs();
            }
            paintBarChips({ bar: picked });
            return true;
        }
        if (k === Nav.KEY.DOWN) {
            list.splice(at, 1);
            Settings.set("tabs", list);
            renderUserTabs();
            barPick = null;
            paintBarChips(list.length ? { bar: list[Math.min(at, list.length - 1)] } : { spare: picked });
            report("settings", "顶栏去掉 " + TAB_NAMES[picked] + "：" + tabNames(list));
            return true;
        }
        if (k === Nav.KEY.ENTER || k === Nav.KEY.UP || k === Nav.KEY.RETURN) {
            barPick = null;
            paintBarChips({ bar: picked });
            report("settings", "顶栏：" + tabNames(list));
            return true;
        }
        return k !== Nav.KEY.EXIT;
    }

    /* Nobody in this repository has seen a 稍后再看 response, and CLAUDE.md says
     * in as many words not to assume it has history's shape. So the first list
     * of a run prints what actually came back: the raw field names of entry one,
     * next to what the mapping made of them. Wrong cards otherwise look exactly
     * like an empty account — the failure this whole layer is prone to.
     *
     * Once per run: it is a diagnostic, not a log of browsing. */
    var toviewTold = false;

    function reportToview(items, raw) {
        if (toviewTold) { return; }
        toviewTold = true;
        var first = raw && raw[0];
        if (!first) { report("toview", "列表是空的（服务器给了 0 条）"); return; }
        var keys = [];
        for (var k in first) { if (first.hasOwnProperty(k)) { keys.push(k); } }
        var v = items[0] || {};
        report("toview", raw.length + " 条，能开的 " + items.length + " 条" +
               " | 第一条的字段：" + keys.join(",") +
               " | 映射结果 bvid=" + (v.bvid || "无") + " aid=" + (v.aid || 0) +
               " cid=" + (v.cid || "无") + " 时长=" + (v.duration || "无") +
               " 作者=" + Diag.priv(v.author || "无") + " 播放=" + (v.play || "无") +
               " 看过=" + Math.round((v.seen || 0) * 100) + "%" +
               " 加入=" + (v.at || 0) + " state=" + v.state +
               " 标题=" + Diag.priv(String(v.title || "").slice(0, 20)));
    }

    /* 直播 (2026-10-18). The first page puts the people this account follows
     * who are live now in front (marked 关注), then the whole site by how many
     * are watching; later pages are more of the latter. A following list that
     * fails is logged and left out — the tab still has the rest to show. The
     * first answer of a run is described in the log, field names and all: the
     * following endpoint is a web one, and whether it honours access_key the
     * way the others do is only known from the set. */
    var liveFollowTold = false;
    function fetchLive(page, onOk, onFail) {
        function withHot(followed) {
            API.liveRooms(page, function (rooms) {
                var seen = {}, out = [], all = (followed || []).concat(rooms);
                for (var i = 0; i < all.length; i++) {
                    if (all[i].roomid && !seen[all[i].roomid]) { seen[all[i].roomid] = 1; out.push(all[i]); }
                }
                onOk(out, { more: rooms.length >= 30 });
            }, function (why) {
                if (followed && followed.length) { onOk(followed, { more: false }); return; }
                onFail(why);
            });
        }
        if (page !== 1 || !Auth.isLoggedIn()) { withHot(null); return; }
        API.liveFollowing(function (items, raw) {
            if (!liveFollowTold) {
                liveFollowTold = true;
                var keys = [], f = raw[0] || {};
                for (var k in f) { if (f.hasOwnProperty(k)) { keys.push(k); } }
                report("live", "关注的直播：列表 " + raw.length + " 个，正在播 " + items.length + " 个" +
                       (keys.length ? " | 第一条的字段：" + keys.join(",") : ""));
            }
            withHot(items);
        }, function (why) {
            report("live", "关注的直播取不到：" + why);
            withHot(null);
        });
    }

    /* ranking answers with its full 100 in one go and has no second page. */
    function fetchPage(kind, page, onOk, onFail) {
        if (isUp(kind)) {
            var uc = feedCache[kind];
            return API.space(upMid(kind), (page > 1 && uc) ? (uc.cursor || "") : "", onOk, onFail);
        }
        if (kind === "live") { return fetchLive(page, onOk, onFail); }
        if (kind === "ranking") { return page === 1 ? API.ranking(0, onOk, onFail) : onOk([]); }
        if (ZONES[kind]) { return page === 1 ? API.ranking(ZONES[kind], onOk, onFail) : onOk([]); }
        if (kind === "rcmd") { return API.recommended(page, onOk, onFail); }
        if (kind === "dynamic") {
            var dc = feedCache.dynamic;
            return API.dynamic(page, (page > 1 && dc) ? (dc.cursor || "") : "", onOk, onFail);
        }
        if (kind === "toview") {
            /* Whole list in one answer, like ranking. */
            if (page !== 1) { return onOk([]); }
            return API.toview(function (items, raw) {
                reportToview(items, raw);
                /* Newest first, so the thing just tapped on the phone is the
                 * card under the cursor when the viewer reaches the sofa. That
                 * may well be the order it already arrives in — but the whole
                 * point of this tab is that one journey, and it should not
                 * depend on an ordering nobody has checked. Only when every
                 * entry has a timestamp: sorting on a field the mapping got
                 * wrong would shuffle the list into no order at all. */
                var dated = true;
                for (var i = 0; i < items.length; i++) { if (!items[i].at) { dated = false; break; } }
                if (dated) { items.sort(function (a, b) { return b.at - a.at; }); }
                onOk(items);
            }, onFail);
        }
        return API.popular(page, onOk, onFail);
    }

    /* Feeds used to stop dead after one screenful. Rather than a "load more"
     * button, which costs a press and a focus jump, the next page is fetched as
     * the focus nears the end of what is already rendered. */
    function maybeLoadMore(focused) {
        /* pendingNext: the end-of-video chooser paints cards with a `data-i` of
         * their own, and focus landing on one of those must not be read as the
         * viewer reaching the end of the feed behind it. */
        if (loadingMore || playing || liveRoom || optionsOpen || pendingNext) { return; }
        var cache = feedCache[state.screen];
        if (!cache || cache.exhausted) { return; }
        if (!focused || !focused.getAttribute || focused.getAttribute("data-i") === null) { return; }
        if (!/(^|\s)card(\s|$)/.test(focused.className)) { return; }

        var idx = Number(focused.getAttribute("data-i"));
        if (idx < cache.items.length - 8) { return; }

        loadingMore = true;
        var kind = state.screen, next = (cache.page || 1) + 1;
        fetchPage(kind, next, function (more, extra) {
            loadingMore = false;
            var c = feedCache[kind];
            if (!c || state.screen !== kind) { return; }
            if (extra) {
                c.cursor = extra.cursor || "";
                if (extra.more === false) { c.exhausted = true; }
            }

            /* rcmd can repeat items across batches; dropping duplicates keeps
             * the grid from filling with the same handful of videos. */
            /* Keyed by room for 直播: a live room has no bvid, and keyed on bvid
             * every one of them read as a duplicate of the first. */
            var seen = {};
            for (var i = 0; i < c.items.length; i++) { seen[itemKey(c.items[i])] = 1; }
            var fresh = [];
            for (var j = 0; j < more.length; j++) {
                var key = itemKey(more[j]);
                if (key && !seen[key]) { fresh.push(more[j]); seen[key] = 1; }
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

    function itemKey(v) { return v.live ? (v.roomid ? "live:" + v.roomid : "") : (v.bvid || ""); }

    function appendCards(items, offset) {
        var grid = el("feed-grid") || screenEl.querySelector(".grid");
        if (!grid) { return; }
        var html = "";
        for (var i = 0; i < items.length; i++) { html += cardHtml(items[i], offset + i); }
        var holder = document.createElement("div");
        holder.innerHTML = html;
        while (holder.firstChild) {
            var node = holder.firstChild;
            holder.removeChild(node);
            grid.appendChild(node);
            (function (card, v) {
                card.__video = v;
                card.onselect = function () { playVideo(v); };
                bindCardAction(card, v);
            })(
                node, items[Number(node.getAttribute("data-i")) - offset]);
        }
        fitCardMeta(grid);
    }

    /* Coming back to the home tab is the moment to notice that the phone has
     * been watching. Nothing polls: a set left on the home screen never asks
     * again, so an evening's worth of phone viewing was invisible until the app
     * was restarted. This asks once, on arrival, and only when what is in hand
     * has gone stale — five minutes, so switching tabs about does not turn into
     * a request per press, and an idle television still sends nothing at all.
     *
     * The repaint keeps the existing rule: only while the cursor is still on the
     * first card. With it parked deep in the grid the row waits for the next
     * rebuild — a strip that re-lays itself out under someone who is reading is
     * worse than a strip that is five minutes old. */
    var HISTORY_STALE_MS = 300000;

    function refreshHistoryIfStale() {
        if (!Auth.isLoggedIn()) { return; }
        if (serverHistory.items && serverHistory.complete &&
                (new Date().getTime() - serverHistory.at) < HISTORY_STALE_MS) { return; }
        fetchServerHistory(function () { maybeRefreshResumeRow(); });
    }

    /* How long switching the set on takes to put a home screen up — asked
     * every evening, and until 2026-09-28 never measured. One line per JS
     * context (a resume from suspend does not rerun onload, so it has none),
     * every mark from navigationStart. */
    var boot = { told: false, onload: 0, asked: 0, prefetched: false };
    function bootMs(t) {
        var t0 = (window.performance && performance.timing && performance.timing.navigationStart) || 0;
        return t0 ? (t - t0) + "ms" : "?";
    }
    function tellBoot(items) {
        if (boot.told) { return; }
        boot.told = true;
        var answered = new Date().getTime();
        var dcl = 0;
        try { dcl = performance.timing.domContentLoadedEventEnd; } catch (e) {}
        function send(painted, pic) {
            var shakaMs = (window.__afterShaka && window.__beforeShaka)
                ? (window.__afterShaka - window.__beforeShaka) + "ms" : "?";
            /* Shaka now loads after the first screen (player.js,
             * withShakaScript), so it is no longer inside 页面解析完; when
             * the feed wins the race it has not finished yet and reads 还没到. */
            report("boot", "启动 页面解析完=" + (dcl ? bootMs(dcl) : "?") +
                   " Shaka 后台加载=" + (window.__afterShaka ? shakaMs : "还没到") +
                   (window.__beforeShaka ? "（开始于 " + bootMs(window.__beforeShaka) + "）" : "") +
                   " onload=" + bootMs(boot.onload) +
                   " 首页请求发出=" + bootMs(boot.asked) +
                   (boot.prefetched ? "（选账号时已预取）" : "") +
                   " 首页回来=" + bootMs(answered) +
                   " 首屏画好=" + bootMs(painted) +
                   " 首张封面=" + pic + "（" + items.length + " 张卡片，从进程启动算起）");
        }
        var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16); };
        raf(function () {
            var painted = new Date().getTime();
            var img = screenEl.querySelector(".card img");
            if (!img) { send(painted, "没有"); return; }
            if (img.complete && img.naturalWidth) { send(painted, "已在缓存"); return; }
            var done = false;
            function fin(what) { if (done) { return; } done = true; send(painted, what); }
            img.addEventListener("load", function () { fin(bootMs(new Date().getTime())); });
            img.addEventListener("error", function () { fin("加载失败"); });
            setTimeout(function () { fin("10 秒还没到"); }, 10000);
        });
    }

    function loadFeed(kind, restore, retries) {
        state.screen = kind;
        markTab();
        if (restore) { backMark("顶栏"); }
        if (kind === "rcmd") { refreshHistoryIfStale(); }
        var req = ++feedRequest;
        newView();

        var cached = feedCache[kind];
        if (restore && cached) {
            backMark("开头");
            var kept = !gridIntact(kind, cached) && unstashGrid(kind, cached);
            if (kept || gridIntact(kind, cached)) {
                backMark(kept ? "取回网格" : "认网格");
                refreshPlayedBars();
                backMark("进度条");
                /* After the first frame: 40–50 ms here (10-22), and the ring is in
                 * the grid below it, so the grid can be up first. */
                if (kind === "rcmd") {
                    window.requestAnimationFrame(function () {
                        setTimeout(function () { if (state.screen === "rcmd") { repaintResumeStrip(); } }, 0);
                    });
                }
            } else {
                renderGrid(cached.items, emptyTextFor(kind));
                backMark("整页重画");
            }
            var cards = screenEl.querySelectorAll("#feed-grid .card");
            var target = cards[Math.min(cached.index || 0, cards.length - 1)];
            Nav.focus(target || cards[0]);
            backMark("焦点");
            screenEl.scrollTop = cached.scrollTop || 0;
            backMark("滚动");
            return;
        }

        setScreen('<div class="empty">加载中…</div>');
        if ((kind === "dynamic" || kind === "toview") && !Auth.isLoggedIn()) {
            setScreen('<div class="empty">' +
                (kind === "dynamic" ? "动态" : "稍后再看") +
                '需要登录，先去「我的」扫码</div>');
            Nav.reset(tabSelectorFor(kind));
            return;
        }
        if (!boot.asked) { boot.asked = new Date().getTime(); }
        var bootSlot = takeBootFeed(kind);
        var gotPage = function (items, extra) {
            /* Tab presses outrun the network: without this the slower of two
             * requests wins and paints its content under the other's heading. */
            if (req !== feedRequest) { return; }
            feedCache[kind] = { items: items, index: 0, scrollTop: 0, page: 1,
                                cursor: (extra && extra.cursor) || "",
                                exhausted: !items.length || !!(extra && extra.more === false) };
            window.__stItems = items;   /* selftest addresses the same video */
            /* An empty 稍后再看 is the normal state of a list nobody has added
             * to yet, and 「没有内容」 reads as a fault. It is also the one
             * screen where saying how the list gets filled is the whole feature:
             * the adding happens on a phone, somewhere else entirely. */
            renderGrid(items, emptyTextFor(kind));
            /* First card in the document, which on the home tab is the first
             * card of 继续观看 — the strip is painted above the grid. That is
             * the point of it: what you were in the middle of is already under
             * the cursor when the screen appears. An empty list keeps the ring
             * on the tab just pressed instead of falling to the first tab. */
            if (items.length) { Nav.reset(".card"); }
            else { Nav.reset(tabSelectorFor(kind)); }
            tellBoot(items);
        };
        var failedPage = function (why) {
            if (req !== feedRequest) { return; }
            /* Waking from suspend, this set's network is regularly a few seconds
             * behind its screen — the same gap that killed the report channel on
             * 08-12. An error page as the first thing on a television somebody
             * just switched on is worse than three more seconds of 加载中, so
             * the wake path asks for one silent retry. Nothing else does: a
             * feed that fails while the viewer is already looking at the app
             * should say so. */
            if (retries > 0) {
                report("feed", kind + " 加载失败（" + why + "），3 秒后自动重来一次");
                setTimeout(function () {
                    if (req !== feedRequest) { return; }
                    loadFeed(kind, false, retries - 1);
                }, 3000);
                return;
            }
            /* The upload's reason carries only the words on the screen; which
             * tab said them is here (10-22: five 「code -352」 from a set in HK,
             * and nothing to say which feed). */
            report("feed", kind + " 加载失败（" + why + "），给了重试按钮");
            showError(loginNeeded(why) || ("加载失败：" + why), function () { loadFeed(kind); });
        };
        if (bootSlot) {
            /* Asked while the picker was up; a failure there is asked again
             * here, as if the prefetch had never happened. */
            whenSettled(bootSlot, function (r) { gotPage(r.items, r.extra); }, function () {
                if (req !== feedRequest) { return; }
                fetchPage(kind, 1, gotPage, failedPage);
            });
        } else {
            fetchPage(kind, 1, gotPage, failedPage);
        }
    }

    /* The home feed, asked for while 「谁在看？」 is still on screen — for the
     * account that was active last time, which is who picks themselves most
     * evenings. The picker sat for 1.7–4.9s on 2026-09-28 before anyone
     * pressed, and the feed then took another ~600ms; asked here, it is in
     * hand when the press comes. Keyed by the account the request went out
     * under: picking someone else switches the account first, the key no
     * longer matches, and the feed is asked for them as before. */
    var bootFeed = null;
    function startBootFeed() {
        var acct = Accounts.activeId();
        var acc = Accounts.active();
        if (!acc || Accounts.needsRelogin(acc)) { return; }
        bootFeed = {
            acct: acct, at: new Date().getTime(),
            slot: prefetchSlot(function (ok, fail) {
                fetchPage("rcmd", 1, function (items, extra) {
                    /* And the first two rows' covers: with the feed already in
                     * hand the first cover still landed 600ms after the grid
                     * painted. Same URLs cardHtml will ask for, so the image
                     * cache answers them. */
                    for (var i = 0; i < Math.min(6, items.length); i++) {
                        if (items[i] && items[i].pic) { new Image().src = items[i].pic; }
                    }
                    ok({ items: items, extra: extra });
                }, fail);
            })
        };
    }
    function takeBootFeed(kind) {
        var b = bootFeed;
        if (kind !== "rcmd" || !b) { return null; }
        bootFeed = null;
        if (b.acct !== Accounts.activeId() || new Date().getTime() - b.at > 60000) { return null; }
        boot.prefetched = true;
        return b.slot;
    }

    /* The history usually lands with the feed and the strip is simply part of
     * the first paint. When it is slower it may still be added — or corrected,
     * when the phone watched something this set does not know about — but only
     * while the viewer has not moved: a row appearing above the cursor after
     * someone has started reading pushes everything down under their eyes, and
     * that is worse than no row at all.
     *
     * "Has not moved" is the cursor still being on the first card of the page,
     * whichever row that is. Repainting from there costs nothing visible: the
     * focus lands on the first card again, which is where it already was. */
    /* The strip alone, in place — a whole-grid rebuild here re-applied the
     * position saved before the failed play and snapped the ring back over
     * any presses made during the round trip. */
    function repaintResumeStrip() {
        if (state.screen !== "rcmd" || playing || pendingNext) { return; }
        var row = el("resume-row");
        if (!row) { return; }
        var had = Nav.current();
        var items = resumeRowItems();
        resumeRowSig = rowSignature(items);
        if (items.length) {
            paintCards(row, items);
        } else {
            var label = row.previousSibling;
            row.parentNode.removeChild(row);
            if (label && label.className === "section") { label.parentNode.removeChild(label); }
        }
        if (had && !document.body.contains(had)) {
            Nav.reset(items.length ? "#resume-row .card" : "#feed-grid .card");
        }
    }

    function maybeRefreshResumeRow() {
        if (state.screen !== "rcmd") { return; }
        var cache = feedCache.rcmd;
        if (!cache || !cache.items.length) { return; }
        var items = resumeRowItems();
        if (!items.length) { return; }
        if (el("resume-row") && rowSignature(items) === resumeRowSig) { return; }
        var first = screenEl.querySelector(".card");
        if (!first || Nav.current() !== first) { return; }
        /* A strip already on screen only needs its three cards redrawn — the
         * whole-grid rebuild re-requested every thumbnail of every loaded page
         * to change three. Only a strip that does not exist yet needs the
         * grid rebuilt, to make room above it. */
        if (el("resume-row")) {
            repaintResumeStrip();
            Nav.reset(".card");
            return;
        }
        renderGrid(cache.items);
        Nav.reset(".card");
    }

    /* paintCards wraps the strip's cards in a .grid of their own, so the row
     * id is two levels up, not one. */
    function inResumeStrip(node) {
        for (var n = node, i = 0; n && i < 4; n = n.parentNode, i++) {
            if (n.id === "resume-row") { return true; }
        }
        return false;
    }

    function rememberPosition() {
        var c = feedCache[state.screen];
        if (!c) { return; }
        /* Nothing about a screen nobody is looking at is worth recording. While
         * the player or the end-of-video chooser is up, `#shell` is
         * display:none and `screenEl.scrollTop` reads 0 — writing that over a
         * remembered position keeps the deep card index and loses the scroll,
         * so coming back focuses card #37 and then scrolls to the top, leaving
         * the ring off screen. */
        if (browseHidden()) { return; }
        /* Related videos in the player panel carry data-i too, so without this
         * picking one wrote its index over the feed's and returning landed on
         * an unrelated card. */
        if (optionsOpen) { return; }
        var cur = Nav.current();
        /* And the resume strip's cards carry one too, into a different array —
         * remembering their index would land the viewer on an unrelated card in
         * the feed when they came back. */
        if (cur && cur.getAttribute && cur.getAttribute("data-i") !== null &&
                cur.parentNode && cur.parentNode.id === "feed-grid") {
            c.index = Number(cur.getAttribute("data-i"));
        } else if (cur && inResumeStrip(cur)) {
            /* The strip sits above card 0. Keeping a deep index from an
             * earlier visit while writing the strip's scrollTop meant coming
             * back focused card #37 and then scrolled to the top — ring off
             * screen, next arrow press jumps ten rows. */
            c.index = 0;
        }
        c.scrollTop = screenEl.scrollTop;
    }

    /* ---------------- coming back after the set was off ---------------- */

    /* Tizen suspends rather than kills — the same thing that keeps the report
     * channel's miss counter alive across an evening. So switching the
     * television off and on again usually returns to the very same JS context:
     * last night's recommendations still painted, the cursor still on whatever
     * was last looked at, the feed cache still holding pages fetched before
     * bed. Opening an app should feel like opening it — a feed fetched now, and
     * the half-watched thing under the cursor.
     *
     * Two signals, because which of them this firmware sends has not been
     * measured and a wake that goes unnoticed is exactly the stale screen this
     * removes: `visibilitychange`, and a heartbeat that notices its own timer
     * stopped. Timers freeze while suspended, so a tick arriving far later than
     * it was due is itself the evidence — that one survives a firmware that
     * never fires the event at all. Whichever arrives first does the work; the
     * debounce keeps a set that sends both from fetching twice.
     *
     * A minute is the line. Below it this was not a power cycle but a system
     * overlay or a glance at another app, and taking somebody's place in the
     * grid away for that is worse than a slightly stale feed. */
    var AWAY_MS = 60000;
    var BEAT_MS = 30000;
    var hiddenAt = 0, lastBeat = 0, lastWake = 0;
    /* A wake that arrived while a video was playing, waiting for the end of it. */
    var pendingWake = false;

    /* Everything a fresh arrival at the home screen means. Two callers: the wake
     * itself, and the end of playback when the wake was owed. */
    function freshHome() {
        closeIme(false);
        /* closeIme hands focus to a `.key` — inside the screen the next line
         * destroys. Focus on a detached node throws nothing and looks like a
         * dead remote for as long as the load takes (and the wake path can add
         * a silent three-second retry to that). The tab bar is never rebuilt,
         * so it is somewhere real to stand until the grid paints. */
        if (imeWasOpen) { Nav.reset("#tabs .tab"); }
        /* Every tab, not just this one: 热门 and the zones went stale in exactly
         * the same way, and each costs one request the first time it is opened
         * again rather than all of them now. */
        feedCache = {};
        serverHistory = { at: 0, items: null };
        /* loadFeed's own arrival hook asks for the history — see
         * refreshHistoryIfStale. Asking again here is what made it six requests
         * instead of three. */
        loadFeed("rcmd", false, 1);
    }

    /* Called by stopPlayback, which is the one way back out of a video.
     *
     * Returns true only when it has taken over the navigation — that is, when
     * the screen behind the player is the feed. It used to return true always,
     * and stopPlayback's early exit then threw away the 搜索 and 我的 branches
     * with it: a viewer who searched for a series, opened an episode, and had
     * the set sleep mid-episode pressed 返回 and landed on 推荐 with their
     * results gone, though `state.results` was still in memory a function call
     * away. Only the feed is stale; the screen the viewer chose is not ours to
     * replace. Clearing the caches still happens either way, so coming back to
     * 推荐 later refetches. */
    function payOwedWake() {
        if (!pendingWake) { return false; }
        pendingWake = false;
        feedCache = {};
        serverHistory = { at: 0, items: null };
        if (state.screen === "search" || state.screen === "mine") {
            report("lifecycle", "退出播放，缓存已清 —— 但观众停在" +
                   (state.screen === "search" ? "搜索" : "我的") + "，屏幕不动它");
            return false;
        }
        report("lifecycle", "退出播放，把挂起期间欠下的首页重刷补上");
        freshHome();
        return true;
    }

    function wokeUp(why, awayMs) {
        var now = new Date().getTime();
        if (now - lastWake < AWAY_MS) { return; }   /* the other signal had it */
        lastWake = now;
        report("lifecycle", why + "，离开了 " + Math.round(awayMs / 1000) + " 秒");
        try { Update.wake(); } catch (e) {}   /* waits out playback by itself */

        /* A set that suspended in the middle of a video comes back to the video.
         * Playback owns the screen and its own recovery ladders; a feed reload
         * underneath it would tear down a session that is about to resume, and
         * the requests would compete with the player exactly the way the
         * metadata fetches used to.
         *
         * But the refresh is owed, not cancelled. The first field sample of this
         * whole mechanism (08-15, three hours suspended) landed on this branch:
         * the set had been left with a video playing, so nothing was refreshed,
         * and backing out of that dead video would have handed back the morning's
         * feed with the cursor where it was — the very thing this removes. It is
         * paid at the end of playback instead. */
        /* `pendingNext` counts as playing here. The end-of-video chooser runs
         * with `playing === null` — that is how it is built — so a wake during
         * it used to fall straight through to freshHome, which repaints the
         * hidden browse screen underneath and hands the ring to a card nobody
         * can see, while 「即将播放」 is still up and still swallowing every key
         * through handleNextKeys. A remote that looks dead in front of a screen
         * that is still there. Owe it instead: 返回 from the chooser goes
         * through stopPlayback, which pays it. */
        if (playing || pendingNext) {
            pendingWake = true;
            report("lifecycle", "正在播放，先不动它 —— 退出播放时再补上重刷");
            return;
        }
        /* A live room comes back to a stream that has moved on without it:
         * start again at what is live now. The feed refresh is owed, as above. */
        if (liveRoom) {
            pendingWake = true;
            report("lifecycle", "正在看直播，重新连到现在的画面 —— 退出时再补上重刷");
            liveRoom.tries = 0;
            Player.stop();
            startLiveRoom("");
            return;
        }
        /* The two screens that are asking the viewer a question: somebody may be
         * standing there with a phone against a QR code, or the set may be
         * waiting to be told who is watching. Answering it for them is worse
         * than a stale screen. */
        if (state.screen === "login" || state.screen === "accounts") {
            report("lifecycle", "停在" + (state.screen === "login" ? "扫码页" : "账号页") + "，不动它");
            return;
        }
        /* Same rule as payOwedWake: a screen the viewer chose — search results,
         * 我的 — is not ours to replace with the home feed. The caches go
         * stale either way; the screen stays. */
        if (state.screen === "search" || state.screen === "mine") {
            feedCache = {};
            serverHistory = { at: 0, items: null };
            report("lifecycle", "缓存已清 —— 但观众停在" +
                   (state.screen === "search" ? "搜索" : "我的") + "，屏幕不动它");
            return;
        }

        freshHome();
    }

    /* No key press can produce a suspend/resume cycle, so the selftest reaches
     * the wake path through here. */
    /* The AVPlay route for live only starts after a decode failure, which a
     * newer set never has; the selftest switches it on for the room it is in. */
    window.__stLiveNative = function (on, force, failTsOnce) {
        liveNative = !!on;
        liveNativeForce = force || "";
        liveFailTsOnce = !!failTsOnce;
        /* Each step starts from what the room has not yet learned. */
        if (on && liveRoom) { liveRoom.nativeFor = ""; Player.stop(); startLiveRoom(""); }
    };
    window.__stLiveUnsupportedOnce = function () {
        liveFail4032Once = true;
        if (liveRoom) { liveRoom.nativeFor = ""; Player.stop(); startLiveRoom(""); }
    };
    window.__stLiveDecodeFailOnce = function () {
        liveFailDecodeOnce = true;
        if (liveRoom) { liveRoom.nativeFor = ""; Player.stop(); startLiveRoom(""); }
    };
    window.__stLiveNoFmp4 = function (on) {
        liveNoFmp4 = !!on;
        if (on && liveRoom) { liveRoom.nativeFor = ""; Player.stop(); startLiveRoom(""); }
    };
    window.__stLiveRoom = function () {
        return liveRoom && { room: liveRoom.nativeFor, fmt: liveRoom.nativeFmt, used: liveRoom.qnUsed,
                             below: liveRoom.tsBelow, gaveUp: liveRoom.tsGaveUp, token: liveRoom.token, moved: liveRoom.moved,
                             mseSteps: liveRoom.mseSteps, mseTry: liveRoom.mseTry, native: liveNative,
                             tsSilent: liveRoom.tsSilent, flvGaveUp: liveRoom.flvGaveUp, flvDead: liveFlvDead };
    };
    window.__stWake = function () { lastWake = 0; wokeUp("自测模拟关机再开机", AWAY_MS); };

    /* Nor can a key press make a video end — not inside a run that has to
     * finish in a couple of minutes. The end-of-video screen went onto the
     * television on 08-15 without ever having run there, which is the one thing
     * this repository keeps promising not to do, so it gets a way in: jump to
     * four seconds from the end and let the real `ended` event do the rest. */
    window.__stNearEnd = function () {
        var d = Player.durationMs();
        if (!d) { return false; }
        Player.seekTo(Math.max(0, d - 4000));
        return true;
    };

    /* A rescue's teardown window, on demand: the same Player.stop() and the
     * same rebuild from playing.startMs the strong-token path runs, with its
     * seconds of sidx reads stood in for by a wait. A 403 cannot be ordered
     * up, and a drag pressed inside that window used to be lost (10-18). */
    window.__stRebuild = function (gapMs) {
        if (!playing || playing.route !== "dash" || !playing.dashReady) { return false; }
        var sess = playing;
        playing.startMs = Player.hasPosition() ? Player.position() : lastKnownPosition;
        Player.stop();
        setTimeout(function () {
            if (playing === sess) { playDash(sess.dashReady, sess.quality); }
        }, gapMs);
        return true;
    };

    /* How many cards the end-of-video grid has to give in total, so the
     * selftest can tell "the grid refused to grow" from "this video only had
     * one row's worth of related videos" — the DOM alone cannot. */
    window.__stNextupTotal = function () { return nextupGrid.total(); };
    window.__stPanelTotal = function () { return panelGrid.total(); };

    /* For the danmaku frame-time run (deploy.sh --dmperf): open a list that
     * has dense comments, and switch danmaku off and on between windows. */
    window.__stLoadFeed = function (kind) { loadFeed(kind); };
    window.__stDanmaku = function (level) { setDanmakuLevel(level); };

    /* For deploy.sh --tokenswap: what the session made of a refusal, and a way
     * to leave the 15-minute window (C) behind so normal viewing is not
     * steered by a refusal the test manufactured. */
    window.__stStrongState = function () {
        if (!playing) { return null; }
        return { route: playing.route || "", triedStrong: !!playing.triedStrong, cid: playing.cid,
                 strong: !!(playing.dashReady && playing.dashReady.strong),
                 label: playing.timedLabel || "", shown: !!playing.shown };
    };
    window.__stForgetRefusal = function () { webRefusedAt = 0; };
    /* The video playing, for the selftest's one forced write through the frame. */
    window.__stPlayingIds = function () {
        return playing && playing.detail ? { aid: playing.detail.aid || 0, cid: playing.cid || 0 } : null;
    };
    /* The panel's three buttons: what was read, without pressing anything. */
    window.__stPanelActs = function () {
        return pa ? { loaded: pa.loaded, loading: pa.loading, liked: pa.liked, coins: pa.coins,
                      folders: pa.folders ? pa.folders.length : -1 } : null;
    };

    function watchForWake() {
        /* Nothing is reported when the set goes away: the POST would be dialling
         * into a suspending network stack, and five of those are what puts the
         * report channel to sleep for five minutes. The wake line carries how
         * long it was gone, which says the same thing. */
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) { hiddenAt = new Date().getTime(); return; }
            var away = hiddenAt ? (new Date().getTime() - hiddenAt) : 0;
            hiddenAt = 0;
            if (away >= AWAY_MS) { wokeUp("回到前台（visibilitychange）", away); return; }
            /* 08-15, the first field sample: three hours suspended and the line
             * that came out was the heartbeat's. So this event either never
             * arrives on this firmware, or it arrives on the way back without
             * one on the way out, leaving nothing to measure the absence from —
             * and those two are worth telling apart, because the second means
             * the event is usable and the first means it is not. Silence in the
             * log now says "never arrives"; this line says "arrives, but". */
            report("lifecycle", "visibilitychange 说回到前台，记到的离开时长只有 " +
                   Math.round(away / 1000) + " 秒" + (away ? "" : "（一次 hidden 都没收到）"));
        });

        lastBeat = new Date().getTime();
        setInterval(function () {
            var now = new Date().getTime();
            var gap = now - lastBeat;
            lastBeat = now;
            if (gap > BEAT_MS + AWAY_MS) { wokeUp("心跳停跳（挂起过）", gap); }
        }, BEAT_MS);
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
        html += '<div class="krow acts">' +
                '<div class="key wide focusable" data-act="ime">中文输入</div>' +
                '<div class="key wide focusable" data-act="space">空格</div>' +
                '<div class="key wide focusable" data-act="del">删除</div>' +
                '<div class="key wide go focusable" data-act="go">搜索</div>' +
                '</div></div><div id="suggests" class="suggests"></div>' +
                '<div id="results"></div></div>';
        setScreen(html);

        /* Coming back from a video used to land on an empty keyboard with the
         * results thrown away, so finding one thing meant searching twice. */
        if (state.results && state.results.length) {
            paintResults(state.results);
        } else {
            paintSearchStarters();
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
        /* On 中文输入, not on "A". The letter grid cannot type Chinese at all,
         * so for the person this app is for it is the secondary keyboard —
         * landing on it meant four presses down before the first character of
         * every search. With results already painted (coming back from a
         * video), on the first result: the keyboard is collapsed then, and
         * Nav.reset does not check visibility — the ring used to land on a
         * display:none key and vanish. */
        if (state.results && state.results.length && screenEl.querySelector("#results .card")) {
            Nav.reset("#results .card");
        } else {
            Nav.reset('[data-act="ime"]');
        }
    }

    /* The on-screen letter grid cannot type Chinese. Focusing a real input
     * hands over to the television's own IME, which can — and which also gives
     * the user their usual keyboard rather than one invented here. */
    var imeOpen = false;

    /* Whether the last closeIme actually closed something — freshHome needs to
     * know, because closeIme's parting act is to put focus on a key. */
    var imeWasOpen = false;

    function closeIme(commit) {
        imeWasOpen = imeOpen;
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
         * remote stop responding entirely. On the IME key, which is in the
         * action row and stays visible when the keyboard is collapsed; ".key"
         * is the letter A, hidden then. */
        Nav.reset('[data-act="ime"]');
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

    /* What the search page offers before anything is typed (2026-09-28).
     * Typing on a remote is several presses per character and the IME is a
     * detour, so the cheapest search is one already typed: this account's own
     * recent terms, then bilibili's 热搜. Per account — someone else's
     * searches are not a suggestion, they are a disclosure. */
    var SEARCH_HISTORY_KEY = "bili.searchHistory.v1";
    var SEARCH_HISTORY_MAX = 12;
    var hotCache = { at: 0, list: null };

    function searchHistory() {
        try {
            var v = JSON.parse(localStorage.getItem(Accounts.scope(SEARCH_HISTORY_KEY)) || "[]");
            return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
    }
    function rememberSearch(term) {
        var list = searchHistory().filter(function (t) { return t !== term; });
        list.unshift(term);
        try {
            localStorage.setItem(Accounts.scope(SEARCH_HISTORY_KEY),
                                 JSON.stringify(list.slice(0, SEARCH_HISTORY_MAX)));
        } catch (e) {}
    }
    function clearSearchHistory() {
        try { localStorage.removeItem(Accounts.scope(SEARCH_HISTORY_KEY)); } catch (e) {}
    }

    /* Chips into the suggestion box, each searching its own text. */
    function paintChips(box, groups) {
        var html = "";
        for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            if (!grp.items.length) { continue; }
            html += '<div class="suggest-label">' + esc(grp.label) + '</div>';
            for (var i = 0; i < grp.items.length; i++) {
                html += '<div class="suggest focusable" data-s="' + esc(grp.items[i]) + '">' +
                        esc(grp.items[i]) + "</div>";
            }
            if (grp.clear) { html += '<div class="suggest clear focusable" data-clear="1">清空</div>'; }
        }
        box.innerHTML = html;
        var nodes = box.querySelectorAll(".suggest");
        for (var j = 0; j < nodes.length; j++) {
            (function (node) {
                node.onselect = function () {
                    if (node.getAttribute("data-clear")) {
                        clearSearchHistory();
                        paintSearchStarters();
                        Nav.reset('[data-act="ime"]');
                        return;
                    }
                    state.query = node.getAttribute("data-s");
                    el("qbox").textContent = state.query;
                    runSearch();
                };
            })(nodes[j]);
        }
    }

    function paintSearchStarters() {
        var box = el("suggests");
        if (!box || state.query.trim()) { return; }
        var mine = searchHistory();
        function paint(hot) {
            var b = el("suggests");
            if (!b || state.query.trim()) { return; }
            paintChips(b, [{ label: "最近搜过", items: mine, clear: true },
                           { label: "热搜", items: hot || [] }]);
        }
        var fresh = hotCache.list && new Date().getTime() - hotCache.at < 10 * 60 * 1000;
        paint(fresh ? hotCache.list : null);
        if (fresh) { return; }
        var token = viewToken;
        API.hotSearch(function (list) {
            hotCache = { at: new Date().getTime(), list: list };
            if (stillViewing(token)) { paint(list); }
        }, function (why) { report("search", "热搜拿不到（" + why + "）"); });
    }

    /* Suggestions are worth a lot on a remote, where every character is several
     * button presses — one press on a suggestion beats ten on the grid. */
    function loadSuggestions() {
        if (suggestTimer) { clearTimeout(suggestTimer); }
        var term = state.query.trim();
        var box = el("suggests");
        if (!box) { return; }
        if (term.length < 1) { paintSearchStarters(); return; }

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
        if (loadingMore || playing || optionsOpen || pendingNext) { return; }
        if (state.screen !== "search") { return; }
        if (!state.results || !focused || !focused.getAttribute) { return; }
        if (focused.getAttribute("data-i") === null) { return; }
        if (Number(focused.getAttribute("data-i")) < state.results.length - 6) { return; }
        /* Each arrow press among the last six cards lands here. Without these
         * two, an empty page (the end of the results) or a failed one was
         * asked for again on every press. */
        if (state.searchDone) { return; }
        if (state.searchRetryAt && new Date().getTime() < state.searchRetryAt) { return; }

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
            if (!fresh.length) { state.searchDone = true; return; }
            state.searchPage = next;
            state.results = state.results.concat(fresh);
            paintResults(state.results, true);
        }, function () {
            loadingMore = false;
            /* A failure is the link, not the end: ask again, but not before
             * five seconds have passed. */
            state.searchRetryAt = new Date().getTime() + 5000;
        });
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
        fitCardMeta(results);
        /* Fold the keyboard away once there is something to look at, so the
         * results are not buried under four rows of letters. */
        var kb = screenEl.querySelector(".keyboard");
        if (kb) { kb.className = "keyboard collapsed"; }
        var cards = results.querySelectorAll(".card");
        for (var j = 0; j < cards.length; j++) {
            (function (card, v) {
                card.__video = v;
                card.onselect = function () { playVideo(v); };
                bindCardAction(card, v);
            })(
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
        state.searchDone = false;
        state.searchRetryAt = 0;
        /* The term too, not just the view: Enter on the IME and a suggestion
         * picked right after are two searches under one view token, and the
         * slower one used to paint its results under the other's heading.
         * maybeLoadMoreSearch has guarded on the term all along. */
        var term = state.query.trim();
        API.search(term, 1, function (items) {
            if (!stillViewing(token) || state.query.trim() !== term) { return; }
            results = el("results");
            if (!results) { return; }
            if (!items.length) { results.innerHTML = '<div class="empty">没有结果</div>'; return; }
            rememberSearch(term);
            state.results = items;
            var first = paintResults(items);
            Nav.focus(first);
        }, function (why) {
            if (!stillViewing(token) || state.query.trim() !== term) { return; }
            results = el("results");
            if (results) { results.innerHTML = '<div class="empty">' + esc(loginNeeded(why) || ("搜索失败：" + why)) + '</div>'; }
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
        if (manageMode) {
            /* The mode is only reachable by pressing a button whose name does
             * not say what it does to anything, so it says it here. */
            html += '<div class="acc-note">选中要删除的账号，按确认键。' +
                    'TA 在这台电视上的观看记录会一起删掉，bilibili 上的账号不受影响。</div>';
        } else if (list.length) {
            html += '<div class="acc-note">每个账号的观看记录和推荐都是分开的，互相看不到。</div>';
        }
        setScreen(html + '</div>');

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
            /* Named for what it does. It used to say 管理账号, which is the kind
             * of label that makes a feature unfindable — the one thing the mode
             * offers is removal, and somebody looking for it asked for it to be
             * built. */
            box.innerHTML = '<div class="actions">' +
                '<div class="btn ghost focusable" id="btn-manage">' +
                (manageMode ? "完成" : "删除账号") + '</div></div>';
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
            /* Stay in the mode. Dropping out of it after each removal meant
             * clearing several rows was 管理账号 → 选 → 确认 → 管理账号 → 选 →
             * 确认, and the positions shift underneath between rounds, so the
             * second press lands on a different account than the one counted.
             * 完成 is how it ends. */
            report("account", "移除了 " + id + "（" + Diag.priv(label) + "），还剩 " +
                   Accounts.count() + " 个");
            /* Whether or not the removed account was the active one, the cached
             * feeds may be theirs — remove() promotes somebody else. */
            feedCache = {};
            /* Another account, another history. */
            serverHistory = { at: 0, items: null };
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

    /* Playback preferences apply to the television, including guest viewing.
     * Autoplay stays on unless switched off: it is how this app has always
     * behaved, and AUTOPLAY_UNATTENDED already stops a sleeping viewer's chain. */
    function autoNextEnabled() {
        return Settings.get("autoplayNext", true) === true;
    }

    function subtitlesEnabled() {
        return Settings.get("showSubtitles", false) === true;
    }

    /* 弹幕 (2026-10-18; danmaku.js does the fetching and drawing). One
     * setting for the television — off, sparse, standard, dense — shared by the
     * settings page and the row in the play panel. Fetched after the first
     * frame, like the subtitles and the rest of the metadata: it must not race
     * the stream for this set's slow link. */
    var DM_LEVELS = ["off", "low", "normal", "high"];
    var DM_NAMES = { off: "关", low: "少", normal: "标准", high: "多" };
    var DM_AREAS = ["top", "upper", "full"];
    /* Where they fly (PR #10, 10-25): a setting of this television, in 设置
     * only, like the level. "upper" is the 756px above the subtitles. */
    var DM_AREA_NAMES = { top: "顶部 1/4", upper: "避开字幕", full: "全屏" };
    var dm = null;            /* the renderer, built on first use */
    var viewerPaused = false; /* what setPaused last asked for; danmaku stop with it */
    function danmakuLevel() {
        var v = Settings.get("danmaku", "normal");
        return DM_NAMES[v] ? v : "normal";
    }
    function danmakuArea() {
        return Danmaku.area(Settings.get("danmakuArea", "upper"));
    }
    function showDanmaku(visible) {
        el("danmaku").className = Danmaku.areaClass(danmakuArea(), visible);
    }
    function setDanmakuArea(v) {
        Settings.set("danmakuArea", Danmaku.area(v));
        showDanmaku(!!(playing && playing.danmakuStarted && danmakuLevel() !== "off"));
        report("settings", "弹幕位置=" + DM_AREA_NAMES[danmakuArea()]);
    }
    function danmakuRenderer() {
        if (!dm && typeof Danmaku !== "undefined") {
            dm = Danmaku.renderer(el("danmaku"));
            dm.density(danmakuLevel());
        }
        return dm;
    }
    function clearDanmaku() {
        if (dm) { dm.clear(); dm.set([]); }
        showDanmaku(false);
    }
    function startDanmaku() {
        if (!playing || playing.danmakuStarted || danmakuLevel() === "off" || !danmakuRenderer()) { return; }
        var session = playing, t0 = new Date().getTime();
        session.danmakuStarted = true;
        Danmaku.load(session.cid, function (list) {
            if (playing !== session) { return; }
            dm.set(list);
            dm.rate(Player.rate());
            showDanmaku(true);
            report("danmaku", list.length + " 条（" + DM_NAMES[danmakuLevel()] + "），" + (new Date().getTime() - t0) + "ms");
        }, function (why) {
            if (playing === session) { report("danmaku", "弹幕取不到：" + why); }
        });
    }
    function setDanmakuLevel(v) {
        Settings.set("danmaku", v);
        /* What the panel's on/off switch turns back on to. */
        if (v !== "off") { Settings.set("danmakuOnLevel", v); }
        if (danmakuRenderer()) { dm.density(v); }
        if (v === "off") { showDanmaku(false); }
        else if (playing && playing.danmakuStarted) { showDanmaku(true); }
        else { startDanmaku(); }
        report("settings", "弹幕=" + DM_NAMES[v]);
    }

    function clearSubtitles() {
        el("subtitle-overlay").className = "hidden";
        el("subtitle-text").textContent = "";
    }

    function paintSubtitleAt(positionMs) {
        if (!playing || !subtitlesEnabled() || !playing.subtitleCues) { return; }
        var cues = playing.subtitleCues, secs = positionMs / 1000;
        var lo = 0, hi = cues.length - 1, found = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (cues[mid].from <= secs) { found = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        var value = found >= 0 && secs < cues[found].to ? cues[found].text : "";
        var text = el("subtitle-text");
        if (text.textContent !== value) { text.textContent = value; }
        el("subtitle-overlay").className = value ? "" : "hidden";
    }

    function startSubtitles() {
        if (!playing || !playing.timed || !subtitlesEnabled() ||
                playing.subtitleStarted || !playing.subtitleTracks) { return; }
        var session = playing, tracks = session.subtitleTracks, choice = null;
        /* Prefer human Chinese, then AI Chinese, then the first other language. */
        for (var i = 0; i < tracks.length; i++) {
            if (!tracks[i] || !tracks[i].subtitle_url) { continue; }
            var lang = String(tracks[i].lan || "").toLowerCase();
            var score = /^zh/.test(lang) ? (tracks[i].ai_type ? 2 : 3) : 1;
            if (!choice || score > choice.score) {
                choice = { url: tracks[i].subtitle_url, score: score,
                    label: tracks[i].lan_doc || lang };
            }
        }
        session.subtitleStarted = true;
        if (!choice) {
            /* Tracks listed, none with an address: player/v2 does this now and
             * then, and the same request seconds later has them — 10-18 the
             * selftest's probe and the app's own request for one video
             * disagreed twice in an evening, once each way, and the miss was
             * silent. One more ask. */
            if (tracks.length && !session.subtitleRetried) {
                session.subtitleRetried = true;
                report("subtitle", "字幕轨 " + tracks.length + " 条都没给地址，两秒后再问一次");
                setTimeout(function () {
                    if (playing !== session || !session.detail) { return; }
                    API.playerV2(session.detail.bvid, session.cid, function (r) {
                        if (playing !== session) { return; }
                        session.subtitleTracks = r.subtitles || [];
                        session.subtitleStarted = false;
                        startSubtitles();
                    }, function (why) {
                        if (playing === session) { report("subtitle", "再问字幕轨失败：" + why); }
                    });
                }, 2000);
            } else if (tracks.length) {
                report("subtitle", "再问一次还是没有地址，这次没有字幕");
            } else {
                /* 10-24: the selftest's own player/v2 listed a track for a video
                 * and its playback showed none, with not one subtitle line. One
                 * line a video, and only with subtitles switched on. */
                report("subtitle", "player/v2 没给字幕轨");
            }
            return;
        }
        API.subtitle(choice.url, function (cues) {
            if (playing !== session) { return; }
            session.subtitleCues = cues;
            report("subtitle", "已加载 " + choice.label + "，" + cues.length + " 条");
            paintSubtitleAt(lastKnownPosition);
        }, function (why) {
            if (playing === session) { report("subtitle", "字幕取不到：" + why); }
        });
    }

    function renderSettings() {
        newView();
        state.screen = "settings";
        markTab();
        Auth.cancelLogin();
        var account = Accounts.active();
        var session = account && account.session;
        var expiryNote = "未登录，去「我的」扫码";
        if (session) {
            expiryNote = "已登录";
            if (session.expiresAt && session.savedAt &&
                    session.expiresAt > session.savedAt) {
                var expiry = new Date(session.expiresAt);
                var pad = function (n) { return n < 10 ? "0" + n : String(n); };
                expiryNote = "登录有效期到 " + expiry.getFullYear() + "-" +
                    pad(expiry.getMonth() + 1) + "-" + pad(expiry.getDate());
            }
        }
        /* What is running — an update when there is one. An issue asks for the
         * version 「设置页最上面」, and that is the one that matters. */
        var version = "";
        try { version = Boot.info().running || ""; } catch (e) {}
        if (!version) {
            try { version = tizen.application.getCurrentApplication().appInfo.version || ""; }
            catch (e2) {}
        }
        setScreen('<div class="mine">' +
            '<div class="me"><div class="me-name">设置</div>' +
            '<div class="me-sub">' + (version ? "版本 " + esc(version) : "") + '</div></div>' +
            '<div class="section">账号</div>' +
            '<div class="me-sub" style="margin-top:12px">' + esc(expiryNote) + '</div>' +
            '<div class="section">播放</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-autoplay"></div>' +
            '<div class="btn focusable" id="btn-subtitles"></div>' +
            '<div class="btn focusable" id="btn-danmaku"></div>' +
            '<div class="btn focusable" id="btn-danmaku-area"></div></div>' +

            '<div class="section">画质</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-quality"></div></div>' +
            '<div class="me-sub" style="margin-top:24px">' + (Auth.isLoggedIn() ? "" : "没登录时清晰度更低，先去「我的」扫码登录就能用 1080P。") +
            '1080P 高码率和 4K 需要大会员，拿不到时用能拿到的最高一档。</div>' +
            '<div class="section">观看记录</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-clear-history">清空观看记录</div></div>' +
            '<div class="me-sub" style="margin-top:24px">只清这台电视上的，B 站账号里的历史不受影响。</div>' +
            '<div class="section">自动更新</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-autoupdate"></div>' +
            '<div class="btn focusable" id="btn-checkupdate">现在检查</div></div>' +
            '<div class="me-sub" id="update-status" style="margin-top:24px"></div>' +
            '<div class="section">诊断日志</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-diag"></div>' +
            '<div class="btn focusable" id="btn-diag-upload">上传诊断日志</div></div>' +
            '<div class="me-sub" id="diag-status" style="margin-top:24px"></div>' +
            '<div class="me-sub" style="margin-top:12px">出问题时把排查需要的日志传给开发者，不含个人隐私。报问题时附上这台电视的编号。</div>' +
            '<div class="section">浏览</div>' +
            '<div class="actions"><div class="btn focusable" id="btn-density"></div></div>' +

            '<div class="section">顶栏</div>' +
            '<div class="opt-row" id="bar-chips"></div>' +
            '<div class="me-sub" style="margin-top:24px">确认键拿起页签，左右键挪位置，下键拿掉，再按确认放下。</div>' +
            '<div class="section">可以加到顶栏的</div>' +
            '<div class="opt-row" id="spare-chips"></div>' +
            '<div class="me-sub" style="margin-top:24px">按确认加到顶栏。</div></div>');
        var button = el("btn-autoplay");
        function paint() {
            button.textContent = "自动播放下一个：" + (autoNextEnabled() ? "开" : "关");
        }
        paint();
        button.onselect = function () {
            Settings.set("autoplayNext", !autoNextEnabled());
            paint();
            report("settings", "自动播放下一个=" + (autoNextEnabled() ? "开" : "关"));
        };
        var subtitleButton = el("btn-subtitles");
        function paintSubtitles() {
            subtitleButton.textContent = "显示字幕：" + (subtitlesEnabled() ? "开" : "关");
        }
        paintSubtitles();
        subtitleButton.onselect = function () {
            Settings.set("showSubtitles", !subtitlesEnabled());
            paintSubtitles();
            report("settings", "显示字幕=" + (subtitlesEnabled() ? "开" : "关"));
        };
        var dmBtn = el("btn-danmaku");
        function paintDm() { dmBtn.textContent = "弹幕：" + DM_NAMES[danmakuLevel()]; }
        paintDm();
        dmBtn.onselect = function () {
            setDanmakuLevel(DM_LEVELS[(DM_LEVELS.indexOf(danmakuLevel()) + 1) % DM_LEVELS.length]);
            paintDm();
        };
        var dmAreaBtn = el("btn-danmaku-area");
        function paintDmArea() { dmAreaBtn.textContent = "弹幕位置：" + DM_AREA_NAMES[danmakuArea()]; }
        paintDmArea();
        dmAreaBtn.onselect = function () {
            setDanmakuArea(DM_AREAS[(DM_AREAS.indexOf(danmakuArea()) + 1) % DM_AREAS.length]);
            paintDmArea();
        };

        /* Self-update (update.js), in a few words: only what the viewer would
         * act on. Which host answered, and why a check failed, are in the log. */
        var upBtn = el("btn-autoupdate"), upStatus = el("update-status");
        function paintUpdate() {
            var st = Update.status(), line = "";
            upBtn.textContent = "自动更新：" + (st.enabled ? "开" : "关");
            if (!st.supported) { line = "这台电视不支持自动更新"; }
            else if (st.checking) { line = "正在检查…"; }
            else if (st.downloaded) { line = "新版本 " + st.downloaded + " 已下载，下次打开应用时生效"; }
            else if (!st.lastCheck) { line = ""; }
            else if (st.lastError) { line = "这次没查成，稍后会自动再试"; }
            else if (st.reinstall) { line = "有新版本，需要重新安装"; }
            else { line = "已是最新版本"; }
            upStatus.textContent = line;
        }
        paintUpdate();
        upBtn.onselect = function () {
            Update.setEnabled(!Update.enabled());
            paintUpdate();
            report("settings", "自动更新=" + (Update.enabled() ? "开" : "关"));
        };
        el("btn-checkupdate").onselect = function () {
            var view = viewToken;
            Update.check(function () { if (stillViewing(view)) { paintUpdate(); } });
            paintUpdate();
        };

        /* Diagnostics (diag.js): on or off, this set's code to quote in an
         * issue, and what the last upload did — the answer to pressing the
         * button is this line changing, not a toast. */
        var diagBtn = el("btn-diag"), diagStatus = el("diag-status");
        function paintDiag() {
            var st = Diag.status();
            diagBtn.textContent = "诊断日志：" + (st.enabled ? "开" : "关");
            if (!st.enabled) { diagStatus.textContent = "已关闭：什么都不记录，也不上传"; return; }
            var parts = ["这台电视的编号 " + st.device];
            if (!st.configured) { parts.push("这个版本不上传"); }
            if (st.sending) { parts.push("正在上传…"); }
            else if (st.last) {
                /* A refusal the viewer can act on is said; a network failure is not theirs to read. */
                parts.push(st.last.ok ? new Date(st.last.at).toTimeString().slice(0, 5) + " 已上传"
                    : /^(刚传过|正在上传|诊断日志关着)/.test(st.last.why) ? st.last.why : "没传上，稍后再试");
            }
            diagStatus.textContent = parts.join(" · ");
        }
        paintDiag();
        diagBtn.onselect = function () {
            Diag.setEnabled(!Diag.enabled());
            paintDiag();
            report("settings", "诊断日志=" + (Diag.enabled() ? "开" : "关"));
        };
        el("btn-diag-upload").onselect = function () {
            var view = viewToken;
            if (!Diag.enabled()) { diagStatus.textContent = "诊断日志关着，先把它打开"; return; }
            Diag.upload(function () { if (stillViewing(view)) { paintDiag(); } });
            paintDiag();
        };

        barPick = null;
        paintBarChips();

        var quality = el("btn-quality");
        function paintQuality() { quality.textContent = "画质上限：" + QN_LABELS[Settings.qnCap()]; }
        paintQuality();
        quality.onselect = function () {
            var steps = Settings.qnSteps(), at = steps.indexOf(Settings.qnCap());
            Settings.set("maxQn", steps[(at + 1) % steps.length]);
            paintQuality();
            report("settings", "画质上限=qn" + Settings.qnCap());
        };
        /* Two presses: it cannot be undone, and the button sits one row from
         * where a viewer scrolling the page passes. */
        var clearBtn = el("btn-clear-history"), clearArmed = 0;
        clearBtn.onselect = function () {
            var now = new Date().getTime();
            if (now - clearArmed > 3000) {
                clearArmed = now;
                clearBtn.textContent = "再按一次确认清空";
                return;
            }
            clearArmed = 0;
            Resume.clearAll();
            /* The home strip and 我的 are built from cached pages; drop them so
             * the next visit is built from the emptied list. */
            feedCache = {};
            mineLibraryCache = {};
            clearBtn.textContent = "已清空";
            report("settings", "清空观看记录（账号 " + activeAccountId() + "），本地记录删了，账号历史遮到 " +
                   new Date(Resume.clearedAt()).toTimeString().slice(0, 8));
        };
        var density = el("btn-density");
        function paintDensity() { density.textContent = "每行视频：" + gridColumns() + " 个"; }
        paintDensity();
        density.onselect = function () {
            Settings.set("gridColumns", gridColumns() === 5 ? 3 : gridColumns() + 1);
            applyGridDensity();
            /* Cached pages carry covers sized for the old width: refetch them
             * rather than stretch 344px images across a 576px card. */
            feedCache = {};
            mineLibraryCache = {};
            paintDensity();
            report("settings", "每行视频=" + gridColumns());
        };
        Nav.reset("#btn-autoplay");
        report("settings", "打开设置，自动播放下一个=" + (autoNextEnabled() ? "开" : "关"));
    }

    /* ---------------- mine / login ---------------- */

    var mineView = { kind: "history", id: 0, title: "" };
    var mineLibraryCache = {};

    function mineCacheKey() {
        return activeAccountId() + ":" + mineView.kind + ":" + (mineView.id || 0);
    }

    function openMineLibrary(kind, id, title) {
        mineView = { kind: kind, id: id || 0, title: title || "" };
        renderMineLibrary(false);
    }

    function renderMineLibrary(restore) {
        if (!Auth.isLoggedIn()) { mineView.kind = "history"; renderMine(); return; }
        state.screen = "mine";
        markTab();
        var token = newView();
        var accId = activeAccountId();
        var key = mineCacheKey();
        var cache = restore ? mineLibraryCache[key] : null;
        var kind = mineView.kind;
        var title = kind === "folders" ? "我的收藏" :
                    kind === "following" ? "关注的 UP 主" : mineView.title;

        setScreen('<div class="library-head">' +
            '<div class="btn ghost focusable" id="mine-back">返回</div>' +
            '<div class="me-name">' + esc(title) + '</div></div>' +
            '<div id="mine-library"><div class="empty">读取中…</div></div>');
        el("mine-back").onselect = function () {
            mineView = kind === "videos"
                ? { kind: "folders", id: 0, title: "" }
                : { kind: "history", id: 0, title: "" };
            renderMine();
        };
        Nav.reset("#mine-back");

        function paint(focusIndex) {
            if (!stillViewing(token) || activeAccountId() !== accId) { return; }
            var box = el("mine-library");
            if (!box || !cache) { return; }
            var list = cache.items;
            if (kind === "videos") {
                if (list.length) { paintCards(box, list); }
                else { box.innerHTML = '<div class="empty">这个收藏夹里没有可播放的视频</div>'; }
                var videos = box.querySelectorAll(".card");
                for (var v = 0; v < videos.length; v++) {
                    (function (card, index) {
                        card.onselect = function () {
                            cache.index = index;
                            cache.scrollTop = screenEl.scrollTop;
                            playVideo(list[index]);
                        };
                        bindCardAction(card, list[index], mineView.id);
                    })(videos[v], v);
                }
            } else {
                var html = '<div class="library-grid">';
                for (var i = 0; i < list.length; i++) {
                    var item = list[i];
                    html += '<div class="library-item focusable" data-i="' + i + '">' +
                        (kind === "following" && item.face
                            ? '<img class="library-face" src="' + esc(item.face) + '" alt="">'
                            : '<span class="library-symbol">' + (kind === "folders" ? "★" : "UP") + '</span>') +
                        '<span class="library-text"><strong>' +
                        esc(kind === "folders" ? item.title : item.name) + '</strong><small>' +
                        esc(kind === "folders" ? item.count + " 个视频" : item.sign) +
                        '</small></span></div>';
                }
                html += '</div>';
                if (!list.length) { html = '<div class="empty">' +
                    (kind === "folders" ? "还没有收藏夹" : "还没有关注 UP 主") + '</div>'; }
                box.innerHTML = html;
                var nodes = box.querySelectorAll(".library-item");
                for (var j = 0; j < nodes.length; j++) {
                    (function (node, index) {
                        node.onselect = function () {
                            cache.index = index;
                            cache.scrollTop = screenEl.scrollTop;
                            var entry = list[index];
                            if (kind === "folders") { openMineLibrary("videos", entry.id, entry.title); }
                            else { openUp(entry.mid, entry.name, entry.face); }
                        };
                    })(nodes[j], j);
                }
            }
            if (cache.more) {
                box.insertAdjacentHTML("beforeend", '<div class="actions library-more">' +
                    '<div class="btn focusable" id="mine-more">加载更多</div></div>');
                el("mine-more").onselect = function () { fetchMore(cache.page + 1, list.length); };
            }
            if (cache.limited) {
                box.insertAdjacentHTML("beforeend", '<div class="me-sub library-limit">' +
                    '当前接口最多显示前 250 位关注的 UP 主</div>');
            }
            if (focusIndex !== undefined && list.length) {
                var all = box.querySelectorAll(kind === "videos" ? ".card" : ".library-item");
                Nav.focus(all[Math.min(focusIndex, all.length - 1)]);
                if (restore && cache.scrollTop) { screenEl.scrollTop = cache.scrollTop; }
            }
        }

        function fail(why) {
            if (!stillViewing(token) || activeAccountId() !== accId) { return; }
            report("mine", kind + " 读取失败 " + why);
            if (cache && cache.items.length) { trouble("加载下一页失败：" + why); return; }
            delete mineLibraryCache[key];
            el("mine-library").innerHTML = '<div class="empty">读取失败：' + esc(why) + '</div>' +
                '<div class="actions"><div class="btn focusable" id="mine-retry">重试</div></div>';
            el("mine-retry").onselect = function () { renderMineLibrary(false); };
            Nav.focus(el("mine-retry"));
        }

        function fetchMore(page, focusIndex) {
            if (cache.loading) { return; }
            cache.loading = true;
            var done = function (items, more, limited) {
                if (!stillViewing(token) || activeAccountId() !== accId) { return; }
                cache.loading = false;
                cache.items = cache.items.concat(items);
                cache.page = page;
                cache.more = !!more;
                cache.limited = !!limited;
                paint(focusIndex === undefined ? cache.index : focusIndex);
            };
            var failed = function (why) { cache.loading = false; fail(why); };
            if (kind === "videos") {
                API.favoriteVideos(mineView.id, page, function (items, more) { done(items, more); }, failed);
            } else {
                API.followings(Accounts.active().mid, page, done, failed);
            }
        }

        if (cache) { paint(cache.index || 0); return; }
        cache = { items: [], page: 0, more: false, limited: false,
                  index: 0, scrollTop: 0, loading: false };
        mineLibraryCache[key] = cache;
        if (kind === "folders" || kind === "following") {
            var account = Accounts.active();
            if (!account || !account.mid) { fail("未取得当前账号的 UID，请重新进入“我的”"); return; }
            if (kind === "folders") {
                API.favoriteFolders(account.mid, function (items) {
                    if (!stillViewing(token) || activeAccountId() !== accId) { return; }
                    cache.items = items;
                    paint(items.length ? 0 : undefined);
                }, fail);
            } else { fetchMore(1, 0); }
        } else { fetchMore(1, 0); }
    }

    function renderMine() {
        if (mineView.kind !== "history") { renderMineLibrary(true); return; }
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
        setScreen('<div class="mine"><div class="empty">检查登录状态…</div></div>');

        /* Started here rather than from inside the nav callback. The two have
         * nothing to say to each other, and one after the other meant this
         * screen — which is opened to look at a list — spent two round trips
         * showing "检查登录状态…" and then "读取中…". Usually it is already in
         * hand, because startup fetched it. */
        var mine = null, shown = null;
        var hist = { done: false, items: null, raw: 0, why: "" };

        function paintHistory() {
            if (!hist.done || !shown || !stillViewing(token)) { return; }
            var h = el("hist");
            if (!h) { return; }

            if (!hist.items) {
                report("history", "服务端历史读取失败：" + hist.why);
                var note = el("hist-note");
                /* The local list stands on its own, so a failed request is a
                 * footnote rather than an error screen — unless there is no
                 * local list, in which case it is the whole story. */
                if (!mine.length) {
                    h.innerHTML = '<div class="empty">读取失败：' + esc(hist.why) + '</div>';
                } else if (note) {
                    note.innerHTML = '<div class="empty">手机 / 网页端的记录没读到（' +
                                     esc(hist.why) + '），下面只是这台电视上的</div>';
                }
                return;
            }

            /* The newest title goes in the line too. A count alone says the
             * request worked, not that the answer is current — and "is what the
             * television has the same as what my phone shows" is the only
             * question this log line ever gets asked. */
            report("history", "服务端历史 " + hist.raw + " 条，可打开的 " + hist.items.length +
                " 条" + (hist.items.length ? "，最新一条：" + Diag.priv(hist.items[0].title.slice(0, 24)) : ""));

            /* Repainting moves the ground under whoever is already looking. The
             * card under the ring is found again by bvid, because its position
             * in the list is exactly what the merge just changed. */
            var cur = Nav.current();
            var keep = "";
            if (cur && cur.getAttribute && cur.getAttribute("data-i") !== null) {
                var was = shown[Number(cur.getAttribute("data-i"))];
                keep = was ? was.bvid : "";
            }

            shown = capHistory(mergeHistory(mine, hist.items));
            if (!shown.length) {
                h.innerHTML = '<div class="empty">' + (hist.raw
                    ? "bilibili 上这 " + hist.raw + " 条都不是普通视频（番剧/直播/专栏），这里打不开"
                    : "还没有看过什么") + '</div>';
                return;
            }
            var ki = -1;
            for (var kj = 0; keep && kj < shown.length; kj++) {
                if (shown[kj].bvid === keep) { ki = kj; break; }
            }
            /* Deep enough to hold the card the ring was on, and the row after it. */
            histGrid.reset(shown, Math.max(histPage(), ki + 1 + gridColumns()));
            if (ki >= 0) { Nav.focus(h.querySelectorAll(".card")[ki]); }
        }

        /* Painted on the first page and on the last, not on all three. Each
         * paint rebuilds up to a hundred cards from innerHTML — a hundred
         * <img> elements queued down a pipe that serves one request at a time —
         * and re-runs the focus-recovery loop, so the ring hops as the list
         * re-sorts under it. First page: the screen fills in one round trip.
         * Last page: it is as deep as it is going to get. The middle one buys
         * nothing anybody can see. */
        var histPaints = 0;
        fetchServerHistory(function (items, raw, done) {
            hist.done = true; hist.items = items; hist.raw = raw;
            if (histPaints === 0 || done) { histPaints++; paintHistory(); }
        }, function (why) {
            hist.done = true; hist.items = null; hist.why = why;
            paintHistory();
        });

        API.nav(function (me) {
            /* A slow nav landing after the viewer switched account or tab used
             * to repaint the screen they had left, under the wrong name. */
            if (!stillViewing(token)) { return; }
            /* Refused when the answer is about a different mid — see describe(). */
            if (me.isLogin && Accounts.describe(accId, me)) { paintAccount(); }

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
            if (me.isLogin) {
                html += '<div class="actions library-links">' +
                    '<div class="btn focusable" id="mine-favorites">我的收藏</div>' +
                    '<div class="btn focusable" id="mine-following">关注的 UP 主</div></div>';
            }
            html += '<div class="section">观看历史</div><div id="hist"></div>' +
                    '<div id="hist-note"></div></div>';
            setScreen(html);
            if (me.isLogin) {
                el("mine-favorites").onselect = function () { openMineLibrary("folders"); };
                el("mine-following").onselect = function () { openMineLibrary("following"); };
            }

            /* The local store keeps 300; asking for 40 was throwing away most of
             * it. One card per video after the merge, so a set that watches a
             * 24-part series produces one card for the lot — 40 looked like a
             * generous cap and read on the sofa as "the history is too short". */
            mine = Resume.recent(200);
            shown = capHistory(mergeHistory(mine, []), HISTORY_FIRST_PAINT);
            var h0 = el("hist");
            if (h0) {
                if (shown.length) { histGrid.reset(shown, histPage()); }
                else {
                    /* "读取中…" only when something is actually on its way. With
                     * an expired session nothing follows this, and the message
                     * would have sat there for the rest of the evening. */
                    h0.innerHTML = '<div class="empty">' + (me.isLogin
                        ? "读取中…" : "这台电视上还没有看过什么") + '</div>';
                }
            }
            /* The list may already be waiting — it is fetched in parallel with
             * this, and startup usually has it in hand before either. */
            if (me.isLogin) { paintHistory(); }

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
                    mineLibraryCache = {};
                    mineView = { kind: "history", id: 0, title: "" };
                    /* Another account, another history. */
                    serverHistory = { at: 0, items: null };
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

        }, function (why) {
            if (!stillViewing(token)) { return; }
            setScreen('<div class="empty">无法检查登录状态：' + esc(why) + '</div>');
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

        setScreen('<div class="login">' +
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
            '<div class="login-right" id="qrbox"></div></div>');

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
                report("login", "扫码完成 via=" + s.via +
                       "，bilibili 给的 mid=" + (s.mid || "未给") +
                       "，落在账号 " + (s.accId || "?") +
                       (s.created ? "（新建的一行）" : "（并入已有的这一行）") +
                       (s.into ? "，是指定重登 " + s.into : "") +
                       "，账号数=" + Accounts.count());
                toast("登录成功");
                feedCache = {};
                /* Another account, another history. */
                serverHistory = { at: 0, items: null };
                state.query = "";
                state.results = null;
                paintAccount();
                refreshActiveProfile();
                whoami("登录后");
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
                    /* No toast (2026-09-28): the part label on the player says
                     * which part this is, and 「手机上看到 P7」 is an
                     * explanation nobody asked for. The log keeps it. */
                    if (pages0[k].page > 1) {
                        report("player", "续播选 P" + pages0[k].page + "（" +
                               (elsewhere ? "手机上的进度" : "本机记录") + "）");
                    }
                    return handoff.cid;
                }
            }
        }

        if (!last || !last.cid || last.cid === detail.cid) { return detail.cid; }

        var pages = detail.pages || [];
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].cid === last.cid) {
                report("player", "续播选 P" + pages[i].page + "（本机记录）");
                return last.cid;
            }
        }
        /* Opened straight from a feed card, which carries only the first part's
         * cid and no part list. The stored cid can only have come from playing
         * this very video, so it is trustworthy even without the list. */
        if (!pages.length) {
            if (last.page) { report("player", "续播选 P" + last.page + "（本机记录，卡片没带分 P 列表）"); }
            return last.cid;
        }
        return detail.cid;
    }

    /* ---------------- asked before the button is pressed ----------------
     *
     * The web player looks instant partly because it is not doing the same
     * work: the playurl answer is inlined in the page's HTML, and the page has
     * long since touched the CDN. Here both were paid after the press — ~270ms
     * of playurl + player/v2, then a first CDN response (req1→resp1 in the
     * 到画面 line) of ~900ms whenever the edge does not hold the file, and
     * ~70ms when it does.
     *
     * So a card the ring rests on is asked about before anyone presses it: the
     * same three requests play() makes, plus one small range into each of
     * the two files Shaka will open first (see warmCdn for why per file).
     * play() takes the entry once (a second press asks afresh — the answer
     * has been used) and a failed prefetch simply asks again, so the worst
     * case is exactly the old path.
     *
     * The limits are the CDN's per-IP burst limit (see CLAUDE.md, 限流): a
     * dwell before anything is sent, a floor between two prefetches, and each
     * file warmed at most once in five minutes. Walking across a row sends
     * nothing. */
    var PREFETCH_DWELL = 400;   /* 800 missed: pressed 814ms after landing, prefetch sent 14ms before */
    var PREFETCH_GAP = 800;    /* 1500 missed a press 1.17s after the neighbour was prefetched; the per-minute cap below bounds bursts now */
    var PREFETCH_TTL = 5 * 60 * 1000;
    var PREFETCH_MAX = 4;
    var prefetched = {};
    var prefetchTimer = 0;
    var lastPrefetchAt = 0;
    var lastPrefetchBvid = "";   /* so 预取=无 can say "never sent" from "sent for another card" */
    /* A per-minute ceiling on top of the gap: slow browsing at the gap alone
     * is 3 api + 2 CDN requests every 1.5s, and both hosts have limiters
     * (api answers 412 on view from this network already; the CDN's cooldown
     * tripped at ~20 requests on 08-02). Ten a minute covers any real choice. */
    var PREFETCH_PER_MIN = 20;   /* 10 was hit while browsing (2026-09-28: 「撞了每分钟 10 次的上限」 on the card then pressed) */
    var prefetchTimes = [];
    /* The video just watched. Leaving playback lands the ring back on its
     * card, and the dwell would ask about it all over again — for a video
     * the viewer has just finished with. */
    var justPlayed = "";
    /* The last card a dwell asked about and was turned down for, and why — so
     * 预取=无 can tell "pressed too fast" from "the ceiling said no". */
    var lastSkip = null;
    var warmedAt = {};      /* file (url without query) -> when it was warmed */

    function prefetchKey(bvid, cid) {
        /* Per account: playurl's tiers and player/v2's position both depend on
         * whose access_key signed the request. */
        return bvid + ":" + cid + "@" + Accounts.activeId();
    }

    /* One request whose answer may be wanted before or after it arrives. */
    function prefetchSlot(fetcher) {
        var s = { done: false, ok: false, val: undefined, waiters: [] };
        function settle(ok, val) {
            if (s.done) { return; }
            s.done = true; s.ok = ok; s.val = val;
            var w = s.waiters; s.waiters = [];
            for (var i = 0; i < w.length; i++) { w[i][ok ? 0 : 1](val); }
        }
        fetcher(function (v) { settle(true, v); }, function (why) { settle(false, why); });
        return s;
    }

    /* Asynchronous even when the answer is already in: play() was written
     * against callbacks that arrive after it returns, and decide() running in
     * the middle of play() would be a new ordering nobody has tested. */
    function whenSettled(s, onOk, onFail) {
        if (!s.done) { s.waiters.push([onOk, onFail]); return; }
        setTimeout(function () { (s.ok ? onOk : onFail)(s.val); }, 0);
    }

    function prunePrefetch(now) {
        var keys = [];
        for (var k in prefetched) {
            if (!prefetched.hasOwnProperty(k)) { continue; }
            if (now - prefetched[k].at > PREFETCH_TTL) { delete prefetched[k]; }
            else { keys.push(k); }
        }
        keys.sort(function (a, b) { return prefetched[a].at - prefetched[b].at; });
        while (keys.length >= PREFETCH_MAX) { delete prefetched[keys.shift()]; }
    }

    /* One small range into each of the two files Shaka will open first —
     * init segment and segment index together, since those are its first
     * two asks of every file. Per *file*, not per host: 2026-09-28 the first
     * version warmed one file per host and the next card's first response
     * still took 890ms two seconds later on that same warm host, while a
     * file the edge happened to hold answered in 74ms. What is cold is the
     * file at the CDN edge, not the connection. Results ride on the entry
     * so the 到画面 line can say what this card's own warm-up did. */
    /* Whether a prefetch may go out now. Browsing, the chooser screen — and,
     * since 2026-09-28, the player's own panel while the video underneath is
     * steady: picking the next video from 相关推荐 mid-playback was that
     * evening's most-used route and the only one still at 2.5–3s. A few KB
     * against a player pulling 0.5–2 MB segments; what must not happen is a
     * prefetch during a rescue, feeding a limiter that is already refusing. */
    function prefetchAllowed() {
        return !playing || (optionsOpen && Player.steady());
    }

    /* The references of a sidx box starting at `start` in `buf`: byte size and
     * duration of every segment, and where the first one begins in the file. */
    function sidxRefs(buf, start) {
        var dv = new DataView(buf);
        if (start + 32 > buf.byteLength) { return null; }
        var size = dv.getUint32(start);
        if (String.fromCharCode(dv.getUint8(start + 4), dv.getUint8(start + 5),
                                dv.getUint8(start + 6), dv.getUint8(start + 7)) !== "sidx") { return null; }
        /* size(4) type(4) version(1) flags(3) reference_ID(4) timescale(4),
         * then earliest_presentation_time and first_offset — 4 bytes each in
         * version 0, 8 in version 1 — then reserved(2) reference_count(2). */
        var ver = dv.getUint8(start + 8);
        var ts = dv.getUint32(start + 16), first, p;
        if (ver === 0) { first = dv.getUint32(start + 24); p = start + 28; }
        else { first = dv.getUint32(start + 32); p = start + 36; }   /* low 32 bits: files here are < 4 GB */
        var count = dv.getUint16(p + 2);
        p += 4;
        var refs = [];
        for (var i = 0; i < count && p + 12 <= buf.byteLength; i++, p += 12) {
            refs.push({ size: dv.getUint32(p) & 0x7fffffff, dur: dv.getUint32(p + 4) / ts });
        }
        return { anchor: start + size + first, refs: refs };
    }

    /* The experiment (2026-09-28) for a start from a resume point, whose
     * segment sits deep in a file the edge has never read (4.1s of stall at
     * 1:40 that evening): the first 64 KB of that segment — does a partial
     * range make the edge hold the segment? Judged on 媒体1 in 到画面.
     *
     * Its twin was dropped the same night: the chooser's queued video had
     * its whole first segment (0.5–1 MB) fetched during the countdown, and
     * two autoplay starts with it (1452 / 1353ms, loaded→playing 907 / 782)
     * matched the ones without (1278 / 1431ms, ~800) — the ~0.8s after
     * load() is the decoder's first frame, not the download. */
    function warmDeeper(e, rep, buf) {
        var idx = rep.segments && rep.segments.index;
        if (!idx || !buf) { return; }
        var sx = sidxRefs(buf, Number(idx.split("-")[0]));
        if (!sx || !sx.refs.length) { return; }
        var posMs = 0;
        var r = e.resume && e.resume.done && e.resume.ok ? e.resume.val : null;
        if (r && r.cid === e.cid) { posMs = r.positionMs || 0; }
        posMs = Math.max(posMs, Resume.positionMs(e.bvid, e.cid) || 0);
        var at = sx.anchor, t = 0, i = 0, label, from, to;
        if (posMs >= 30000) {
            while (i < sx.refs.length - 1 && t + sx.refs[i].dur <= posMs / 1000) {
                t += sx.refs[i].dur; at += sx.refs[i].size; i++;
            }
            label = "续播点段"; from = at; to = at + Math.min(65535, sx.refs[i].size - 1);
        } else { return; }
        var w = { label: label, status: 0, ms: -1 }, t0 = new Date().getTime();
        e.warm.push(w);
        var xhr = new XMLHttpRequest();
        try {
            xhr.open("GET", rep.urls[0], true);
            xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
            xhr.timeout = 10000;
            xhr.onloadend = function () {
                w.status = xhr.status;
                w.ms = new Date().getTime() - t0;
                w.label = label + "(" + Math.round((to - from + 1) / 1024) + "KB)";
            };
            xhr.send();
        } catch (ex) {}
    }

    function warmCdn(e, dash) {
        if (!prefetchAllowed() || !dash) { return; }
        var first = Mpd.peek(dash, Settings.qnCap());
        var reps = [["视频", first.video], ["音频", first.audio]];
        var now = new Date().getTime();
        e.warm = [];
        for (var i = 0; i < reps.length; i++) {
            (function (label, rep) {
                var url = rep && rep.urls && rep.urls[0];
                if (!url || !rep.segments) { return; }
                var file = url.split("?")[0];
                if (warmedAt[file] && now - warmedAt[file] < PREFETCH_TTL) { return; }
                warmedAt[file] = now;
                var end = rep.segments.index.split("-")[1];
                var w = { label: label, status: 0, ms: -1 };
                e.warm.push(w);
                var xhr = new XMLHttpRequest();
                try {
                    xhr.open("GET", url, true);
                    xhr.setRequestHeader("Range", "bytes=0-" + end);
                    if (label === "视频") { xhr.responseType = "arraybuffer"; }
                    xhr.timeout = 5000;
                    xhr.onloadend = function () {
                        w.status = xhr.status;
                        w.ms = new Date().getTime() - now;
                        if (xhr.status === 403) { warmRefused(e, label); }
                        if (xhr.status === 206 && label === "视频" && !playing) {
                            try { warmDeeper(e, rep, xhr.response); } catch (ex) {}
                        }
                    };
                    xhr.send();
                } catch (ex) {}
            })(reps[i][0], reps[i][1]);
        }
        for (var f in warmedAt) {
            if (warmedAt.hasOwnProperty(f) && now - warmedAt[f] > PREFETCH_TTL) { delete warmedAt[f]; }
        }
    }

    /* A warm-up answered 403: the web token is refused for this video. */
    function warmRefused(e, label) {
        if (e.warmRefused) { return; }
        e.warmRefused = label + " 403";
        noteWebRefused();
        startEagerStrong(e);
    }

    function startEagerStrong(e) {
        if (!e.eager || !e.warmRefused || e.strong || playing || !e.aid ||
                !Auth.isLoggedIn() || !Auth.accessKey()) { return; }
        var aid = e.aid, cid = e.cid;
        e.strong = prefetchSlot(function (ok, fail) {
            API.playurlDashStrong(aid, cid, Settings.qnCap(), ok, fail, Player.badFilesFor(cid));
        });
    }

    function prefetchCard(v, eager) {
        if (!v || !v.bvid || !v.cid || !prefetchAllowed()) { return; }
        var now = new Date().getTime();
        var wait = PREFETCH_GAP - (now - lastPrefetchAt);
        var key = prefetchKey(v.bvid, v.cid);
        var had = prefetched[key];
        if (had && now - had.at < PREFETCH_TTL) {
            /* The chooser's queued card may already have been dwell-prefetched
             * (or reach here second through its own focus): upgrade it. */
            if (eager && !had.eager) { had.eager = true; startEagerStrong(had); }
            return;
        }
        if (wait > 0) {
            /* One pending prefetch at a time: without the clear, the dwell
             * timer set by the same focus move could no longer be cancelled. */
            clearTimeout(prefetchTimer);
            prefetchTimer = setTimeout(function () { prefetchCard(v, eager); }, wait);
            return;
        }
        if (v.bvid === justPlayed) { lastSkip = { bvid: v.bvid, why: "刚播过" }; return; }
        while (prefetchTimes.length && now - prefetchTimes[0] > 60000) { prefetchTimes.shift(); }
        if (prefetchTimes.length >= PREFETCH_PER_MIN) {
            lastSkip = { bvid: v.bvid, why: "撞了每分钟 " + PREFETCH_PER_MIN + " 次的上限" };
            return;
        }
        prefetchTimes.push(now);
        prunePrefetch(now);
        lastPrefetchAt = now;
        lastPrefetchBvid = v.bvid;
        var bvid = v.bvid, cid = v.cid;
        /* `eager`: the chooser screen's queued video, which is about to play
         * unless the viewer stops it — a web-token 403 in its warm-up starts
         * the strong-token mint right there, inside the countdown. */
        var e = { at: now, aid: v.aid || 0, bvid: v.bvid, cid: v.cid, eager: !!eager };
        e.dash = prefetchSlot(function (ok, fail) { API.playurlDash(bvid, cid, Settings.qnCap(), ok, fail); });
        e.prog = prefetchSlot(function (ok, fail) { API.playurlProgressive(bvid, cid, Settings.qnCap(), ok, fail); });
        e.resume = prefetchSlot(function (ok, fail) { API.playerV2(bvid, cid, ok, fail); });
        prefetched[key] = e;
        /* A video whose lesson says the web token is refused would only 403
         * the warm-up — exactly the refused traffic the limiter punishes. */
        var hint = Player.strongHint(cid);
        if (!hint) {
            whenSettled(e.dash, function (dash) { warmCdn(e, dash); }, function () {});
        } else if (eager) {
            /* Already known without a warm-up: the lesson is the 403. Mint
             * inside the countdown; play() picks it up on its lesson path. */
            e.aid = e.aid || hint;
            e.warmRefused = "教训";
            startEagerStrong(e);
        }
    }

    /* Called on every focus move: only a card the ring stays on gets asked. */
    function schedulePrefetch(elm) {
        clearTimeout(prefetchTimer);
        var v = elm && elm.__video;
        if (!v) { return; }
        if (!prefetchAllowed()) {
            lastSkip = { bvid: v.bvid, why: optionsOpen
                ? "播放中且不稳：" + Player.steadyWhy() : "播放中（面板没开）" };
            return;
        }
        prefetchTimer = setTimeout(function () { prefetchCard(v); }, PREFETCH_DWELL);
    }

    function takePrefetch(bvid, cid) {
        var key = prefetchKey(bvid, cid), e = prefetched[key];
        delete prefetched[key];
        if (!e || new Date().getTime() - e.at > PREFETCH_TTL) { return null; }
        return e;
    }

    /* API.playurlDashStrong with a voice. The mint can take minutes without a
     * word (15 header reads, two at a time, 15s timeout and a retry each), and
     * the one time it did, the only witness was a banner complaining it could
     * not hide. So at 8s and 20s it says where it is — app endpoint, codecs
     * query, or which header reads — and says how long it took when it ends.
     * Behaviour is untouched: this only reports. */
    function mintStrong(aid, cid, qn, onOk, onFail, webDash) {
        var t0 = new Date().getTime(), finished = false;
        var bvid = (playing && playing.detail && playing.detail.bvid) || "";
        var slow = [8000, 20000], timers = [];
        for (var i = 0; i < slow.length; i++) {
            timers.push(setTimeout(function () {
                if (finished) { return; }
                report("player", "强令牌还没铸好 " + bvid + " —— " + API.strongProgress());
            }, slow[i]));
        }
        function end() {
            finished = true;
            for (var j = 0; j < timers.length; j++) { clearTimeout(timers[j]); }
            var took = new Date().getTime() - t0;
            if (took >= 8000) { report("player", "强令牌花了 " + took + "ms 才有结果 " + bvid); }
        }
        API.playurlDashStrong(aid, cid, qn,
            function (d) { end(); onOk(d); },
            function (why) {
                end();
                /* 87007 is 充电专属 (10-20, BV19GM36GEno: is_upower_exclusive). */
                if (/code 87007\b/.test(String(why)) && playing && playing.cid === cid) { playing.upowerOnly = true; }
                onFail(why);
            },
            Player.badFilesFor(cid), webDash || null);
    }

    /* Why a video would not play, when bilibili has said so in a form a viewer
     * can act on — every 「播放失败」 exit asks this before it leaves. */
    function chargeOnly() {
        return !!(playing && (playing.upowerOnly || (playing.detail && playing.detail.upowerOnly)));
    }

    /* When a web token was last refused, on any video (C, 2026-10-20). On 10-20
     * both of the first two videos were refused — one at load, one eleven
     * seconds in — and each paid 1–3 s of 403 → blacklist → rebuild before the
     * strong token, which the next video then paid all over again. Inside this
     * window a new video mints the strong token from the start instead; each
     * fresh refusal extends it, and once it lapses the next video tries the web
     * token again, so a day the CDN stops refusing costs one refusal to notice. */
    var webRefusedAt = 0;
    var WEB_REFUSED_WINDOW = 15 * 60 * 1000;
    function noteWebRefused() { webRefusedAt = new Date().getTime(); }

    /* The strong manifest is in hand but cannot be swapped in under the
     * playing one (B could not cover every file it may ask for): one ordinary
     * rebuild on it from where the viewer is — a second or two of spinner,
     * against 10-20 16:37's partial swap, which ended in a minute of stalls. */
    function rebuildOnStrong(sess, sd, aid, why) {
        var atMs = Player.hasPosition() ? Player.position() : (lastKnownPosition || sess.startMs || 0);
        sess.triedStrong = true;
        if (sess.dashReady) { sess.dashReady.strongTried = true; }
        sess.failed = false;
        sess.startMs = atMs;
        el("player-loading").className = "";
        Player.startTiming();
        sess.timed = false;
        sess.timedLabel = "到画面(强令牌)";
        report("player", why + "，改用强令牌从 " + fmt(atMs) + " 整个重建");
        Player.stop();
        sess.dashReady = sd;
        Player.learnStrong(sess.cid, aid);
        var rep = Player.pickDashVideo(sd);
        playDash(sd, (rep && rep.id) || Settings.qnCap());
    }

    /* The press behind the next play(), for the 到画面 line's 按下起 (D). The
     * player's own clock restarts at every rescue, so a start that went web →
     * 403 → strong printed playing=2122ms after five seconds on the sofa. */
    var pressAt = 0;

    function playVideo(v, fromPanel) {
        pressAt = new Date().getTime();
        if (!fromPanel) { rememberPosition(); backStack = []; }
        if (v.live) { openLive(v); return; }

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
                author: v.author, mid: v.mid || 0, face: v.face || "",
                duration: v.duration, play: v.play,
                desc: "", pages: []
            };
            /* Through resumeCid like every other entry — its "feed card, no
             * part list" branch was written for exactly this card and was
             * unreachable from here, so a 24-part upload last watched at P7
             * reopened from 推荐 at P1 0:00. */
            play(provisional, resumeCid(provisional));
            return;
        }

        var token = newView();
        showOpening(v);
        API.view(v.bvid, function (d) {
            if (!stillViewing(token)) { return; }
            opening = false;
            play(d, resumeCid(d));
        }, function (why) {
            if (!stillViewing(token)) { return; }
            cancelOpening();
            trouble(loginNeeded(why) || ("打开失败：" + why));
        });
    }

    /* A card without a cid (搜索, 动态, UP 主页, 收藏夹…) has to ask view() for
     * one before anything can play. That round trip used to show a toast,
     * 「正在打开…」, which then sat under the picture for its full four seconds
     * once the video was up (the viewer, 10-18: 「点开一个视频，不要在下方显示
     * 正在打开」). Now the player's own loading screen comes up at once with the
     * card's title — the same thing a card that carries its cid shows — so the
     * press still visibly does something. Until view() answers, keys are held
     * back from the grid behind it and 返回 goes back to that grid. */
    var opening = false;
    function showOpening(v) {
        opening = true;
        el("shell").className = "veiled";
        el("loading-title").textContent = v.title || "";
        el("loading-status").textContent = "";
        el("player-loading").className = "";
    }
    function cancelOpening() {
        if (!opening) { return; }
        opening = false;
        newView();   /* a late view() answer must not start the video anyway */
        el("player-loading").className = "hidden";
        el("shell").className = "";
    }

    /* ---------------- 直播 (2026-10-18) ----------------
     *
     * A room is opened from a card on the 直播 tab and owns the screen until
     * 返回. Kept apart from `playing` on purpose: everything keyed on that —
     * resume points, history reports, the scrub, the banner's hide logic, the
     * panel, danmaku, subtitles, the recovery ladders — belongs to a video
     * with a length, and none of it means anything at the live edge.
     *
     * 上 / 下 change room, through the list the card came from, the way a
     * television changes channel. A stream that fails is reconnected with a
     * fresh address (they are signed and expire), the other CDN host first;
     * three failures without a good minute in between and the room is left.
     * No live danmaku yet: that is a WebSocket of its own, left for later. */
    var liveRoom = null;
    var liveUiTimer = null;
    var LIVE_HINT = "确认键 暂停/播放 · 上下键 换直播间 · 返回键 退出";
    var LIVE_PAUSE_LIMIT = 20000;   /* a live window is seconds wide; longer than this, start at the edge again */
    /* Tizen 3.0 (issue #5, 10-22): on-demand DASH plays through MSE, but every
     * live room failed with the element's decode error (Shaka 3016, data[0]=3)
     * — the live fMP4 has audio and video muxed in one stream where on-demand
     * keeps them apart, and 原画 is 1080p High@5.0; which of the two the engine
     * refuses is not known. Whatever it is, the native player sidesteps it.
     *
     * Issue #7, 10-24 (Tizen 4.0, 1.4.2): there MSE played one room's 原画 and
     * failed the next one's the same way, with the same codec string and size
     * — so it is the stream, not the set, and not the muxing. That set's AVPlay
     * played nothing (fMP4 never left prepare, both TS hosts silent), and one
     * decode error had moved the whole session onto it: every room after it
     * failed, the first one too. Now a decode error steps this room down a
     * tier, still on MSE (at most twice); when no tier decodes, this room goes
     * to AVPlay — and the session with it only while MSE has not shown one live
     * picture yet (liveMseOk). A session on AVPlay whose AVPlay has nothing for
     * a room tries MSE on it once (room.mseTry); a picture there brings later
     * rooms back to MSE first. Not kept across launches.
     *
     * Which playlist AVPlay gets: TS, from the first host whose playlist
     * answers. TS is weather — on 10-22 one room's TS was 404 on one host and
     * silent on the other while its fMP4 answered everywhere, and AVPlay given
     * the silent one sat in prepare with neither picture nor error; hence the
     * look at the playlist first and a deadline on the picture. On the Tizen
     * 3.0 set (10-22, 1.3.6) TS played two rooms out of three; the third's 原画
     * TS was PLAYER_ERROR_NOT_SUPPORTED_FORMAT, and fMP4 on that AVPlay never
     * left prepare, three times. So a TS tier that fails before its first
     * picture steps down a tier, still TS, and fMP4 is the last resort, given
     * up for the session the first time AVPlay cannot start it. "Before its
     * first picture" means before AVPlay's clock moves (LIVE_NATIVE_STALL).
     *
     * A room with TS and no fMP4 goes to AVPlay on any set, without turning
     * liveNative on: Shaka has nothing to play, AVPlay has. Until 10-23 that
     * room was 「没有 HLS-fMP4 的流」 and closed (issue #7, a Tizen 4.0 set).
     * So does a room whose playlist Shaka finds nothing playable in (4032,
     * LIVE_UNSUPPORTED): reconnecting fetched the same refusal three times.
     *
     * AVPlay is given the room's HTTP-FLV first, then TS, then fMP4 (10-24).
     * The Tizen 3.0 set, one morning on 1.4.2/1.4.3: 65 rooms closed with both
     * TS hosts silent, 25 played. Nearly all of the closed ones offer only
     * 原画 — TS and FLV, no fMP4 — and from here their TS playlist did not
     * answer in 20 s, four rooms of four, while their FLV sent its first bytes
     * within two seconds. Those rooms closed on every set, not only that one:
     * with no fMP4 there is nothing for MSE either. Of the eight biggest rooms
     * that evening, the FLV on d1--ov-gotcha07 answered and the TS was silent
     * or answered; the FLV on d1--ov-gotcha05 was 403 and the TS answered.
     * On the Tizen 9 set AVPlay played an FLV 原画 (1080p, H.264) with its
     * clock moving half a second after prepare. Whether Tizen 3.0's AVPlay
     * plays FLV is not known yet: one room failing it turns FLV off for the
     * run (liveFlvDead).
     *
     * MSE is tried on a room once (room.mseTry) only while it can still turn
     * out to work: after two rooms in which no tier decoded and none played,
     * it is not tried again this run (the Tizen 3.0 set went through three
     * MSE starts on every room AVPlay could not play, on 1.4.3, and none ever
     * decoded). */
    var liveNative = false;
    var liveMseOk = false;          /* MSE has shown a live picture this session */
    var liveMseFails = 0;           /* rooms in which no tier decoded on MSE, while liveMseOk is false */
    var liveFmp4Dead = false;       /* AVPlay could not start HLS-fMP4 this session */
    var liveFlvDead = false;        /* AVPlay could not start HTTP-FLV this session */
    var liveNativeForce = "";       /* selftest only: "ts" | "fmp4" | "none" (AVPlay is given nothing) | "tsdead" (no TS playlist answers) */
    var liveFailTsOnce = false;     /* selftest only: the next TS start reports NOT_SUPPORTED_FORMAT */
    var liveNoFmp4 = false;         /* selftest only: every room answers as if it had TS and no fMP4 */
    var liveFail4032Once = false;   /* selftest only: the next Shaka start reports 4032 */
    var liveFailDecodeOnce = false; /* selftest only: the next Shaka start reports 3016 */
    var LIVE_DECODE_FAIL = /code=3016 .*data\[0\]=[34](?!\d)|媒体元素出错 code=[34](?!\d)/;
    /* Shaka's CONTENT_UNSUPPORTED_BY_BROWSER: nothing in this room's playlist
     * is playable here. 10-23 one room on the Tizen 9 set, four times running,
     * every other room fine — so this room goes to AVPlay, not the session. */
    var LIVE_UNSUPPORTED = /code=4032 /;
    var LIVE_NATIVE_WAIT = 15000;
    /* For AVPlay 「到画面」 only means prepared. 10-22 evening, 1.3.6/1.3.7 on the
     * Tizen 3.0 set: 「部分直播不能播放」 and not one upload — whatever those rooms
     * did never reached an exit that reports. So after the picture its clock
     * has to move: still for this long counts as a failure. */
    var LIVE_NATIVE_STALL = 10000;
    /* ...except a first start that AVPlay says it is buffering: HLS-fMP4 原画 took
     * 6–9.5 s here before its clock moved, and one 10.2 s start (10-22, 1.3.8
     * selftest) was read as "fMP4 cannot play" and closed the room. */
    var LIVE_NATIVE_FIRST_BUFFER = 20000;

    function openLive(v) {
        var cache = feedCache[state.screen];
        var list = (cache && cache.items) || [v];
        var index = list.indexOf(v);
        if (index < 0) { list = [v]; index = 0; }
        liveRoom = { list: list, index: index, tries: 0, token: 0, item: null,
                     qnName: "", pausedAt: 0, timed: false, failing: false, okTimer: null,
                     nativeFmt: "", nativeFor: "", qnAsk: 0, qnUsed: 0, qnAccept: [], tsBelow: 0, tsGaveUp: false, steps: 0,
                     timedAt: 0, moved: false, clockPos: -1, clockMovedAt: 0, bufAt: 0, mseRefused: false, mseSteps: 0, mseTry: false,
                     tsSilent: false, flvGaveUp: false };
        startLiveRoom("");
    }

    function startLiveRoom(why) {
        var room = liveRoom;
        if (!room) { return; }
        var v = room.list[room.index];
        var token = ++room.token;
        room.item = v;
        room.qnName = "";
        room.nativeFmt = "";
        room.timed = false;
        room.moved = false;
        room.clockPos = -1;
        room.bufAt = 0;
        room.failing = false;
        /* What either route learned is about this room's streams. */
        if (room.nativeFor !== String(v.roomid)) {
            room.nativeFor = String(v.roomid);
            room.qnAsk = 0;
            room.tsBelow = 0;
            room.tsGaveUp = false;
            room.steps = 0;
            room.mseRefused = false;
            room.mseSteps = 0;
            room.mseTry = false;
            room.tsSilent = false;
            room.flvGaveUp = false;
        }
        el("shell").className = "veiled";
        el("pause-glyph").className = "hidden";
        el("loading-title").textContent = v.title || v.author || "";
        el("loading-status").textContent = why || "";
        el("player-loading").className = "";
        showLiveUi();
        Player.startTiming();
        API.livePlay(v.roomid, function (p) {
            if (liveRoom !== room || token !== room.token) { return; }
            if (liveNoFmp4) { p.urls = []; p.shape = "（自测：当作没有 HLS-fMP4）" + p.shape; }
            room.qnName = p.urls.length ? p.qnName : p.tsQnName;
            var url = p.urls.length ? p.urls[room.tries % p.urls.length] : "";
            function open(qnName, codec, how, u, note) {
                report("live", "开 " + v.roomid + "（" + Diag.priv(v.author) + "）" + qnName + " " + codec + how +
                       (p.signed ? "，带账号" : "，不带账号") + "，可选 " + p.accept.join("/") +
                       "，主机 " + (u.split("/")[2] || "?") + (why ? "（" + why + "）" : "") + (note || ""));
                paintLiveUi();
            }
            function mse(note) {
                room.qnUsed = p.qn;
                room.qnAccept = p.acceptQn;
                open(p.qnName, p.codec, "", url, note);
                Player.playLive(url);
                var fake = liveFail4032Once ? "直播：加载失败 code=4032 category=4 severity=2（自测造的）" :
                           liveFailDecodeOnce ? "直播：shaka code=3016 category=3 severity=2 data[0]=3（自测造的）" : "";
                liveFail4032Once = liveFailDecodeOnce = false;
                if (fake) {
                    setTimeout(function () {
                        if (liveRoom === room && token === room.token && !room.timed) { onLiveEvent("error", fake); }
                    }, 0);
                }
                /* 10-24 selftest: a host answering the playlist 403 is only a
                 * recoverable error to Shaka, retried for as long as anyone
                 * waits — thirty seconds of spinner and no exit. The same
                 * deadline as AVPlay's; the reconnect takes the other host. */
                setTimeout(function () {
                    if (liveRoom === room && token === room.token && !room.timed && !Player.userPaused()) {
                        onLiveEvent("error", "直播：MSE " + (LIVE_NATIVE_WAIT / 1000) + " 秒没出画面");
                    }
                }, LIVE_NATIVE_WAIT);
            }
            if ((!liveNative || room.mseTry) && url && !room.mseRefused) { mse(""); return; }
            /* No fMP4 for Shaka: the FLV and TS are AVPlay's on any set (issue #7). */
            if (!url) { report("live", "房间 " + v.roomid + " 没有 HLS-fMP4，给的是 " + p.shape); }
            function native(fmt, u, note) {
                if (liveRoom !== room || token !== room.token) { return; }
                var ts = fmt === "HLS-TS", flv = fmt === "HTTP-FLV";
                room.nativeFmt = fmt;
                room.qnUsed = ts ? p.tsQn : flv ? p.flvQn : p.qn;
                room.qnAccept = ts ? p.tsAcceptQn : flv ? p.flvAcceptQn : p.acceptQn;
                room.qnName = ts ? p.tsQnName : flv ? p.flvQnName : p.qnName;
                open(room.qnName, ts ? p.tsCodec : flv ? p.flvCodec : p.codec, " " + fmt + " 走 AVPlay", u, note);
                Player.playLiveNative(u);
                if (ts && liveFailTsOnce) {
                    liveFailTsOnce = false;
                    setTimeout(function () {
                        if (liveRoom === room && token === room.token && !room.timed) {
                            onLiveEvent("error", "PLAYER_ERROR_NOT_SUPPORTED_FORMAT（自测造的）");
                        }
                    }, 0);
                }
                /* AVPlay can sit in prepare forever without an error. */
                setTimeout(function () {
                    if (liveRoom === room && token === room.token && !room.timed) {
                        onLiveEvent("error", "直播：AVPlay " + (LIVE_NATIVE_WAIT / 1000) + " 秒没出画面（" + fmt + "）");
                    }
                }, LIVE_NATIVE_WAIT);
                /* ...and after the picture, its clock has to move (LIVE_NATIVE_STALL). */
                var watch = setInterval(function () {
                    if (liveRoom !== room || token !== room.token || room.failing) { clearInterval(watch); return; }
                    if (!room.timed) { return; }
                    var t = new Date().getTime();
                    if (Player.userPaused()) { room.clockMovedAt = t; return; }
                    var limit = !room.moved && room.bufAt ? LIVE_NATIVE_FIRST_BUFFER : LIVE_NATIVE_STALL;
                    if (t - room.clockMovedAt > limit) {
                        clearInterval(watch);
                        onLiveEvent("error", "直播：AVPlay " + (room.moved ? "放着放着 " : "到画面之后 ") + (limit / 1000) +
                                    " 秒时间没走（" + fmt + " " + room.qnName + (room.bufAt ? "，一直在缓冲" : "") + "）");
                    }
                }, 1000);
            }
            /* What AVPlay is given, in order: the room's HTTP-FLV, its TS, its
             * fMP4; each from the first host that answers, each skipped once it
             * has failed in this room. FLV first (10-24): from here it answered
             * in 0.1–2.7 s wherever the TS was silent, and where it is refused
             * (d1--ov-gotcha05, 403 at once) the TS answered — so either way the
             * room starts without the eight seconds of waiting on two silent
             * TS playlists. */
            function viaFlv(note) {
                var hosts = [], said = [], i;
                for (i = 0; i < p.flvUrls.length; i++) { hosts.push(p.flvUrls[(room.tries + i) % p.flvUrls.length]); }
                function next(k) {
                    if (liveRoom !== room || token !== room.token) { return; }
                    if (k >= hosts.length) {
                        room.flvGaveUp = true;
                        viaTs(note + "（HTTP-FLV " + said.join("；") + "）");
                        return;
                    }
                    peekStream(hosts[k], "flv", function (ok, what) {
                        if (ok) { native("HTTP-FLV", hosts[k], note + (said.length ? "（前一台 " + said.join("；") + "）" : "")); return; }
                        said.push((hosts[k].split("/")[2] || "?") + " " + what);
                        next(k + 1);
                    });
                }
                next(0);
            }
            function viaTs(note) {
                /* Asked for a lower tier and given the one that failed: no loop. */
                if (room.tsBelow && p.tsQn >= room.tsBelow) {
                    report("live", "要了低于 qn" + room.tsBelow + " 的 TS，给的还是 qn" + p.tsQn + "，这个直播间不再试 TS");
                    room.tsGaveUp = true;
                }
                var tsUrls = room.tsGaveUp || room.tsSilent ? [] : p.tsUrls;
                if (!tsUrls.length) {
                    withoutTs(note + (room.tsGaveUp ? "（这个直播间的 TS 各档都试过了）" : room.tsSilent ? "（HLS-TS 的清单刚才都没回）" : "（没给 HLS-TS）"));
                    return;
                }
                /* Starting from the host this reconnect is due, then the other. */
                var order = [], said = [], i;
                for (i = 0; i < tsUrls.length; i++) { order.push(tsUrls[(room.tries + i) % tsUrls.length]); }
                if (liveNativeForce === "ts") { native("HLS-TS", order[0], "（自测指定）"); return; }
                function nextHost(k) {
                    if (liveRoom !== room || token !== room.token) { return; }
                    if (k >= order.length) {
                        /* Not looked at again in this room: silent for this long it has
                         * stayed silent (20 s, four rooms, 10-24), and a reconnect that
                         * waits on it again is eight more seconds of black. */
                        room.tsSilent = true;
                        withoutTs(note + "（HLS-TS 的清单 " + said.join("；") + "）");
                        return;
                    }
                    if (liveNativeForce === "tsdead") { said.push((order[k].split("/")[2] || "?") + " 当作没回（自测）"); nextHost(k + 1); return; }
                    peekStream(order[k], "m3u8", function (ok, what) {
                        if (ok) { native("HLS-TS", order[k], note + (said.length ? "（前一台 " + said.join("；") + "）" : "")); return; }
                        said.push((order[k].split("/")[2] || "?") + " " + what);
                        nextHost(k + 1);
                    });
                }
                nextHost(0);
            }
            function withoutTs(note) {
                if (!liveFmp4Dead && url && liveNativeForce !== "none") { native("HLS-fMP4", url, note); return; }
                var lacks = note + (!url ? "（也没有 HLS-fMP4）" : liveFmp4Dead ? "（HLS-fMP4 这次运行里 AVPlay 起不来）" : "");
                /* The session is on AVPlay because of some other room; this
                 * one MSE has not refused. */
                if (liveNative && url && !room.mseRefused && !room.mseTry && (liveMseOk || liveMseFails < 2)) {
                    room.mseTry = true;
                    mse("（AVPlay 放不了它" + lacks + "，试一次 MSE）");
                    return;
                }
                report("live", "房间 " + v.roomid + " 没有 AVPlay 放得了的流" + lacks);
                stopLive();
                trouble("这个直播间现在放不了");
            }
            if (liveNativeForce === "fmp4" && url) { native("HLS-fMP4", url, "（自测指定）"); return; }
            if (liveNativeForce === "none") { withoutTs("（自测：当作 AVPlay 什么都放不了）"); return; }
            /* The selftest's TS steps are about TS: as if this room's FLV had failed. */
            if (liveNativeForce === "ts" || liveFailTsOnce) { room.flvGaveUp = true; }
            if (liveFlvDead || room.flvGaveUp || !p.flvUrls.length) {
                viaTs(liveFlvDead ? "（HTTP-FLV 这次运行里 AVPlay 起不来）" : !p.flvUrls.length ? "（没给 HTTP-FLV）" : "");
                return;
            }
            viaFlv("");
        }, function (whyNot, shape) {
            if (liveRoom !== room || token !== room.token) { return; }
            report("live", "房间 " + v.roomid + " 取不到流：" + whyNot + (shape ? "（" + shape + "）" : ""));
            stopLive();
            /* A room that has ended is not a failure (10-24: a set woke after
             * thirteen hours in a room, reconnected, and sent the log in). */
            if (/^没在直播/.test(String(whyNot))) { toast("这个直播间现在没在直播"); return; }
            trouble("这个直播间现在放不了：" + whyNot);
        }, room.qnAsk);
    }

    /* The next tier below `used` in a room's accept list; 0 when there is none. */
    function lowerQn(accept, used) {
        var lower = 0;
        for (var q = 0; q < accept.length; q++) {
            if (accept[q] < used && accept[q] > lower) { lower = accept[q]; }
        }
        return lower;
    }

    /* Does a playlist answer as one — or an FLV start with its signature —
     * within four seconds? For choosing what AVPlay is given: it has no way
     * to say "this address is dead" itself. An FLV never ends, so it is let
     * go as soon as its first bytes are in. */
    function peekStream(url, kind, done) {
        var finished = false, xhr = null;
        /* Its own timer, not xhr.timeout: a timed-out request reaches
         * readyState 4 with status 0 before ontimeout, and would read 连不上. */
        var timer = setTimeout(function () {
            end(false, "4 秒没回");
            try { xhr.abort(); } catch (e) {}
        }, 4000);
        function end(ok, what) {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            done(ok, what);
        }
        try {
            xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.onreadystatechange = function () {
                if (kind === "flv" && xhr.readyState === 3 && xhr.status === 200 && String(xhr.responseText || "").length >= 3) {
                    var head = String(xhr.responseText).slice(0, 3);
                    end(head === "FLV", head === "FLV" ? "200" : "答的不是 FLV");
                    try { xhr.abort(); } catch (e) {}
                    return;
                }
                if (xhr.readyState !== 4) { return; }
                if (xhr.status === 200 && (kind === "flv" ? /^FLV/ : /^#EXTM3U/).test(xhr.responseText || "")) { end(true, "200"); }
                else { end(false, xhr.status ? "答 HTTP " + xhr.status : "连不上"); }
            };
            xhr.send();
        } catch (e) { end(false, "发不出去：" + (e && e.message)); }
    }

    function onLiveEvent(kind, data) {
        var room = liveRoom;
        if (kind === "playing") {
            el("player-loading").className = "hidden";
            el("loading-status").textContent = "";
            if (!room.timed) {
                room.timed = true;
                room.timedAt = room.clockMovedAt = new Date().getTime();
                report("live", "到画面 " + Player.timings());
                showLiveUi();
                if (Player.mode() === "live") {
                    liveMseOk = true;
                    if (liveNative) {
                        liveNative = false;
                        report("live", "MSE 放得了这个直播间，之后的直播间先走 MSE");
                    }
                }
            }
            /* A good minute buys the reconnect budget back. */
            if (room.okTimer) { clearTimeout(room.okTimer); }
            room.okTimer = setTimeout(function () { if (liveRoom === room) { room.tries = 0; } }, 60000);
        } else if (kind === "time") {
            /* AVPlay's clock (oncurrentplaytime). Two different readings is
             * playing; the watchdog in startLiveRoom reads clockMovedAt. */
            if (!room.nativeFmt || !data) { return; }
            var pos = data.position || 0, tNow = new Date().getTime();
            if (pos === room.clockPos) { return; }
            if (room.clockPos >= 0 && !room.moved) {
                room.moved = true;
                report("live", "AVPlay 时间开始走了（" + room.nativeFmt + " " + room.qnName + "，到画面后 " +
                       (room.timedAt ? tNow - room.timedAt : 0) + "ms）");
            }
            room.clockPos = pos;
            room.clockMovedAt = tNow;
        } else if (kind === "buffering") {
            el("live-hint").textContent = data ? "缓冲中…" : LIVE_HINT;
            if (data) { showLiveUi(); }
            /* AVPlay only: Shaka's live path logs its own. One line per stall, at its end. */
            if (room.nativeFmt) {
                if (data) { room.bufAt = room.bufAt || new Date().getTime(); }
                else if (room.bufAt) {
                    /* With a 3 s buffer AVPlay reports a stream of 20–70 ms blips nobody sees. */
                    var bufMs = new Date().getTime() - room.bufAt;
                    if (bufMs >= 500) { report("live", "AVPlay 缓冲了 " + bufMs + "ms（" + room.nativeFmt + " " + room.qnName + "）"); }
                    room.bufAt = 0;
                }
            }
        } else if (kind === "error") {
            if (room.failing) { return; }   /* one failure, one reconnect */
            room.failing = true;
            report("live", data);
            if (room.okTimer) { clearTimeout(room.okTimer); room.okTimer = null; }
            /* Not a reconnect: the same room again a tier down or on the other
             * player, with the budget untouched and nothing new on the screen. */
            var decode = LIVE_DECODE_FAIL.test(String(data));
            if (Player.mode() === "live" && !room.mseRefused && (decode || LIVE_UNSUPPORTED.test(String(data)))) {
                var down = decode && room.mseSteps < 2 ? lowerQn(room.qnAccept, room.qnUsed) : 0;
                Player.stop();
                if (down) {
                    room.mseSteps++;
                    room.qnAsk = down;
                    report("live", "MSE 解不了 " + room.qnName + "（qn" + room.qnUsed + "），这个直播间降到 qn" + down + " 再试");
                    startLiveRoom("");
                    return;
                }
                room.mseRefused = true;
                if (decode && !liveMseOk) { liveMseFails++; }
                var what = decode ? "MSE 哪一档都解不了" : "这个直播间的流 MSE 放不了（4032）";
                if (room.mseTry) {
                    report("live", what + "，AVPlay 也放不了，这个直播间放不了");
                    stopLive();
                    trouble("这个直播间现在放不了");
                    return;
                }
                if (decode && !liveMseOk && !liveNative) {
                    liveNative = true;
                    report("live", what + "，这次运行 MSE 还没放出过直播，这个和之后的直播间都改走 AVPlay");
                } else {
                    report("live", what + "，这个直播间改走 AVPlay");
                }
                startLiveRoom("");
                return;
            }
            /* A native start that never reached a picture says something about
             * the stream, not the network: step the TS down a tier (no reconnect
             * spent), and when TS has no tier left, or fMP4 will not start,
             * remember it. */
            if (Player.mode() === "avplay" && !room.moved && /NOT_SUPPORTED|秒没出画面|时间没走/.test(String(data))) {
                /* Prepared and never moving is this tier being too much, on
                 * either playlist: step down. Not starting at all, or refusing
                 * the format, is this player and fMP4 (the Tizen 3.0 set). */
                var stuck = /时间没走/.test(String(data));
                if (room.nativeFmt === "HLS-fMP4" && !stuck) { liveFmp4Dead = true; }
                /* FLV not starting at all is this player and FLV: the next
                 * route for this room right away, no reconnect spent. */
                if (room.nativeFmt === "HTTP-FLV" && !stuck) {
                    liveFlvDead = true;
                    room.flvGaveUp = true;
                    report("live", "HTTP-FLV AVPlay 起不来，这次运行不再给它");
                    Player.stop();
                    startLiveRoom("");
                    return;
                }
                if (room.nativeFmt === "HLS-TS" || stuck) {
                    var lower = lowerQn(room.qnAccept, room.qnUsed);
                    /* At most three steps a room: a server that answers a lower ask
                     * with the same tier must not turn this into a loop. */
                    if (lower && room.steps < 3) {
                        room.steps++;
                        report("live", room.nativeFmt + " " + room.qnName + "（qn" + room.qnUsed + "）AVPlay 放不了，这个直播间降到 qn" + lower + " 再试");
                        room.qnAsk = lower;
                        if (room.nativeFmt === "HLS-TS") { room.tsBelow = room.qnUsed; }
                        Player.stop();
                        startLiveRoom("");
                        return;
                    }
                    if (room.nativeFmt === "HLS-TS") { room.tsGaveUp = true; }
                }
            }
            if (++room.tries > 3) {
                stopLive();
                trouble("直播断了，重新连了三次也没接上");
                return;
            }
            Player.stop();
            setTimeout(function () {
                if (liveRoom === room) { startLiveRoom("信号不稳，正在重新连接…"); }
            }, 1000);
        }
    }

    function liveKey(k) {
        switch (k) {
            case Nav.KEY.ENTER:
            case Nav.KEY.PLAY_PAUSE:
                setLivePaused(!Player.userPaused()); return true;
            case Nav.KEY.PLAY:
                if (Player.userPaused()) { setLivePaused(false); } return true;
            case Nav.KEY.PAUSE:
                if (!Player.userPaused()) { setLivePaused(true); } return true;
            case Nav.KEY.UP:
            case Nav.KEY.DOWN:
                switchLive(k === Nav.KEY.DOWN ? 1 : -1); return true;
            case Nav.KEY.RETURN:
                stopLive(); return true;
            case Nav.KEY.EXIT:
                return false;
            default:
                showLiveUi(); return true;
        }
    }

    function setLivePaused(on) {
        var room = liveRoom;
        if (on) {
            Player.pause();
            room.pausedAt = new Date().getTime();
            el("pause-glyph").className = "";
            showLiveUi();
            return;
        }
        el("pause-glyph").className = "hidden";
        /* What was live when the pause began has scrolled out of the window;
         * there is nothing to carry on from, so start again at the edge. */
        if (room.pausedAt && new Date().getTime() - room.pausedAt > LIVE_PAUSE_LIMIT) {
            room.pausedAt = 0;
            report("live", "暂停超过 " + LIVE_PAUSE_LIMIT / 1000 + " 秒，从现在的画面重新开");
            Player.stop();
            startLiveRoom("");
            return;
        }
        room.pausedAt = 0;
        Player.resume();
        showLiveUi();
    }

    function switchLive(step) {
        var room = liveRoom, next = room.index + step;
        if (next < 0 || next >= room.list.length) {
            toast(step < 0 ? "已经是第一个直播间了" : "已经是这一页的最后一个直播间了");
            showLiveUi();
            return;
        }
        room.index = next;
        room.tries = 0;
        room.pausedAt = 0;
        if (room.okTimer) { clearTimeout(room.okTimer); room.okTimer = null; }
        Player.stop();
        startLiveRoom("");
    }

    function stopLive() {
        var room = liveRoom;
        if (!room) { return; }
        if (room.okTimer) { clearTimeout(room.okTimer); }
        liveRoom = null;
        Player.stop();
        hideLiveUi();
        el("pause-glyph").className = "hidden";
        el("player-loading").className = "hidden";
        el("shell").className = "";
        /* Back on the card of the room last watched, which after 上 / 下 is
         * not the one that was opened. */
        var cache = feedCache[state.screen];
        if (cache && cache.items === room.list) { cache.index = room.index; }
        report("live", "退出直播间 " + (room.item ? room.item.roomid : ""));
        if (payOwedWake()) { return; }
        showScreen(state.screen, true);
    }

    function paintLiveUi() {
        var v = liveRoom && liveRoom.item;
        if (!v) { return; }
        var meta = [];
        if (v.author) { meta.push(v.author); }
        if (v.area) { meta.push(v.area); }
        if (v.online) { meta.push(v.online); }
        if (liveRoom.qnName) { meta.push(liveRoom.qnName); }
        el("live-title").textContent = v.title || "";
        el("live-meta").textContent = meta.join(" · ");
        el("live-hint").textContent = LIVE_HINT;
    }
    function showLiveUi() {
        if (!liveRoom) { return; }
        paintLiveUi();
        el("live-ui").className = "";
        if (liveUiTimer) { clearTimeout(liveUiTimer); }
        liveUiTimer = setTimeout(liveUiTick, 4000);
    }
    function liveUiTick() {
        liveUiTimer = null;
        /* Stays up while paused: the banner is what says so. */
        if (liveRoom && Player.userPaused()) { liveUiTimer = setTimeout(liveUiTick, 1000); return; }
        el("live-ui").className = "hidden";
    }
    function hideLiveUi() {
        if (liveUiTimer) { clearTimeout(liveUiTimer); liveUiTimer = null; }
        el("live-ui").className = "hidden";
    }

    function startProgressive(r) {
        /* Which route is actually carrying this video. `downgrade()` only means
         * anything coming off progressive, and there was nothing to ask. */
        playing.route = "progressive";
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

    var qualityText = "";
    /* Quality, and the speed when it is not 1x — a video playing fast with
     * nothing on screen saying so reads as a fault. */
    function setQualityBadge(text) {
        qualityText = text || "";
        var r = Player.rate();
        var full = qualityText + (r !== 1 ? (qualityText ? " · " : "") + r + "x" : "");
        var b = el("player-quality");
        b.textContent = full;
        b.className = full ? "" : "hidden";
    }

    var HINT = "确认键 播放/暂停 · 左右 快退/快进 · 下键 简介/相关 · 返回键 退出";
    var chromeTimer = null;
    var bufferNoticeTimer = null;   /* a stall that outlasts this brings the banner back */

    /* A paused video should read as paused from the sofa, not just by a frozen
     * number in the corner. */
    function setPaused(paused) {
        viewerPaused = !!paused;
        if (dm) { dm.pause(viewerPaused); }
        if (paused) {
            Player.pause();
            el("pause-glyph").className = "";
            if (!commentsView && !episodeView) { el("playerui").className = ""; }
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

        /* The next part, then the next episode of the 合集, before anything
         * the recommender thinks of: the uploader numbered them for a reason
         * (2026-10-18). The 合集 only once the parts have run out — an episode
         * can itself have parts. The panel's 下一集 asks the same function
         * (episode-nav.js, PR #9), so the two cannot disagree. */
        var adj = EpisodeNav.adjacent(d, cid, 1);
        if (adj && adj.kind === "part") {
            cb({ detail: d, cid: adj.cid, title: "P" + (adj.index + 1) + "  " + d.pages[adj.index].part });
            return;
        }
        if (adj) {
            var ep = d.season.episodes[adj.index];
            cb({ detail: seasonEpisodeDetail(ep), cid: ep.cid,
                 title: "合集第 " + (adj.index + 1) + " 集  " + ep.title });
            return;
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

    /* The player forgets the length the moment it is torn down, and a 403
     * rescue tears it down for seconds before the rebuild — keys pressed in
     * between still deserve a bar to scrub along. */
    function knownDurationMs() { return Player.durationMs() || lastKnownDuration; }

    function scrubStep() {
        /* 10s, then 30s, then a minute, then a thirtieth of the video: on a long
         * upload the last tier is what makes crossing it bearable. */
        var n = scrub.presses;
        var dur = knownDurationMs();
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
        if (!knownDurationMs()) { return; }
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
        var dur = knownDurationMs();
        scrub.target = Math.max(0, Math.min(dur ? dur - 2000 : Infinity,
                                            scrub.target + dir * scrubStep()));
        paintScrub();
        if (scrub.timer) { clearTimeout(scrub.timer); }
        /* Commit on a pause in input rather than on a separate confirm press:
         * one button, one meaning. */
        scrub.timer = setTimeout(commitScrub, 700);
    }

    function paintScrub() {
        var dur = knownDurationMs() || 1;
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
        /* Between Player.stop() and the rebuilt manifest (a 403 rescue, an
         * expiry refetch) there is no element to seek, and the rebuild starts
         * from playing.startMs — so that is where the jump goes. Sent to the
         * player instead it was dropped: the TV selftest of 2026-10-18 pressed
         * a 3:30 jump one second into a strong-token rescue, and the picture
         * came back at 0:46, where the rescue had begun. */
        if (playing && !Player.mode()) {
            playing.startMs = target;
            lastKnownPosition = target;
            report("player", "拖动落在重建当中，重建改从 " + fmt(target) + " 起");
            return;
        }
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
    var commentsView = null;
    var commentsToken = 0;

    function commentId(row) { return String(row.rpid_str || row.rpid || ""); }

    function commentHtml(row, index) {
        var name = (row.member || {}).uname || "用户";
        var content = (row.content || {}).message || "";
        var replies = Number(row.rcount || row.count || 0);
        var liked = Number(row.action) === 1;
        var likes = Number(row.like) || 0;
        return '<div class="comment-item focusable" data-comment-index="' + index + '">' +
            '<div class="comment-author">' + esc(name) + '</div>' +
            '<div class="comment-date">' + esc(publishedDate(row.ctime)) + '</div>' +
            '<div class="comment-text">' + esc(content) + '</div>' +
            '<div class="comment-foot"><span class="' + (liked ? 'comment-liked' : '') +
            '">♥ ' + likes + ' 次赞' + (liked ? ' · 已赞' : '') + '</span>' +
            (!commentsView.root && replies ?
                '<span class="comment-replies">' + replies + ' 条回复 ›</span>' : '') +
            '</div></div>';
    }

    function commentRows() {
        return commentsView.root ? commentsView.children : commentsView.roots;
    }

    function paintComments(focusIndex) {
        if (!commentsView) { return; }
        var rows = commentRows(), html = "";
        for (var i = 0; i < rows.length; i++) { html += commentHtml(rows[i], i); }
        if (!html) {
            html = '<div class="comment-item focusable" id="comments-empty">' +
                esc(commentsView.loading ? "正在加载评论…" :
                    (commentsView.error || "这里还没有评论")) + '</div>';
        }
        el("comments-list").innerHTML = html;
        el("comments-title").textContent = commentsView.root ? "楼中楼" : "评论";
        el("comments-level").textContent = commentsView.root ? "返回键回到评论" : "";
        el("comments-hint").textContent = commentsView.root
            ? "上下浏览 · 返回上一级 · 评论只读"
            : "上下浏览 · 右键看楼中楼 · 返回退出 · 评论只读";
        el("comments-status").textContent = commentsView.loading ? "正在加载…" :
            (commentsView.error ? "加载失败；返回后可重试" :
             (commentsView.more ? "继续向下可加载更多" : ""));
        Nav.reset(rows.length ? '#comments-list [data-comment-index="' +
                  Math.min(focusIndex || 0, rows.length - 1) + '"]' : "#comments-empty");
    }

    function loadComments() {
        var view = commentsView;
        if (!view || view.loading || !view.more) { return; }
        view.loading = true;
        el("comments-status").textContent = "正在加载…";
        var root = view.root, page = root ? view.childPage + 1 : view.page + 1;
        var token = view.token;
        function received(rows, more) {
            if (commentsView !== view || view.token !== token || view.root !== root) { return; }
            var target = root ? view.children : view.roots;
            var seen = {}, i;
            for (i = 0; i < target.length; i++) { seen[commentId(target[i])] = 1; }
            for (i = 0; i < rows.length; i++) {
                if (!seen[commentId(rows[i])]) { target.push(rows[i]); seen[commentId(rows[i])] = 1; }
            }
            if (root) { view.childPage = page; } else { view.page = page; }
            view.more = !!more && rows.length > 0;
            if (!root) { view.rootMore = view.more; }
            view.loading = false;
            var focus = Nav.current(), index = focus && Number(focus.getAttribute("data-comment-index"));
            paintComments(isNaN(index) ? 0 : index);
        }
        function failed(why) {
            if (commentsView !== view || view.token !== token || view.root !== root) { return; }
            view.loading = false;
            view.more = false;
            view.error = loginNeeded(why) || ("评论暂时无法读取（" + why + "）");
            report("comments", view.error);
            paintComments(0);
        }
        if (root) { API.commentReplies(view.aid, root, page, received, failed); }
        else { API.comments(view.aid, page, received, failed); }
    }

    function openComments() {
        if (!playing || commentsView || episodeView) { return; }
        var aid = Number(playing.detail.aid) || 0;
        if (!aid) {
            var session = playing;
            toast("正在获取评论编号…");
            API.view(session.detail.bvid, function (d) {
                if (playing !== session) { return; }
                if (!d || !d.aid) { toast("这个视频暂时没有可读取的评论"); return; }
                session.detail.aid = d.aid;
                openComments();
            }, function (why) {
                if (playing === session) { trouble(loginNeeded(why) || ("评论暂时无法打开：" + why)); }
            });
            return;
        }
        closeOptions();
        cancelScrub();
        commentsView = { aid: aid, token: ++commentsToken,
            roots: [], children: [], root: "", page: 0, childPage: 0,
            loading: false, more: true, rootMore: true,
            error: "", rootIndex: 0, rootScroll: 0 };
        el("comments-video-title").textContent = playing.detail.title || "";
        document.body.className += " comments-open";
        el("comments-view").className = "";
        el("playerui").className = "hidden";
        Player.setViewport(48, 72, 1216, 684);
        paintComments(0);
        loadComments();
    }

    function closeComments(silent) {
        if (!commentsView) { return; }
        commentsView = null;
        ++commentsToken;
        document.body.className = document.body.className.replace(/\s*comments-open/g, "");
        el("comments-view").className = "hidden";
        el("comments-list").innerHTML = "";
        Player.setViewport(0, 0, 1920, 1080);
        if (playing && !silent) { showChrome(); }
    }

    function openCommentReplies(row, index) {
        if (!commentsView || commentsView.root || !Number(row.rcount || row.count || 0)) { return; }
        var view = commentsView;
        view.rootIndex = index;
        view.rootScroll = el("comments-list").scrollTop;
        view.root = commentId(row);
        view.children = [];
        view.childPage = 0;
        view.more = true;
        view.error = "";
        view.loading = false;
        view.token = ++commentsToken;
        el("comments-list").scrollTop = 0;
        paintComments(0);
        loadComments();
    }

    function leaveCommentReplies() {
        if (!commentsView || !commentsView.root) { closeComments(); return; }
        var view = commentsView;
        view.root = "";
        view.more = view.rootMore;
        view.error = "";
        view.loading = false;
        view.token = ++commentsToken;
        paintComments(view.rootIndex);
        el("comments-list").scrollTop = view.rootScroll;
    }

    /* Two rows on open, two more per step down. Two rather than the old sixteen
     * because this panel comes up over a video that is still buffering: the
     * cheapest moment to spend on thumbnails is after the ring starts moving,
     * which is also the only moment they are being looked at. Six, not eight,
     * since the grid went three wide — these are rows counted in cards. */
    function panelFirst() { return gridColumns() * 2; }
    function panelPage() { return gridColumns() * 2; }

    /* The settings page's names for the cap (Settings.qnSteps). */
    var QN_LABELS = { 120: "4K（最高）", 112: "1080P 高码率", 80: "1080P", 64: "720P", 32: "480P" };

    var QUALITY_NAMES = {
        127: "8K", 120: "4K", 116: "1080P60", 112: "1080P+",
        80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P"
    };

    /* The part list alone, so a list that arrives while the panel is open can
     * be painted in place: rebuilding the whole panel for it reset the scroll,
     * collapsed the related grid back to its first rows and yanked focus to
     * 「当前」 — possibly tens of seconds after the viewer had walked down into
     * the related videos. Reads playing.detail and playing.metaState. */
    function paintParts() {
        var d = playing.detail;
        var group = el("opt-parts-group");
        if (d.pages && d.pages.length > 1) {
            group.className = "opt-group";
            var ph = "";
            /* Every part, not the first forty. The cap was borrowed from the
             * related grid's, where it was at least paying for something —
             * thumbnails on a busy link. A part is a text box: no image, no
             * request, nothing to pace. All it bought was P41 and beyond being
             * unreachable from the only screen that lists them, silently, on
             * exactly the uploads that need the list most (collections and
             * courses run to hundreds). One row since 2026-10-18, sliding
             * sideways under the focus (index.html: "hscroll") — wrapped, a long
             * list was dozens of lines to climb past on the way up the panel —
             * and Nav.reset puts the focus on `.opt.current`, so the row opens
             * on the part being watched rather than at P1. */
            /* ⟶ 2026-10-20 tiled four to a row like the 合集, and past fifty
             * folded into ranges whose list opens on the right (the viewer:
             * 「分 P 也像合集那样按段折叠吧」). */
            var folded = d.pages.length > SEASON_FOLD;
            if (folded) {
                var curP = -1;
                for (var cp = 0; cp < d.pages.length; cp++) { if (d.pages[cp].cid === playing.cid) { curP = cp; } }
                for (var pr = 0; pr * SEASON_FOLD < d.pages.length; pr++) {
                    var pa0 = pr * SEASON_FOLD, pb0 = Math.min(d.pages.length, pa0 + SEASON_FOLD);
                    ph += '<div class="opt opt-range focusable' + (curP >= pa0 && curP < pb0 ? " current" : "") +
                          '" data-range="' + pr + '">P' + (pa0 + 1) + "–P" + pb0 + "</div>";
                }
            }
            for (var p = 0; !folded && p < d.pages.length; p++) {
                /* The name, not just the number. It has been in hand all along —
                 * `view()` maps `part`, and the resume toast and the player's own
                 * 「P7 / 24 …」 label both print it — this row was the one place
                 * that dropped it. On a numbered upload "P7" says enough; on a
                 * collection ("第一季1–11", "第二季1–10") the number says nothing
                 * at all, and that is exactly the shape of upload whose list is
                 * long enough to need the panel. Dropped again when the name is
                 * only the number restated, which is what bilibili fills in when
                 * the uploader named nothing: "P1 1" is worse than "P1". */
                var pname = d.pages[p].part || "";
                if (pname === String(p + 1) || pname === String(d.pages[p].page)) { pname = ""; }
                var pdur = d.pages[p].duration || "";
                ph += '<div class="opt focusable' + (d.pages[p].cid === playing.cid ? " current" : "") +
                      '" data-cid="' + d.pages[p].cid + '">' +
                      '<span class="opt-p">P' + (p + 1) + "</span>" +
                      (pname ? '<span class="opt-name">' + esc(pname) + "</span>" : "") +
                      (pdur ? '<span class="opt-dur">' + esc(pdur) + "</span>" : "") +
                      "</div>";
            }
            el("opt-parts").innerHTML = ph;
        } else if (playing.metaState === "failed") {
            /* Say so. Hiding the group here is what a single-part video does,
             * and a viewer who knows the upload has twenty parts cannot tell
             * the two apart — that is exactly how the 412 of 2026-09-07 got
             * reported: 「按向下没有出来分 P 列表」. */
            group.className = "opt-group";
            el("opt-parts").innerHTML = '<div class="empty">分 P 列表加载失败（' +
                esc(playing.metaWhy || "?") + "）</div>";
        } else if (playing.metaState !== "done") {
            /* The fetch is deferred until the first frame (it must not race
             * the stream for the link), so before that there is nothing in
             * flight and 「正在加载」 would describe a request never sent. */
            group.className = "opt-group";
            el("opt-parts").innerHTML = '<div class="empty">' +
                (playing.needsMeta ? "画面起来后再取分 P 列表…" : "正在加载分 P 列表…") +
                "</div>";
        } else {
            group.className = "opt-group hidden";
            el("opt-parts").innerHTML = "";
        }
        /* The part chips only — the speed row is .opt too. */
        var opts = document.querySelectorAll("#opt-parts .opt");
        for (var k = 0; k < opts.length; k++) {
            (function (node) {
                node.onselect = function () {
                    if (node.hasAttribute("data-range")) {
                        openEpisodeList("parts", Number(node.getAttribute("data-range")));
                        return;
                    }
                    var cid = node.getAttribute("data-cid");
                    closeOptions();
                    if (cid) { play(playing.detail, Number(cid)); }
                };
            })(opts[k]);
        }
    }

    /* 合集 (2026-10-18). The same chips as the parts, one per episode, every
     * one of them (the parts row's reasoning: a series long enough to need a
     * list is exactly the one a cap would cut). Choosing one plays that video;
     * the uploader is the same throughout a season, so the card carries over
     * who made it and the rest arrives with the episode's own view(). */
    function seasonEpisodeDetail(ep) {
        var d = playing && playing.detail;
        return { bvid: ep.bvid, aid: ep.aid, cid: ep.cid, title: ep.title, pic: ep.pic,
                 duration: ep.duration, author: d ? d.author : "", mid: d ? d.mid : 0,
                 face: d ? d.face : "" };
    }
    function seasonIndex(season, bvid) {
        for (var i = 0; i < season.episodes.length; i++) {
            if (season.episodes[i].bvid === bvid) { return i; }
        }
        return -1;
    }
    function paintEpisodeControls() {
        var d = playing && playing.detail;
        var prev = d && EpisodeNav.adjacent(d, playing.cid, -1);
        var next = d && EpisodeNav.adjacent(d, playing.cid, 1);
        var group = el("opt-episode-controls");
        group.className = prev || next ? "opt-group" : "opt-group hidden";
        function bind(id, choice) {
            var button = el(id);
            button.className = choice ? "btn ghost focusable" : "btn ghost focusable hidden";
            button.onselect = choice ? function () {
                /* Resolve again at selection time: deferred view() can replace
                 * detail while the panel is open. */
                var current = EpisodeNav.adjacent(playing.detail, playing.cid,
                    id === "panel-prev-episode" ? -1 : 1);
                if (!current) { return; }
                var detail = playing.detail;
                closeOptions();
                if (current.kind === "part") { play(detail, current.cid); }
                else { playSeasonEpisode(detail.season, current.index); }
            } : null;
        }
        bind("panel-prev-episode", prev);
        bind("panel-next-episode", next);
    }
    function paintSeason() {
        var s = playing && playing.detail && playing.detail.season;
        var group = el("opt-season-group");
        if (!s) { group.className = "opt-group hidden"; el("opt-season").innerHTML = ""; return; }
        group.className = "opt-group";
        var at = seasonIndex(s, playing.detail.bvid);
        el("opt-season-label").textContent = "合集 · " + s.title +
            (at >= 0 ? "（第 " + (at + 1) + " / " + s.episodes.length + " 集）" : "（" + s.episodes.length + " 集）");
        var html = "";
        if (s.episodes.length > SEASON_FOLD) {
            /* Ranges of 50, the list itself on the right (openEpisodeList). */
            for (var r = 0; r * SEASON_FOLD < s.episodes.length; r++) {
                var a = r * SEASON_FOLD, b = Math.min(s.episodes.length, a + SEASON_FOLD);
                html += '<div class="opt opt-range focusable' + (at >= a && at < b ? " current" : "") +
                        '" data-range="' + r + '">' + (a + 1) + "–" + b + "</div>";
            }
            el("opt-season").innerHTML = html;
            var ranges = document.querySelectorAll("#opt-season .opt");
            for (var q = 0; q < ranges.length; q++) {
                (function (node) {
                    node.onselect = function () { openEpisodeList("season", Number(node.getAttribute("data-range"))); };
                })(ranges[q]);
            }
            return;
        }
        for (var i = 0; i < s.episodes.length; i++) {
            var ep = s.episodes[i];
            html += '<div class="opt focusable' + (i === at ? " current" : "") + '" data-i="' + i + '">' +
                    '<span class="opt-p">' + (i + 1) + "</span>" +
                    '<span class="opt-name">' + esc(ep.title) + "</span>" +
                    (ep.duration ? '<span class="opt-dur">' + esc(ep.duration) + "</span>" : "") + "</div>";
        }
        el("opt-season").innerHTML = html;
        var chips = document.querySelectorAll("#opt-season .opt");
        for (var k = 0; k < chips.length; k++) {
            (function (node) {
                node.onselect = function () {
                    closeOptions();
                    playSeasonEpisode(s, Number(node.getAttribute("data-i")));
                };
            })(chips[k]);
        }
    }

    /* bilibili writes 「-」 for an upload with no description, and the panel
     * showed it as a stray dash under the uploader (10-20, the viewer: 「up 主
     * 下面那一行是啥？」). Blank, or only punctuation: no line at all. */
    function paintDesc(desc) {
        var text = String(desc || "").replace(/^\s+|\s+$/g, "").slice(0, 400);
        var node = el("panel-desc");
        node.textContent = /^[\s\-—_.。·、,，]*$/.test(text) ? "" : text;
        node.className = node.textContent ? "" : "hidden";
    }

    /* One episode of the 合集, from the tiles or the side list. The one already
     * playing just carries on. */
    function playSeasonEpisode(s, i) {
        var ep = s && s.episodes[i];
        if (!ep || !playing || ep.bvid === playing.detail.bvid) { return; }
        report("season", "合集「" + Diag.priv(s.title) + "」选第 " + (i + 1) + " 集 " + ep.bvid);
        play(seasonEpisodeDetail(ep), ep.cid);
    }

    /* A 合集 longer than this folds into ranges in the panel, and a range opens
     * as a list on the right, where the comments go (2026-10-20, the viewer: a
     * 400-odd episode 合集 tiled four to a row was a hundred rows). Fifty, not a
     * hundred: the list is walked one press at a time. */
    var SEASON_FOLD = 50;
    var episodeView = null;
    var COMMENTS_VIDEO_HINT = "视频继续播放中 · 播放/暂停键控制视频 · 返回键关闭评论";

    /* What a fold lists: the 合集's episodes or the upload's parts — the
     * label for each, which one is playing, and what picking one does. */
    function foldList(kind) {
        var d = playing && playing.detail;
        if (!d) { return null; }
        if (kind === "parts") {
            if (!d.pages || !d.pages.length) { return null; }
            var atP = -1;
            for (var i = 0; i < d.pages.length; i++) { if (d.pages[i].cid === playing.cid) { atP = i; } }
            return { name: "分 P", unit: "P", title: d.title || "", at: atP, count: d.pages.length,
                     no: function (j) { return "P" + (j + 1); },
                     label: function (j) { var n = d.pages[j].part || ""; return n === String(j + 1) ? "" : n; },
                     dur: function (j) { return d.pages[j].duration || ""; },
                     pick: function (j) { if (d.pages[j].cid !== playing.cid) { play(d, d.pages[j].cid); } } };
        }
        var s = d.season;
        if (!s) { return null; }
        return { name: "合集", unit: "集", title: s.title, at: seasonIndex(s, d.bvid), count: s.episodes.length,
                 no: function (j) { return String(j + 1); },
                 label: function (j) { return s.episodes[j].title; },
                 dur: function (j) { return s.episodes[j].duration || ""; },
                 pick: function (j) { playSeasonEpisode(s, j); } };
    }

    function openEpisodeList(kind, r) {
        var L = foldList(kind);
        if (!L || episodeView) { return; }
        closeOptions();
        cancelScrub();
        var from = r * SEASON_FOLD, to = Math.min(L.count, from + SEASON_FOLD);
        var at = L.at, html = "";
        var span = L.unit === "P" ? "P" + (from + 1) + "–P" + to : "第 " + (from + 1) + "–" + to + " 集";
        episodeView = { kind: kind, range: r };
        report(kind === "parts" ? "parts" : "season", L.name + "「" + Diag.priv(L.title) + "」打开 " + span + " 的列表（共 " +
               L.count + " " + L.unit + "，正在看 " + (at >= 0 ? L.no(at) : "?") + "）");
        for (var i = from; i < to; i++) {
            html += '<div class="comment-item ep-item focusable' + (i === at ? " current" : "") + '" data-ep="' + i + '">' +
                    '<span class="ep-no">' + esc(L.no(i)) + '</span><span class="ep-title">' + esc(L.label(i)) + '</span>' +
                    (L.dur(i) ? '<span class="ep-dur">' + esc(L.dur(i)) + '</span>' : "") + '</div>';
        }
        /* The comments' side view, lent: same shrunk picture, same pane. */
        el("comments-video-title").textContent = playing.detail.title || "";
        el("comments-video-hint").textContent = "视频继续播放中 · 播放/暂停键控制视频 · 返回键回到面板";
        el("comments-title").textContent = L.name;
        el("comments-level").textContent = span + " · 共 " + L.count + " " + L.unit;
        el("comments-hint").textContent = L.title;
        el("comments-status").textContent = "";
        el("comments-list").innerHTML = html;
        el("comments-list").scrollTop = 0;
        document.body.className += " comments-open";
        el("comments-view").className = "";
        el("playerui").className = "hidden";
        Player.setViewport(48, 72, 1216, 684);
        var items = document.querySelectorAll("#comments-list .ep-item");
        for (var k = 0; k < items.length; k++) {
            (function (node) {
                node.onselect = function () {
                    var i2 = Number(node.getAttribute("data-ep"));
                    closeEpisodeList(true);
                    if (kind === "parts") { report("parts", "分 P 选 P" + (i2 + 1)); }
                    L.pick(i2);
                };
            })(items[k]);
        }
        var cur = document.querySelector("#comments-list .ep-item.current") ||
                  document.querySelector("#comments-list .ep-item");
        if (cur) { Nav.focus(cur); }
    }

    /* `toVideo`: an episode was picked (or playback is going away), so back to
     * the picture; otherwise 返回, back to the panel on that range. */
    function closeEpisodeList(toVideo) {
        if (!episodeView) { return; }
        var r = episodeView.range, fromRow = episodeView.kind === "parts" ? "#opt-parts" : "#opt-season";
        episodeView = null;
        document.body.className = document.body.className.replace(/\s*comments-open/g, "");
        el("comments-view").className = "hidden";
        el("comments-list").innerHTML = "";
        el("comments-video-hint").textContent = COMMENTS_VIDEO_HINT;
        Player.setViewport(0, 0, 1920, 1080);
        if (!playing) { return; }
        if (toVideo) { showChrome(); return; }
        openOptions();
        var chip = document.querySelector(fromRow + ' .opt[data-range="' + r + '"]');
        if (chip) { Nav.focus(chip); }
    }

    /* 播放速度 (2026-09-28). A row of chips like the parts, the current one
     * marked; choosing one keeps the panel open, since the viewer may want to
     * try the next one up. Sticky for the app run (Player.setRate). */
    function paintSpeed() {
        var rates = Player.rates(), cur = Player.rate(), html = "";
        for (var i = 0; i < rates.length; i++) {
            html += '<div class="opt focusable' + (rates[i] === cur ? " current" : "") +
                    '" data-rate="' + rates[i] + '">' + rates[i] + "x</div>";
        }
        el("opt-speed").innerHTML = html;
        var chips = document.querySelectorAll("#opt-speed .opt");
        for (var j = 0; j < chips.length; j++) {
            (function (node) {
                node.onselect = function () {
                    var r = Number(node.getAttribute("data-rate"));
                    if (!Player.setRate(r)) { toast("当前播放方式不支持这个速度"); return; }
                    if (dm) { dm.rate(r); }
                    paintSpeed();
                    setQualityBadge(qualityText);
                    Nav.focus(document.querySelector('#opt-speed .opt[data-rate="' + r + '"]'));
                };
            })(chips[j]);
        }
    }

    function openOptions() {
        if (!playing || optionsOpen) { return; }
        var ot = backTimer("打开面板");
        cancelScrub();
        optionsOpen = true;
        el("playerui").className = "hidden";
        document.body.className += " options-open";
        el("options").className = "scroll";
        el("options").scrollTop = 0;
        ot.mark("切布局");

        var d = playing.detail;

        el("panel-title").textContent = d.title || "";
        /* The uploader's name is the way to their page, so it is a chip, not a
         * word in a line of grey text. It sits above the part row, which is
         * where 上键 from the parts already goes; one more press up from the
         * chip closes the panel as before (nothingAboveInPanel). */
        var rest = [d.duration, d.play ? d.play + "次观看" : "",
                    publishedDate(d.publishedAt) ? "发布于 " + publishedDate(d.publishedAt) : ""]
            .filter(function (x) { return !!x; }).join("  ·  ");
        el("panel-meta").innerHTML =
            '<span class="opt-up focusable" id="panel-up">' + esc(d.author || "UP 主") + '</span>' +
            '<span class="opt-follow hidden" id="panel-follow"></span>' +
            (rest ? '<span class="panel-meta-rest">' + esc(rest) + '</span>' : "");
        el("panel-up").onselect = function () {
            var cur = playing && playing.detail;
            if (!cur) { return; }
            /* The mid rides on every card now, but a video opened by bvid alone
             * (a handoff, a deep link) has it only once view() has answered. */
            if (!cur.mid) { toast("还没拿到这位 UP 主的资料，稍等一下再按"); return; }
            var kind = "up:" + cur.mid;
            /* Watching something from this uploader's own page: the page is
             * what is behind the video, so this press means 返回. */
            if (state.screen === kind) { stopPlayback(); return; }
            var mid = cur.mid, name = cur.author, face = cur.face;
            /* 返回 from that page comes back here (2026-10-20, the viewer: 「从一个
             * 视频下方的 UP 主点进他的 UP 主页，然后再按返回键，为什么就退到了首页？
             * 应该退到刚刚那个视频呀」): this video, this second, the related-pick
             * trail behind it, and the ring back on the chip. */
            var ret = { detail: cur, cid: playing.cid, kind: kind, pick: -1, focus: "panel-up",
                        at: Player.hasPosition() ? Player.position() : lastKnownPosition,
                        stack: backStack.slice() };
            stopPlayback(function () { openUp(mid, name, face); upReturn = ret; });
        };
        ot.mark("标题");
        paintDesc(d.desc);
        ot.mark("简介");
        paintPanelActions();
        loadPanelActions();
        loadFollow(el("panel-follow"), d.mid);
        el("panel-comments").onselect = openComments;
        ot.mark("按钮");

        paintParts();
        ot.mark("分P");
        paintSeason();
        ot.mark("合集");
        paintEpisodeControls();
        paintSpeed();
        ot.mark("倍速");
        /* No 弹幕 row since 2026-10-20 (the viewer: 「弹幕的设置入口，就保留在统一设置的
         * 那个入口」) — it is a setting of this television, not of one video.
         * PR #10's 弹幕位置 row went the same way (10-25): 设置 only. */

        /* Related videos live in the panel now, so "what else" never costs the
         * viewer their place in the video. All of them, not the first sixteen:
         * the cap was there because sixteen thumbnails already compete with the
         * stream underneath, and the pager answers that properly — two rows on
         * open, the rest as the ring walks down. */
        var rg = el("opt-related-group");
        rg.className = "opt-group";
        if (d.related && d.related.length) {
            panelGrid.reset(d.related, panelFirst());
        } else {
            panelGrid.clear();
            el("opt-related").innerHTML = '<div class="empty">正在加载相关视频…</div>';
        }
        ot.mark("相关");

        /* 下一集 when there is one (PR #9, 10-25): 下键 then 确认 is the next
         * part. Else the episode being watched when there is a list of them —
         * not 上一集, which on the last episode would make that 确认 go
         * backwards — else the row's first button. Spelled out since speed
         * moved into the top row (2026-10-20): its current chip would win
         * `#options .opt.current`. */
        var firstFocus = ["#panel-next-episode", "#opt-parts .opt.current",
                          "#opt-season .opt.current", "#panel-dm"];
        for (var ff = 0; ff < firstFocus.length; ff++) {
            var ffNode = document.querySelector(firstFocus[ff]);
            if (ffNode && ffNode.offsetParent !== null) { Nav.focus(ffNode); break; }
        }
        ot.mark("焦点");
        ot.done("分P " + ((d.pages || []).length) + " · 合集 " + document.querySelectorAll("#opt-season .opt").length +
                " · 相关 " + ((d.related || []).length) + " · 播放器 " + Player.mode());
    }

    /* True when no other focusable in the panel sits above this one — the
     * top row, wherever the panel happens to be scrolled to. */
    function nothingAboveInPanel(cur) {
        if (!cur || !cur.getBoundingClientRect) { return false; }
        var top = cur.getBoundingClientRect().top;
        var all = document.querySelectorAll("#options .focusable");
        for (var i = 0; i < all.length; i++) {
            if (all[i] === cur || !all[i].offsetParent) { continue; }
            if (all[i].getBoundingClientRect().bottom <= top + 6) { return false; }
        }
        return true;
    }

    function closeOptions() {
        if (!optionsOpen) { return; }
        optionsOpen = false;
        if (pa) { pa.more = ""; }
        paintActMore();
        document.body.className = document.body.className.replace(/\s*options-open/g, "");
        el("options").className = "hidden scroll";
        /* The thumbnails go with the screen: openOptions repaints from the list
         * every time anyway (that is how a late `related` response reaches an
         * open panel), so keeping them would only be images decoding behind a
         * video that is playing. */
        panelGrid.clear();
        if (!playing) { return; }
        el("playerui").className = "";
        showChrome();
    }

    var nextToken = 0;

    function cancelNext() {
        nextToken++;   /* an in-flight nextUp lookup must not surface later */
        if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
        pendingNext = null;
        el("nextup").className = "hidden scroll";   /* nav.js finds the scroller by that class */
        nextupGrid.clear();
    }

    /* One row above the fold, two more rows per step down — in cards, so both
     * moved with the grid from four columns to three. The first row is painted
     * while the countdown is still running, which is the one paint that competes
     * with the next video's start: a row is the right unit for it either way,
     * and three is one thumbnail cheaper than four was. */
    function nextupFirst() { return gridColumns(); }
    function nextupPage() { return gridColumns() * 2; }

    /* Autoplays in a row with no key pressed in between. After this many the
     * countdown is not started: a viewer who fell asleep otherwise chained
     * through related videos all night, each one filed into their bilibili
     * history as watched. Any key resets it (Nav.onKey sees every press).
     * Was 3 until 2026-10-02 — that stopped ordinary lean-back viewing every
     * few videos; 100 only catches the truly all-night case. */
    var AUTOPLAY_UNATTENDED = 100;
    var autoplaysSinceKey = 0;

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
            /* The session, not its detail: the detail's cid is P1's (from
             * view() or the card), and 返回 from the chooser rebuilt `playing`
             * from it — so the -1 that stopPlayback then reported went out
             * under the first part's cid, and bilibili's history said P1 had
             * just been finished. The session carries the part that ended. */
            next.from = finished;
            pendingNext = next;
            el("playerui").className = "hidden";
            el("nextup-title").textContent = next.title;
            /* The uploader of the video that just ended — the one the viewer
             * has an opinion about now — to the right of the queued card. To
             * the right and not under it, so 下键 from the card still walks
             * into the related grid the way the selftest and the hint promise. */
            var hasUp = paintNextupUp(finished && finished.detail);
            var thumb = el("nextup-thumb");
            if (next.detail && next.detail.pic) {
                thumb.src = next.detail.pic;
                thumb.className = "";
            } else { thumb.className = "hidden"; }

            /* What else there is, under the queued one — all of it, not a
             * sample. The list is already in hand (it was fetched during
             * playback for the panel), so the whole grid costs no round trip;
             * only the thumbnails are paced, a few rows at a time, by the
             * shared card pager. The queued video is left out of it: it is
             * already the big card above. */
            var rel = (finished && finished.detail && finished.detail.related) || [];
            var more = [];
            for (var r = 0; r < rel.length; r++) {
                if (next.detail && rel[r].bvid === next.detail.bvid) { continue; }
                more.push(rel[r]);
            }
            nextupGrid.reset(more, nextupFirst());
            el("nextup-more").className = more.length ? "nextup-more" : "nextup-more hidden";
            /* `has-more` is what turns the centred column into a scroller — and
             * it can only be decided here, once it is known whether there is
             * anything below the fold. `scroll` is nav.js's marker for the same
             * element; losing it in a className rewrite does not fail loudly,
             * it just quietly stops the screen following the focus down. */
            el("nextup").className = more.length ? "has-more scroll" : "scroll";
            el("nextup").scrollTop = 0;

            /* Focus is on the queued video, so 确认 still means "play it now"
             * without anyone having to aim. */
            el("nextup-go").onselect = playNext;
            /* The queued video is asked about now rather than on a dwell: the
             * countdown is eight seconds of nothing on the link, and autoplay
             * down a series otherwise paid the cold start on every episode.
             * On the button too, so coming back to it after browsing the
             * related row finds it still covered. */
            var queued = { bvid: next.detail && next.detail.bvid, cid: next.cid,
                           aid: (next.detail && next.detail.aid) || 0 };
            el("nextup-go").__video = queued;
            Nav.focus(el("nextup-go"));
            prefetchCard(queued, true);

            if (!autoNextEnabled()) {
                report("player", "自动播放已关闭，等待观众选择下一条");
                el("nextup-hint").textContent = "自动播放已关闭 · 确认键 播放 · 返回键 退出";
                return;
            }
            if (autoplaysSinceKey >= AUTOPLAY_UNATTENDED) {
                report("player", "连着自动播了 " + autoplaysSinceKey +
                       " 个都没人按键，这次不倒计时，等观众确认");
                el("nextup-hint").textContent = "已经连着自动播了 " + autoplaysSinceKey +
                    " 个 · 还在看吗？确认键 继续 · 返回键 退出";
                return;
            }
            var left = 8;
            /* 「下键 挑别的」 only when there is something down there. Promising a
             * key that does nothing is worse than not mentioning it: the press
             * still stops the countdown, so following the instruction leaves the
             * viewer on a frozen screen where autoplay was about to work. */
            el("nextup-hint").innerHTML = '<span id="nextup-count">' + left +
                '</span> 秒后开始 &middot; 确认键 立即播放' +
                (more.length ? ' &middot; 下键 挑别的' : "") +
                (hasUp ? ' &middot; 右键 看这位 UP 主' : "") +
                ' &middot; 返回键 退出';
            nextTimer = setInterval(function () {
                if (!autoNextEnabled()) { stopCountdown(); return; }
                left--;
                var c = el("nextup-count");
                if (c) { c.textContent = left; }
                if (left <= 0) { autoplaysSinceKey++; playNext(); }
            }, 1000);
        });
    }

    /* The countdown is a default, not a deadline. Any move of the focus is the
     * viewer saying "wait, I want to pick" — so it stops there and then, and the
     * screen stays up until they choose or press 返回. Without this, reaching
     * the related row would start the queued video out from under them. */
    function stopCountdown() {
        if (!nextTimer) { return; }
        clearInterval(nextTimer);
        nextTimer = null;
        el("nextup-hint").textContent = "确认键 播放 · 返回键 退出";
    }

    /* True when there is a chip to show. The finished session's detail has
     * the mid from its card or from view(); a session that had neither (opened
     * by bvid, view() still pending when it ended) gets no chip rather than a
     * chip that opens an empty page. */
    function paintNextupUp(d) {
        var box = el("nextup-up");
        if (!d || !d.mid) { box.className = "nextup-up hidden"; box.onselect = null; return false; }
        var name = d.author || "UP 主";
        el("nextup-up-name").textContent = name;
        var face = el("nextup-up-face"), ini = el("nextup-up-initial");
        if (d.face) { face.src = d.face; face.className = "up-face"; ini.className = "hidden"; }
        else { face.className = "hidden"; ini.textContent = name.charAt(0); ini.className = "up-initial"; }
        box.className = "nextup-up focusable";
        var mid = d.mid, fc = d.face;
        box.onselect = function () {
            /* Same shape as 返回 from this screen: the finished session is put
             * back so its position is reported under the part that ended. */
            var fin = pendingNext && pendingNext.from;
            cancelNext();
            playing = fin || null;
            stopPlayback(function () { openUp(mid, name, fc); });
        };
        return true;
    }

    function handleNextKeys(k) {
        if (k === Nav.KEY.PLAY_PAUSE || k === Nav.KEY.PLAY) { playNext(); return true; }
        /* Arrows and 确认 belong to Nav here: this screen is a chooser, and its
         * cards carry their own onselect. Handling 确认 ourselves would play the
         * queued video no matter which card the ring was on. */
        if (k === Nav.KEY.LEFT || k === Nav.KEY.RIGHT ||
                k === Nav.KEY.UP || k === Nav.KEY.DOWN) {
            /* Only when there is somewhere to go. With no related row there is
             * exactly one card on this screen, so an arrow press moves nothing —
             * and stopping the countdown for it would cancel autoplay on a press
             * that visibly did nothing at all. */
            var more = el("nextup-more"), upc = el("nextup-up");
            if ((more && more.className.indexOf("hidden") < 0) ||
                    (upc && upc.className.indexOf("hidden") < 0)) { stopCountdown(); }
            return false;
        }
        if (k === Nav.KEY.ENTER) { return false; }
        if (k === Nav.KEY.RETURN) {
            var finished = pendingNext.from;
            cancelNext();
            playing = finished || null;
            /* A video reached from a related pick ended: 返回 goes back to the
             * one it was picked from, as it would have mid-play. */
            if (playing && backStack.length) { backFromPlayer(); return true; }
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
        backStack = [];   /* the chain moved on by itself; 返回 now means the grid */
        playedInChain[next.detail.bvid] = 1;
        play(next.detail, next.cid);
    }

    /* The overlay is for orientation, not decoration: show it on any input and
     * take it away again so the picture is unobstructed while watching. */
    function showChrome() {
        if (!playing) { return; }
        if (commentsView || episodeView) { return; }
        el("playerui").className = "";
        /* Fresh start for the "how long has it been trying to hide" clock: a
         * keypress puts the banner up on purpose, so the four seconds that
         * follow are not a banner refusing to leave. */
        chromeWantSince = 0;
        armChromeHide(4000);
    }

    /* Why this is a loop and not a single timer.
     *
     * It used to be one shot: four seconds later, hide it *if* the video was not
     * paused — and `Player.isPaused()` reads the media element, which reports
     * paused for the whole of a load. A start slower than four seconds therefore
     * met a timer that declined to hide, and nothing re-armed it: the banner then
     * sat across the picture for the rest of the video, until some key press
     * happened to call showChrome again. Slow starts are not rare — a rescue or
     * a strong-token rebuild has been measured at 10 and 14 seconds to first
     * frame — so the commonest way to get a stuck banner was to have had a bad
     * start, which is also the moment the viewer is least inclined to forgive it.
     *
     * Two fixes, and they are the same two the stall watchdog needed on 08-09:
     * ask an explicit flag rather than the element (`userPaused` is what the
     * viewer pressed; `element.paused` is also true while loading), and when the
     * answer is "not yet", look again instead of giving up.
     *
     * ⟶ 2026-08-17: that second fix was applied to exactly one of the four ways
     * out and the banner went on sticking. Three branches still returned with
     * the timer already nulled — 拖动中, 面板开着, 观众按了暂停 — each of them
     * leaning on somebody outside to call showChrome again on the way back.
     * That works only as long as every exit remembers, and one does not: a
     * rescue that rebuilds the player resumes playback without going through
     * `setPaused(false)`, so a viewer who paused before a 403 comes back to a
     * video that is playing, a `userPaused` still true, and no timer left
     * anywhere in the app. The banner then sits there for the rest of the
     * video — which is what was reported this afternoon, and why pressing
     * 暂停/播放 cured it: that is the one path that re-arms.
     *
     * So none of them may return. They are all "not yet", never "never":
     * re-arm and ask again. Same shape as the watchdog's heartbeat, and for
     * the same reason — a state machine that can only be restarted from the
     * outside gets stuck the first time an exit forgets. */
    var chromeSaid = 0;       /* diagnostic lines spent on this video */
    var chromeHidTold = false;
    var chromeWantSince = 0;  /* when the current "wants to hide but cannot" run began */

    function armChromeHide(after) {
        if (chromeTimer) { clearTimeout(chromeTimer); }
        chromeTimer = setTimeout(function () {
            chromeTimer = null;
            var now = new Date().getTime();
            /* The one real stop: no session at all. showPlayerUi arms the next
             * one on the way in, so there is nothing to keep polling for. */
            if (!playing) { return; }

            var why = "";
            if (scrub) { why = "正在拖动"; }
            else if (optionsOpen) { why = "面板开着"; }
            else if (Player.userPaused()) { why = "观众按了暂停"; }
            else if (Player.isPaused()) { why = "元素还报 paused（加载或重建中）"; }

            if (!why) {
                el("playerui").className = "hidden";
                chromeWantSince = 0;
                /* Once per video, and it earns its place: it is the difference
                 * between "the code never hid it" and "the code hid it and the
                 * screen shows it anyway", which look identical from the sofa
                 * and want completely different fixes. */
                if (!chromeHidTold) {
                    chromeHidTold = true;
                    report("chrome", "横幅已收起");
                }
                return;
            }
            armChromeHide(1000);

            /* Two days of field lines taught this one what to say and when.
             *
             * Silent while the banner is already off screen: the panel sets
             * `playerui` hidden on its way up, so 「面板开着」 was reporting a
             * symptom that did not exist — there is nothing stuck when there is
             * nothing showing.
             *
             * Silent for the first ten seconds: every rescue rebuild holds the
             * element in `paused` for as long as it takes, and the heartbeat
             * dutifully filed four lines per rebuild. What this was built to
             * catch is a banner that never leaves, not one that waits.
             *
             * A diagnostic that fires on the healthy path stops being read —
             * which is the same thing as not having one. */
            var stuck = el("playerui").className.indexOf("hidden") < 0;
            if (!chromeWantSince) { chromeWantSince = now; }
            if (stuck && now - chromeWantSince >= 10000 && chromeSaid < 4) {
                chromeSaid++;
                report("chrome", "该收横幅了，没收：" + why + "，已经等了 " +
                       Math.round((now - chromeWantSince) / 1000) + " 秒" +
                       "（playerui class=\"" + el("playerui").className + "\"）");
            }
        }, after);
    }

    /* The player covers the browse screen by veiling it (app.css #shell.veiled). */
    function browseHidden() { return /\b(hidden|veiled)\b/.test(el("shell").className); }
    function showPlayerUi(on) {
        el("shell").className = on ? "veiled" : "";
        el("playerui").className = on ? "" : "hidden";
        el("nextup").className = "hidden scroll";   /* never survives either direction */
        if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
        if (on) { showChrome(); }
    }

    /* Where a video should start when the position did not come from this
     * television. Set just before play() by whoever knows better — today that
     * is a card from bilibili's own history, so a video left half-watched on
     * the phone carries on here rather than starting again. Consumed once. */
    var handoff = null;

    function play(detail, cid) {
        if (detail && detail.bvid) { playedSinceGrid[detail.bvid] = 1; }
        /* Every per-video piece of player state is cleared here. Leaving any of
         * it behind is invisible until the exact moment it matters: the scrub
         * head seeded from the last video would jump a fresh one straight to its
         * own ending. */
        closeOptions();
        closeComments(true);
        closeEpisodeList(true);
        cancelScrub();
        /* Diagnostics are per-video too: a capped count that is never reset
         * would go quiet after the first bad video of the evening, which is
         * the one video whose successor you most want a line about. */
        chromeSaid = 0;
        chromeHidTold = false;
        chromeWantSince = 0;
        /* The end-of-video screen is one of the things a new playback tears
         * down. Picking a related card from it calls straight in here, and
         * leaving `pendingNext` set would keep every key going to
         * handleNextKeys while the video played — the remote would look dead.
         * Same rule as the rest: whatever starts a playback dismantles what was
         * on screen before it, first. */
        cancelNext();
        /* The handover from one video to the next is a teardown point too —
         * the least obvious one yet. Without the stop, the outgoing session
         * keeps playing for the ~300ms until playurl answers, and each of its
         * timeupdates lands on the NEW `playing`: lastKnownPosition snaps back
         * to the old episode's clock and Resume.record files it under the new
         * cid. Switching P22→P23 at 19:52 opened P23 *at* 19:52 — the AVPlay
         * failure's in-place restart read the leaked position — and the local
         * resume list kept the lie. Farewell report first, while the session
         * identifiers are still the outgoing video's. */
        if (playing && lastKnownPosition !== playing.startMs) {
            reportProgress(Math.floor(lastKnownPosition / 1000), true,
                           Math.floor(lastKnownDuration / 1000));
        }
        Player.stop();
        clearSubtitles();
        clearDanmaku();
        viewerPaused = false;
        playing = { detail: detail, cid: cid };
        pa = null;   /* each playback reads its own like / coin / folder state */
        var nowPress = new Date().getTime();
        /* A card without a cid asks view() first, so the press can be a few
         * hundred milliseconds before this; autoplay has no press at all. */
        playing.pressedAt = (pressAt && nowPress - pressAt < 20000) ? pressAt : nowPress;
        pressAt = 0;

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
        /* Back from a related pick: exactly where it was left, even under the
         * 30 seconds Resume keeps. backFromPlayer reopens the panel. */
        if (returning && returning.detail === detail && returning.cid === cid) {
            startMs = returning.at || 0;
            fromPhone = false;
            playing.returnPick = returning.pick;
        }
        returning = null;

        lastKnownPosition = startMs;
        lastKnownDuration = 0;      /* the previous video's length is not this one's */
        playing.startMs = startMs;
        playing.fromPhone = fromPhone;
        /* Where playback starts is settled in `decide()`: bilibili's own record
         * for this video is still in flight at this point and may move it. */
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
        /* What the panel may say about the part list before view() has spoken.
         * A card from a feed carries no list, and until the fetch answers the
         * panel cannot tell "one part" from "not loaded yet" — so it said
         * nothing, and a multi-part video looked single-part from the sofa. */
        playing.metaState = (detail.pages && detail.pages.length) ? "done" : "pending";
        playing.metaWhy = "";
        el("pause-glyph").className = "hidden";
        cancelScrub();
        el("player-pos").textContent = "0:00";
        el("player-dur").textContent = detail.duration;
        el("player-fill").style.width = "0%";
        showPlayerUi(true);
        el("loading-title").textContent = detail.title || "";
        el("loading-status").textContent = "";
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
         * instead of guessing which of the evening's videos it was.
         *
         * The bvid alone stops being enough on a multi-part upload: "P10 will
         * not play" and "P10 quietly opened P1" are different faults with the
         * same description from the sofa, and this line could not tell them
         * apart — a run was read three times over before anyone noticed the
         * title in the log ended in "1". The cid is what playback was actually
         * asked for; `P?` means `resumeCid` handed back one that is not in this
         * video's part list at all, which is worth seeing on its own. */
        var partTag = " cid=" + cid;
        if (detail.pages && detail.pages.length) {
            var pIdx = -1;
            for (var qi = 0; qi < detail.pages.length; qi++) {
                if (detail.pages[qi].cid === cid) { pIdx = qi; break; }
            }
            partTag += " " + (pIdx < 0 ? "P?" : "P" + (pIdx + 1)) +
                       "/" + detail.pages.length;
        }
        report("player", detail.bvid + " " + Diag.priv(String(detail.title || "").slice(0, 24)) +
               partTag + " — requesting qn=" + Settings.qnCap());

        /* Both forms at once. Asking DASH first and progressive from inside its
         * callback put two full round trips to bilibili back to back before a
         * single byte of media was requested — and the answer to one has never
         * had any bearing on how to ask the other. `undefined` means still in
         * flight, `null` means it failed; the decision waits for both. */
        /* `strong` stays null unless a lesson says this video needs the app
         * endpoint's token — then it is a fourth request, awaited like the
         * others, and decide() prefers it over the web manifest. */
        var got = { dash: undefined, prog: undefined, resume: undefined, strong: null };

        /* Whatever the ring's dwell on this card already asked. A slot that
         * failed is asked again rather than trusted — the prefetch must never
         * be a way to fail that pressing the button afresh would not be. */
        var pre = takePrefetch(detail.bvid, cid);
        justPlayed = detail.bvid;
        function ask(slot, fetcher, onOk, onFail) {
            if (!slot) { fetcher(onOk, onFail); return; }
            whenSettled(slot, onOk, function () {
                if (playing === session) { fetcher(onOk, onFail); }
            });
        }
        var nowMs = new Date().getTime();
        /* The stream urls keep for hours; where the viewer is does not. This
         * is the one fresh cross-device answer (the phone's position), so a
         * prefetched one older than half a minute is asked again — keep
         * watching on the phone, sit down, press OK: the phone must win. */
        var preResume = (pre && nowMs - pre.at < 30000) ? pre.resume : null;
        playing.prefetchNote = pre
            ? "预取=" + ((pre.dash.done && pre.prog.done && pre.resume.done) ? "已到" : "在途") +
              "（" + (nowMs - pre.at) + "ms 前发出）"
            : "预取=无（" + (lastSkip && lastSkip.bvid === detail.bvid
                  ? "这张卡片被跳过：" + lastSkip.why
                  : (lastPrefetchBvid
                     ? "上一次预取的是 " + lastPrefetchBvid + "，" + (nowMs - lastPrefetchAt) + "ms 前"
                     : "这次启动还没预取过")) + "，最近一分钟预取了 " +
              prefetchTimes.filter(function (t) { return nowMs - t < 60000; }).length + " 次）";
        if (pre) {
            var warmBits = [];
            for (var wi = 0; wi < (pre.warm || []).length; wi++) {
                var w = pre.warm[wi];
                warmBits.push(w.label + (w.ms < 0 ? " 在途" : " " + w.status + " " + w.ms + "ms"));
            }
            playing.prefetchNote += " 预热=" + (warmBits.join("，") ||
                (pre.warm ? "这两份文件五分钟内已热过" : "没发（清单没到）"));
        }

        function decide() {
            if (playing !== session) { return; }
            if (got.dash === undefined || got.prog === undefined ||
                    got.resume === undefined || got.strong === undefined) { return; }

            /* bilibili's own record for this video, which knows about every
             * device including this one. It only moves the position within the
             * part already chosen: naming a different part is a decision that
             * belongs upstream, in `resumeCid`, and switching here would mean
             * throwing away the two stream requests already in flight.
             *
             * Same floor as everywhere else — under 30 seconds there is nothing
             * worth resuming, and starting ten seconds in reads as a glitch. */
            var r = got.resume;
            if (r) {
                playing.chapters = r.chapters || [];
                playing.subtitleTracks = r.subtitles || [];
            }
            if (r && r.cid === cid && r.positionMs >= 30000 &&
                    r.positionMs > playing.startMs && playing.returnPick === undefined) {
                playing.startMs = r.positionMs;
                lastKnownPosition = r.positionMs;
                playing.fromPhone = false;
                playing.fromAccount = true;
            }
            /* Said to the log, not the screen (2026-09-28): the picture
             * starting at 8:46 is the announcement, and naming which device
             * the position came from was a load on the viewer, not help. */
            if (playing.startMs) {
                report("player", "从 " + fmt(playing.startMs) + " 起播（" +
                       (playing.fromPhone ? "手机上的进度"
                        : (playing.fromAccount ? "账号里的进度" : "本机记录")) + "）");
            }

            var fromLesson = !!got.strong;
            var dash = got.strong || got.dash, prog = got.prog;
            var dashQn = 0;
            if (dash) {
                var best = Player.pickDashVideo(dash);
                dashQn = (best && best.id) || 0;
            }
            Player.mark("playurl");

            /* Kept on the session even when progressive wins the routing: this
             * is the fallback, and it has already been paid for. Asking playurl
             * for it again at the moment progressive gives up costs a round trip
             * on a screen that has been black for twenty seconds, and adds a way
             * to fail that a response already in hand cannot. */
            if (dash) { playing.dashReady = dash; }
            if (fromLesson) {
                /* Spent: a 403 on this manifest goes down the ladder, not back
                 * to the strong token. The web manifest is kept for the
                 * 「回到 web 端点压中低档」 exit, which otherwise would be
                 * handed the strong one it just failed on. */
                playing.triedStrong = true;
                playing.webDash = got.dash || null;
                playing.timedLabel = "到画面(强令牌·" + (got.strongWhy || "教训") + ")";
                report("player", (got.strongWhy || "教训") + "里的强令牌就绪，" +
                       (dash.tierNote || "") + (dash.strongTiming ? "，" + dash.strongTiming : ""));
            }
            /* And the mirror image, which did not exist until 2026-08-11: the
             * durl is a *different file* (audio muxed in) on AVPlay's own
             * stack, and the evening DASH died completely — video tiers 403d
             * per-file, audio tracks 403d per-host, the byte range at 184s
             * unparseable — it was never once asked. 「所有路都试过」 was a lie
             * with a qn=64 file sitting untried in this very response. */
            if (prog) { playing.progReady = prog; }

            /* Whatever the -404 was, it is over — a 审核中 video that came back
             * belongs in 继续观看 again, and nothing else has to know. */
            if (dash || prog) { Resume.markAlive(detail.bvid); }

            /* Ties go DASH (2026-09-28; they went progressive before). The
             * rule dates from the hand-rolled MSE pump, when AVPlay being
             * native was worth a lot. Behind Shaka, DASH starts in 1.6–3s and
             * carries the whole rescue ladder, while an AVPlay refusal costs
             * 6–8s before it even reports: BV1t441167uj that evening, a 1080p
             * durl tying the DASH top tier, took 11s to a picture — eight of
             * them AVPlay failing on a url the probe then read as 403. The
             * per-video 「渐进式败绩」 lesson only spared the *second* entry;
             * every other tie paid in full. Progressive still wins when it is
             * strictly better, and stays the last resort after DASH. */
            if (dash && (!prog || dashQn >= prog.quality)) {
                playDash(dash, dashQn); return;
            }
            if (prog) { startProgressive(prog); return; }
            /* Both forms refused, and the reasons are the whole diagnosis:
             * 「HTTP 403」「timeout」「network error」 and bilibili's own code
             * message are four different faults that this toast used to render
             * identically. The log already carried them — but on 2026-08-12 the
             * report channel was asleep and the screen was the only witness
             * left, so the screen has to know too. */
            var whyBoth = [];
            if (got.dashWhy) { whyBoth.push("dash " + got.dashWhy); }
            if (got.progWhy) { whyBoth.push("durl " + got.progWhy); }
            var whyText = whyBoth.join(" / ") || "两个请求都没有回答";
            report("player", "两种形式都拿不到播放地址（" + whyText + "）");
            /* -404 is bilibili saying the video itself is gone, not that the
             * streams are being withheld — reuploads of films and shows are
             * taken down constantly, while the card outlives them in a feed, a
             * search result or this television's own 继续观看 row. Telling the
             * viewer 「拿不到播放地址」 sends them looking for a network problem
             * that does not exist, and they press play again. 2026-08-12:
             * BV1GAu163EXE answered -404 on both forms, and view() answered
             * -404 for the whole 稿件 — pressed twice, five seconds apart. */
            if (API.gone(whyText)) {
                /* Hiding a card is a persistent decision, so it gets a
                 * discriminating test rather than an inference. playurl is
                 * asked for one *part*: a -404 means the streams behind this
                 * cid are gone, which is what a takedown looks like — but a
                 * stale cid on a live 稿件 (parts re-uploaded, and this set
                 * remembers the old one) answers exactly the same. view()
                 * separates them, and it is one API round trip on a path that
                 * has already failed. Only the takedown removes the card.
                 * Should the other case ever appear in the log, the answer is
                 * to re-resolve the cid, not to hide anything. */
                var deadBvid = detail.bvid;
                /* The toast waits for view(), which tells the three apart —
                 * one round trip after a playback that has already failed.
                 * 10-20: 「【风骚律师】全系列上线B站！」 is a 稿件 that stands
                 * for 番剧 episode ep813154, and was told 「已经被删除或下架」
                 * and sent back to the grid, which read as a crash. */
                API.view(deadBvid, function (full) {
                    if (full && /\/bangumi\/play\//.test(full.redirect || "")) {
                        /* Say bilibili's own reason when there is one: 「这个应用
                         * 还放不了」 read as the app's fault, while from this
                         * network the episode is region-locked for every client
                         * (2026-10-20, -10403). One request, after a failure. */
                        API.pgcAvailability(full.redirect, cid, function (why) {
                            toast(why ? "这是番剧或影视区的正片，B 站说：" + why
                                      : "这是番剧或影视区的正片，这个应用还放不了");
                            report("player", "playurl -404：这个稿件跳到番剧页（" + full.redirect +
                                   "），番剧接口" + (why ? "答：" + why : "说这里能放，但这个应用没接番剧播放"));
                        });
                        return;
                    }
                    toast("这个视频已经被删除或下架了");
                    report("player", "playurl 说 -404 但稿件还在 —— 是这一 P 的 cid" +
                           "（" + cid + "）过期了，继续观看不动它");
                }, function (vWhy) {
                    toast("这个视频已经被删除或下架了");
                    /* 62002 「稿件不可见」 is the other shape of gone: 2026-09-28
                     * BV1pPY66BEJX played at 21:24 and answered playurl -404 +
                     * wbi/view 62002 from 21:30 — pressed five times in thirty
                     * seconds from 继续观看, because only -404 took the card
                     * away. The mark is the same reversible one: seven days,
                     * cleared by the first successful play. */
                    var hidden = /code 62002/.test(String(vWhy));
                    if (!API.gone(vWhy) && !hidden) {
                        report("player", "playurl -404，而 view 另有说法（" + vWhy +
                               "），先不动继续观看");
                        return;
                    }
                    Resume.markDead(deadBvid);
                    report("player", hidden
                        ? "view 答 62002 稿件不可见：下架或隐藏了，从继续观看里去掉"
                        : "view 也答 -404：这个稿件确实没了，从继续观看里去掉");
                    /* stopPlayback below has already repainted the grid from
                     * cache — synchronously, before this answer arrived — so
                     * the card is still on screen, under the ring, and one
                     * more press repeats the whole round trip. Repaint now,
                     * if the viewer is still looking at that grid. */
                    repaintResumeStrip();
                });
            } else {
                trouble(loginNeeded(whyText) || ("播放失败：拿不到播放地址（" + whyText.slice(0, 60) + "）"));
            }
            failOut();
        }

        /* The lesson's fourth request. Only with an access_key: the app
         * endpoint signs the token from it, and without one the "strong" token
         * is the weak one wearing a different platform (the 4-of-12-tiers
         * lesson of 08-11). Fails soft — got.strong becomes null and decide()
         * takes the web manifest exactly as before, with the 403 escalation
         * still available downstream. */
        var hintAid = Player.strongHint(cid);
        if (hintAid && Auth.isLoggedIn() && Auth.accessKey()) {
            got.strong = undefined;
            var early = pre && pre.strong;
            report("player", "沿用教训：这个视频 web 令牌必被拒，" +
                   (early ? "用倒计时里就开始铸的强令牌" : "开播直接铸 app 端点强令牌") +
                   "（aid=" + hintAid + "）");
            (early ? function (ok, fail) { whenSettled(early, ok, fail); }
                   : function (ok, fail) { mintStrong(hintAid, cid, Settings.qnCap(), ok, fail); })(function (sd) {
                if (playing !== session) { report("player", "教训强令牌回来时会话已经没了，丢弃"); return; }
                got.strong = sd;
                decide();
            }, function (why) {
                if (playing !== session) { return; }
                report("player", "教训里的强令牌铸不出来（" + why + "），改回 web 清单，教训作废");
                Player.learnStrong(cid, 0);
                got.strong = null;
                decide();
            });
        } else if (pre && (pre.strong || pre.warmRefused) &&
                   Auth.isLoggedIn() && Auth.accessKey() && (pre.aid || detail.aid)) {
            /* The warm-up already asked the CDN, and it said 403 to the web
             * token — the evidence the lesson path waits a failed playback
             * for, gathered before the press. Go to the strong token without
             * first spending the web manifest's 403s (and the limiter's
             * patience) on proving it again. On the chooser screen the mint
             * was started during the countdown; elsewhere it starts now.
             * No lesson is written: that stays reserved for evidence from an
             * actual playback. */
            got.strong = undefined;
            got.strongWhy = "预热";
            var slotSt = pre.strong || prefetchSlot(function (ok, fail) {
                mintStrong(pre.aid || detail.aid, cid, Settings.qnCap(), ok, fail);
            });
            report("player", "预热时 web 令牌已被拒（" + (pre.warmRefused || "403") + "），" +
                   (pre.strong ? "用按下前就开始铸的强令牌" : "开播直接铸 app 端点强令牌"));
            whenSettled(slotSt, function (sd) {
                if (playing !== session) { report("player", "预热强令牌回来时会话已经没了，丢弃"); return; }
                got.strong = sd;
                decide();
            }, function (why) {
                if (playing !== session) { return; }
                report("player", "预热路上的强令牌铸不出来（" + why + "），改回 web 清单");
                got.strong = null;
                got.strongWhy = "";
                decide();
            });
        } else if (webRefusedAt && new Date().getTime() - webRefusedAt < WEB_REFUSED_WINDOW &&
                   Auth.isLoggedIn() && Auth.accessKey() && (detail.aid || (pre && pre.aid))) {
            /* C: another video's web token was refused within the window, so
             * this one goes to the strong token at once rather than proving the
             * refusal again with its own 403s. The mint asks the web endpoint
             * in parallel anyway (codecs, and now the indexes), so the extra
             * cost on a day the web token would have worked is the app
             * endpoint's ~300 ms. No lesson is written: nothing about this
             * video was observed. */
            got.strong = undefined;
            got.strongWhy = "近来被拒";
            report("player", Math.round((new Date().getTime() - webRefusedAt) / 60000) +
                   " 分钟前别的视频 web 令牌被拒过，这个视频直接铸 app 端点强令牌");
            mintStrong(detail.aid || pre.aid, cid, Settings.qnCap(), function (sd) {
                if (playing !== session) { report("player", "近来被拒那条路的强令牌回来时会话已经没了，丢弃"); return; }
                got.strong = sd;
                decide();
            }, function (why) {
                if (playing !== session) { return; }
                report("player", "近来被拒那条路的强令牌铸不出来（" + why + "），改回 web 清单");
                got.strong = null;
                got.strongWhy = "";
                decide();
            });
        }

        ask(pre && pre.dash, function (ok, fail) {
            API.playurlDash(detail.bvid, cid, Settings.qnCap(), ok, fail);
        }, function (dash) {
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
            got.dashWhy = dashWhy;
            decide();
        });

        ask(pre && pre.prog, function (ok, fail) {
            API.playurlProgressive(detail.bvid, cid, Settings.qnCap(), ok, fail);
        }, function (r) {
            if (playing !== session) { return; }
            report("player", "progressive gave qn=" + r.quality +
                   " accept=" + (r.accept || []).join(","));
            got.prog = r;
            decide();
        }, function (why) {
            if (playing !== session) { return; }
            report("player", "no durl (" + why + ")");
            got.prog = null;
            got.progWhy = why;
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

        ask(preResume, function (ok, fail) {
            API.playerV2(detail.bvid, cid, ok, fail);
        }, function (r) {
            clearTimeout(resumeTimer);
            if (playing !== session) { return; }
            /* Resume's 1.2s deadline must not discard a later subtitle list. */
            session.subtitleTracks = r.subtitles || [];
            startSubtitles();
            if (got.resume !== undefined) { return; }
            got.resume = r;
            decide();
        }, function (why) {
            clearTimeout(resumeTimer);
            if (playing !== session) { return; }
            /* Where the subtitle list comes from, too: without this line a
             * missing subtitle left nothing in the log (10-24 selftest). */
            if (subtitlesEnabled()) { report("subtitle", "player/v2 没问到（" + why + "），这次没有字幕"); }
            if (got.resume !== undefined) { return; }
            got.resume = null;
            decide();
        });
    }

    /* A kept DASH response is only as good as its signatures. `deadline` is
     * stamped by api.js from the urls themselves (unix seconds, about two hours
     * from playurl); past it, every segment request 403s and a restart that
     * reuses the response cannot possibly work. Five minutes of margin, because
     * the restart takes time too and a manifest that expires mid-rebuild fails
     * the same way. The age fallback covers a payload with no parseable
     * deadline rather than trusting it forever. */
    function dashIsStale(dash) {
        if (!dash) { return false; }
        if (dash.deadline) {
            return new Date().getTime() / 1000 > dash.deadline - 300;
        }
        if (dash.fetchedAt) {
            return new Date().getTime() - dash.fetchedAt > 3600000;
        }
        return false;
    }

    /* Hand a DASH response to the player and label it with the representation
     * the player itself picked, so the badge cannot disagree with the picture. */
    function playDash(dash, qn) {
        playing.route = "dash";
        /* The latest response in hand, as an invariant of this wrapper rather
         * than a courtesy of decide() — the in-place replay reaches for it. */
        playing.dashReady = dash;
        /* A fresh web manifest re-arms the strong-token escalation. The flag
         * means "tried for this manifest", not "spent for this video" — the
         * 12-hour session of 2026-08-12 proved the difference: strong was used
         * at 00:05, the 12:46 fallback fetched a new web manifest, and the
         * 12:48 403s on it had no escalation left. Mirrors strongEmitted's
         * re-arm inside the player. */
        /* Mirrors player.js: a web manifest that already spent its strong-token
         * try (marked on the object) does not get another on a handback. */
        if (!dash.strong && !dash.strongTried) { playing.triedStrong = false; }
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
        el("player-loading").className = "";
        report("player", "progressive refused (" + why + "), switching to dash");
        Player.learnRoute(playing.cid, "dash");

        /* Tear AVPlay down *here*, before asking for the manifest — not inside
         * Player.playDash a round trip later.
         *
         * Its listener is registered on the avplay singleton and close() does
         * not detach it, so the tail of the attempt that just failed keeps
         * arriving for seconds afterwards; the log shows those errors landing
         * after this very line. With `failed` cleared they were handled as if
         * they were fresh, found every route already tried, and called
         * stopPlayback() — which nulls `playing` and walks back to the grid. So
         * when the manifest finally arrived it landed on a dead session and was
         * dropped without a word. Four attempts in a row reached "switching to
         * dash" and not one ever built a manifest; from the sofa that is a long
         * spinner and then the home screen.
         *
         * reset() bumps the generation counter, and that is the thing that
         * actually silences the old listener — the standing rule in this
         * codebase, missed at exactly the point where one route hands over to
         * the other. It also moves AVPlay's stop/close off the critical path:
         * they cost about 570ms and now run alongside the playurl round trip
         * instead of after it. */
        Player.stop();
        playing.failed = false;

        /* The fallback's own clock. The 到画面 line for this video has already
         * been printed — off AVPlay's fake `playing` event, seconds before the
         * failure — so without this the leg that actually delivers the picture
         * leaves no timing at all. */
        Player.startTiming();
        playing.timed = false;
        playing.timedLabel = "到画面(兜底)";

        var d = playing.detail, cid = playing.cid, session = playing;

        /* All three exits here used to be silent, which is why the log could
         * say "switching to dash" and then say nothing at all — a dead session,
         * a refused request and a manifest that was never built are three
         * different faults and they read identically. */
        function startDash(dash, how) {
            if (playing !== session) {
                report("player", "dash 兜底：清单到了但会话已经没了，丢弃");
                return;
            }
            var vrep = Player.pickDashVideo(dash);
            report("player", "dash 兜底：" + how + " qn=" + ((vrep && vrep.id) || 0) +
                   "，交给播放器");
            /* Through playDash(), not Player.playDash() directly — the wrapper
             * owns the `dashReady` invariant. Bypassing it here left dashReady
             * pointing at the manifest this fallback had just replaced, and
             * twelve hours later (2026-08-12 12:49) the low-tier retry handed
             * that expired corpse back to the player and exited to the grid.
             *
             * playDash reads `playing.startMs`, not a fresh Resume lookup.
             * play() already settled where this video starts, and that answer
             * folds in things the local list has never heard of: a handoff
             * from the phone, and bilibili's own `player/v2` position for this
             * account. Reading Resume again here silently discarded both — so
             * a video picked up from the phone at forty minutes restarted
             * wherever this television last left it, but *only* when the
             * progressive attempt failed first, which is why it never looked
             * like a rule. */
            playDash(dash, (vrep && vrep.id) || playing.quality || 0);
        }

        /* play() asked for both forms at once, and this is the other one —
         * unless its signatures have expired while progressive struggled. */
        if (playing.dashReady && !dashIsStale(playing.dashReady)) {
            startDash(playing.dashReady, "复用开播时取到的清单");
            return;
        }
        if (playing.dashReady) {
            report("player", "dash 兜底：开播时的清单已过期，重取 playurl");
        }

        API.playurlDash(d.bvid, cid, Settings.qnCap(), function (dash) {
            startDash(dash, "重新取到清单");
        }, function (w2) {
            report("player", "dash 兜底：playurl 失败（" + w2 + "）" +
                   (playing !== session ? "，而且会话已经没了" : ""));
            if (playing !== session) { return; }
            trouble("播放失败：" + w2);
            failOut();
        });
    }

    /* bvid plus a slice of title — the shape every playback line carries, so a
     * sofa report can be matched to a log line without guessing at bvids. */
    function videoTag(d) {
        return (d.bvid || "?") + " " + Diag.priv(String(d.title || "").slice(0, 24));
    }

    /* A full view() payload landing on a session, from whichever path fetched
     * it — the first-frame hook or the 403 rescue's aid lookup. One writer, so
     * the two cannot disagree about what "loaded" means, and a list the rescue
     * fetched is not thrown away only to be fetched again a second later. */
    function absorbMeta(session, full) {
        full.related = session.detail.related;
        if (!full.publishedAt) { full.publishedAt = session.detail.publishedAt || 0; }
        /* aid may already have been filled in by withAid() on the 403 path; a
         * full view() carries it too, so nothing is lost. */
        session.detail = full;
        if (session === playing && session.shown && chargeOnly() && !session.chargeNoted) {
            session.chargeNoted = true;
            toast("这是 UP 主的充电专属视频，没充电只能看试看的一段");
        }
        session.metaState = "done";
        session.metaWhy = "";
        refreshPartLabel();
        /* The panel paints from the detail each time it opens, so a list
         * arriving while it was already up stayed invisible until the viewer
         * closed and reopened it. Painted in place, not by reopening. */
        if (optionsOpen) {
            paintParts();
            paintSeason();
            paintEpisodeControls();
            paintPanelActions();
            loadPanelActions();
            loadFollow(el("panel-follow"), full.mid);
            paintDesc(full.desc);
            var meta = el("panel-meta").querySelector(".panel-meta-rest");
            if (meta) {
                meta.textContent = [full.duration, full.play ? full.play + "次观看" : "",
                    publishedDate(full.publishedAt) ? "发布于 " + publishedDate(full.publishedAt) : ""]
                    .filter(function (x) { return !!x; }).join("  ·  ");
            }
        }
    }

    /* Runs once the stream is playing, so the description, parts and related
     * list arrive without contending with the player for the network. */
    function loadMetaForPlaying() {
        if (!playing || !playing.needsMeta) { return; }
        playing.needsMeta = false;
        var session = playing, d = session.detail;

        /* metaState was seeded in play(): "done" when the detail came with a
         * part list, "pending" otherwise. Only the fetch below moves it. */
        if (!d.pages || !d.pages.length) {
            API.view(d.bvid, function (full, via) {
                if (playing !== session) {
                    report("meta", videoTag(d) + " view 回来时已经换了视频，丢弃（" + via + "）");
                    return;
                }
                /* Every time, not only on the fallback: a night with no
                 * `meta:` lines must mean no view() was needed, not that the
                 * plain path quietly worked — or quietly was never asked. */
                report("meta", videoTag(d) + " " + via);
                absorbMeta(session, full);
            }, function (why) {
                if (playing !== session) {
                    report("meta", videoTag(d) + " view 失败后已经换了视频，丢弃（" + why + "）");
                    return;
                }
                /* This used to be `function () {}`. A 412 from view() — which
                 * is what 2026-09-07 was — then read as "single-part video"
                 * on the panel and left nothing in the log. */
                session.metaState = "failed";
                session.metaWhy = String(why);
                report("meta", videoTag(d) + " view 失败（" + why +
                       "）：分 P 列表、简介都拿不到，403 那条路也换不到 aid");
                if (optionsOpen) { paintParts(); }
            });
        }
        if (!d.related) {
            API.related(d.bvid, function (list) {
                if (playing !== session) {
                    report("meta", videoTag(d) + " 相关视频回来时已经换了视频，丢弃");
                    return;
                }
                session.detail.related = list;
                /* In place, like the part list: reopening the panel reset its
                 * scroll and yanked the ring back to 「当前」. */
                if (optionsOpen) { panelGrid.reset(list, panelFirst()); }
            }, function (why) {
                if (playing !== session) { return; }
                report("meta", videoTag(d) + " 相关视频取不到（" + why + "）");
            });
        }
    }

    /* The app endpoint mints its stream token from an aid, and an aid is not
     * always in hand — the strong-token branch explains why the videos that
     * need it are precisely the ones least likely to have one. One view() round
     * trip, paid only on the 403 path and never on a healthy start. Fills the
     * aid back into the session so a second 403 on the same video does not pay
     * it twice, and patches the field rather than replacing detail wholesale:
     * that object is also carrying `related`, which the finished-screen grid
     * reads. */
    function withAid(session, cb) {
        var d = session.detail;
        if (d && d.aid) { cb(d.aid); return; }
        if (!d || !d.bvid) { cb(0); return; }
        report("player", "手里没有 aid（这个入口的卡片不带），先用 bvid 换一次");
        API.view(d.bvid, function (full, via) {
            if (playing !== session) {
                report("player", "用 bvid 换 aid 回来时已经换了视频，丢弃");
                return;
            }
            report("meta", videoTag(d) + " " + via + "（为换 aid 而问）");
            /* The same payload the first-frame hook would fetch: keep all of
             * it, so the panel has its list and that hook has nothing to ask.
             * Also the only way out of a "failed" state — the first-frame
             * fetch runs once, and a later success here used to leave the
             * panel saying 「加载失败」 with 24 parts in hand. */
            if (full && full.pages && full.pages.length) { absorbMeta(session, full); }
            else if (full && full.aid) { session.detail.aid = full.aid; }
            cb((full && full.aid) || 0);
        }, function (why) {
            if (playing !== session) {
                report("player", "用 bvid 换 aid 失败后已经换了视频，丢弃（" + why + "）");
                return;
            }
            report("player", "用 bvid 换 aid 失败（" + why + "）");
            cb(0);
        });
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
            ? playing.detail.bvid + " " + Diag.priv(String(playing.detail.title || "").slice(0, 24))
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
    /* 10-24: one set's every heartbeat came back HTTP 403 on both routes, and
     * those were 229 of the 600 lines its upload carried. Each different
     * answer is said once a run. */
    var historyFailSeen = {};

    function reportProgress(secs, force, durSecs) {
        if (!playing || !Auth.isLoggedIn()) { return; }
        /* The danmaku frame-time run plays a stranger's video for minutes;
         * that is not something this account watched. */
        if (window.__stNoHistory) { return; }
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
            if (historyFailSeen[why]) { return; }
            historyFailSeen[why] = true;
            report("history", "上报失败 " + d.bvid + " " + secs + "s：" + why + "（同样的失败这次运行不再记）");
        });
    }

    /* `then`, when given, is where to go instead of back to the grid — the
     * uploader page, opened from the panel or the end-of-video chooser. It runs
     * after the wake refresh has been paid, so a page opened on a set that slept
     * through the video still sits on top of a fresh home feed. */
    /* Where the time goes between 返回 and the grid (10-22, 「按返回键感觉卡顿」):
     * each synchronous step, then the frames after it — a stall a viewer
     * feels is a long frame, not a long function. One line per exit. */
    function backTimer(what) {
        var t0 = new Date().getTime(), last = t0, parts = [];
        return {
            mark: function (name) {
                var t = new Date().getTime();
                parts.push(name + "=" + (t - last));
                last = t;
            },
            done: function (extra) {
                var sync = new Date().getTime() - t0, prev = 0, first = 0, worst = 0, slow = [], n = 0;
                function frame() {
                    var t = new Date().getTime();
                    if (!first) { first = t - t0; }
                    else {
                        var gap = t - prev; n++;
                        if (gap > worst) { worst = gap; }
                        if (gap > 50) { slow.push(gap + "@" + (prev - t0)); }
                    }
                    prev = t;
                    if (t - t0 < 1500) { window.requestAnimationFrame(frame); return; }
                    /* Only the slow ones: every 返回 and every panel would fill the diagnostics ring. */
                    if (first <= 100 && worst <= 150) { return; }
                    var u = Player.lastUnload();
                    report("perf", what + " 同步 " + sync + "ms（" + parts.join(" ") + "）· 第一帧 " + first + "ms · 之后 " + n +
                           " 帧里最长 " + worst + "ms" + (slow.length ? "，超过 50ms 的（时长@起点）" + slow.join(" ") : "") +
                           (u && u.at >= t0 ? " · 播放器卸载 " + u.ms + "ms（按返回后 " + (u.at + u.ms - t0) + "ms 完成）" : "") +
                           (extra ? " · " + extra : ""));
                }
                try { window.requestAnimationFrame(frame); } catch (e) {}
            }
        };
    }

    var backMark = function () {};   /* the running backTimer's mark, for the steps inside showScreen */
    function stopPlayback(then) {
        var bt = backTimer("返回到网格");
        backMark = bt.mark;
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
        bt.mark("上报");
        Resume.flush();
        bt.mark("存进度");
        cancelScrub();
        closeComments(true);
        closeEpisodeList(true);
        closeOptions();
        el("pause-glyph").className = "hidden";
        cancelNext();
        playedInChain = {};
        backStack = [];
        bt.mark("关面板");
        var mode = Player.mode();
        Player.stop();
        bt.mark("拆播放器");
        playing = null;
        clearSubtitles();
        clearDanmaku();
        bt.mark("清弹幕字幕");
        showPlayerUi(false);
        bt.mark("显示网格层");
        /* Unless the set slept through the middle of this video, in which case
         * what is behind the player is last night's screen and the owed refresh
         * is paid here instead of restoring it. */
        var owed = payOwedWake();
        if (then) { then(); return; }
        if (owed) { return; }
        /* Back to the grid the viewer was browsing, at the card they picked. */
        showScreen(state.screen, true);
        bt.mark("画网格");
        backMark = function () {};
        bt.done(state.screen + " " + screenEl.querySelectorAll(".card").length + " 张卡片 · 每行 " + gridColumns() + " · 播放器 " + mode);
    }

    /* Every key, timed to the frames after it (10-22, after 返回 went from
     * ~280 ms to ~50 ms: 「再看看还有哪些地方可以优化体验」). A line only when it
     * was slow — the first frame or any frame in the next 0.6 s over 100 ms,
     * which a viewer feels as the set ignoring the remote for a moment. One
     * measurement at a time: a held key's repeats are the same press. */
    (function () {
        var NAMES = {};
        for (var k in Nav.KEY) { if (Nav.KEY.hasOwnProperty(k)) { NAMES[Nav.KEY[k]] = k; } }
        var measuring = false;
        function where(node) {
            var ctx = playing ? "播放中" + (optionsOpen ? "·面板" : "") : liveRoom ? "直播" : state.screen;
            if (!node) { return ctx; }
            var name = node.id || (node.getAttribute && node.getAttribute("data-screen")) ||
                       String(node.className || "").split(" ")[0] || node.tagName;
            return ctx + " " + name;
        }
        document.addEventListener("keydown", function (e) {
            if (measuring || !window.requestAnimationFrame) { return; }
            measuring = true;
            var t0 = new Date().getTime(), key = NAMES[e.keyCode] || String(e.keyCode), at = where(Nav.current());
            var prev = 0, first = 0, worst = 0, worstAt = 0;
            function frame() {
                var t = new Date().getTime();
                if (!first) { first = t - t0; }
                else if (t - prev > worst) { worst = t - prev; worstAt = prev - t0; }
                prev = t;
                if (t - t0 < 600) { window.requestAnimationFrame(frame); return; }
                measuring = false;
                if (first > 100 || worst > 100) {
                    report("perf", "按键 " + key + "（" + at + " → " + where(Nav.current()) + "）第一帧 " + first + "ms" +
                           (worst > 100 ? "，之后最长 " + worst + "ms@" + worstAt : ""));
                }
            }
            window.requestAnimationFrame(frame);
        }, true);
    })();

    Player.on(function (kind, data) {
        if (liveRoom) {
            if (kind === "log") { report("live", data); }
            else { onLiveEvent(kind, data); }
            return;
        }
        if (kind === "time") {
            if (playing) {
                paintSubtitleAt(data.position);
                if (dm && playing.danmakuStarted) { dm.tick(data.position, !viewerPaused); }
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
                if (!window.__stNoHistory) {
                    Resume.record(d0.bvid, playing.cid, data.position, data.duration, {
                        bvid: d0.bvid, aid: d0.aid, title: d0.title, pic: d0.pic,
                        author: d0.author, duration: d0.duration, play: d0.play,
                        publishedAt: d0.publishedAt || 0,
                        cid: playing.cid, page: pg, part: ptitle
                    });
                }
            }
            lastKnownPosition = data.position;
            lastKnownDuration = data.duration || lastKnownDuration;
            /* The in-place restart is once per *incident*, not once per video.
             * Spent-and-never-refilled it turned a 33-minute episode into a
             * minefield: one bad patch at 13 minutes used the restart, and the
             * next one — 2026-08-03 it was five minutes later — had nothing
             * left and exited a video that was otherwise playing fine. Ninety
             * seconds of actual progress past the restart point says the
             * restart worked; earn the budget back. Progress, not wall time:
             * `time` does not tick while frozen. */
            if (playing && playing.replayed &&
                    lastKnownPosition - (playing.startMs || 0) > 90000) {
                playing.replayed = false;
            }
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
        } else if (kind === "tokenSwap") {
            /* B: the web token was refused mid-play and the player kept going
             * on its buffer (`data` is how many seconds of it). Mint the strong
             * token and hand it over; anything short of that falls back to the
             * 403 handler's rebuild through Player.swapFailed. Not marked
             * triedStrong until it worked, so that fallback is still open. */
            noteWebRefused();
            if (!playing || playing.route !== "dash" || playing.triedStrong ||
                    !Auth.isLoggedIn() || !Auth.accessKey()) {
                Player.swapFailed(!playing ? "会话已经没了" : "这个会话换不了强令牌");
                return;
            }
            var sessSw = playing, swapT0 = new Date().getTime(), webSw = playing.dashReady;
            report("player", "播放中 web 令牌被拒（403），后台铸 app 端点强令牌，缓冲区里还有 " +
                   Math.round(data || 0) + " 秒，接着放");
            /* One mint, held in a slot: should the player give up waiting (its
             * ten seconds), the 403 rebuild that follows waits on this same
             * slot instead of minting a second strong manifest into a CDN that
             * is busy refusing us (review, 10-20). */
            sessSw.swapSlot = prefetchSlot(function (ok, fail) {
                withAid(sessSw, function (aid0) {
                    if (!aid0) { fail("手里没有 aid"); return; }
                    sessSw.swapAid = aid0;
                    mintStrong(aid0, sessSw.cid, Settings.qnCap(), ok, fail, webSw);
                });
            });
            whenSettled(sessSw.swapSlot, function (sd) {
                var aidSw = sessSw.swapAid;
                if (playing !== sessSw) { report("player", "换令牌：强令牌回来时会话已经没了，丢弃"); return; }
                var swapRes = Player.swapToken(sd);
                /* The player stopped waiting; the 403 rebuild has this slot. */
                if (!swapRes) { report("player", "换令牌：强令牌回来时播放器已经不在等它了，交给重建那条路"); return; }
                if (swapRes.partial) {
                    rebuildOnStrong(sessSw, sd, aidSw, "换令牌：强令牌只对上正在用的 " + swapRes.inUseCovered +
                                    "/" + swapRes.inUse + " 份文件（全部 " + swapRes.covered + "/" + swapRes.total + "）");
                    return;
                }
                if (!swapRes.covered) {
                    Player.swapFailed("强令牌的 " + ((sd.video || []).length + (sd.audio || []).length) +
                                      " 份文件和正在放的 " + swapRes.total + " 份一份都对不上");
                    return;
                }
                playing.triedStrong = true;
                if (webSw) { webSw.strongTried = true; }
                playing.dashReady = sd;
                Player.learnStrong(sessSw.cid, aidSw);
                report("player", "换上了强令牌，没有重建：" + swapRes.covered + "/" + swapRes.total +
                       " 份文件改走 app 端点的签名，铸令牌 " + (new Date().getTime() - swapT0) + "ms" +
                       (sd.strongTiming ? "（" + sd.strongTiming + "）" : ""));
            }, function (why) {
                if (playing !== sessSw) { return; }
                Player.swapFailed("强令牌铸不出来：" + why);
            });
        } else if (kind === "status") {
            /* The ladder is acting and the screen must say so — a minute of
             * self-rescue that looks identical to a crash is what got the app
             * force-quit on 08-04 and complained about on 08-09. Shown on the
             * loading overlay whether this is the first frame or a mid-play
             * rescue: by the time a rung fires the picture is dead either
             * way, and a spinner with a sentence beats a frozen frame. */
            if (!playing) { return; }
            el("loading-status").textContent = data;
            el("player-loading").className = "";
        } else if (kind === "playing") {
            el("player-loading").className = "hidden";
            el("loading-status").textContent = "";
            /* Where the seconds before a picture actually went. Without this,
             * "it takes a few seconds" has at least five candidate causes and
             * no way to tell them apart from the sofa. */
            /* Once per video. The element fires `playing` again after every
             * seek and every resume, and `mark()` only records the first of
             * each — so the line was being printed four or five times per video
             * with the same numbers, which reads like four starts. */
            if (playing && !playing.timed) {
                playing.timed = true;
                /* The fallback and the in-place restart re-arm this with their
                 * own label and their own clock — the original line has already
                 * been printed by then, off AVPlay's fake `playing` event, and
                 * CLAUDE.md had to warn readers not to trust it. Now each leg
                 * reports its own truth instead. */
                /* The note belongs to the first line only — the fallback and the
                 * restart lines are later legs on the same session. */
                /* 按下起 only on the first picture: a mid-play rescue's line
                 * is about the rescue, and minutes since the press say nothing. */
                var sincePress = playing.shown ? "" :
                    "按下起=" + (new Date().getTime() - playing.pressedAt) + "ms ";
                playing.shown = true;
                report("player", (playing.timedLabel || "到画面") + " " + sincePress + Player.timings() +
                       (playing.prefetchNote ? " | " + playing.prefetchNote : ""));
                playing.prefetchNote = "";
            }
            /* A 充电专属 video that plays is its 试看 clip: say so once, or its
             * end reads as the app cutting out (10-20). */
            if (chargeOnly() && !playing.chargeNoted) {
                playing.chargeNoted = true;
                toast("这是 UP 主的充电专属视频，没充电只能看试看的一段");
            }
            loadMetaForPlaying();
            startSubtitles();
            startDanmaku();
            /* The duration is only real once there is a picture, and the marks
             * are placed as a fraction of it. */
            paintChapters();
        } else if (kind === "buffering") {
            el("player-hint").textContent = data ? "缓冲中…" : HINT;
            /* 「缓冲中…」 is written inside the banner, and the banner is gone four
             * seconds after the last keypress — so for a viewer who is simply
             * watching, a stall has always been a frozen picture with nothing on
             * screen to explain it. That window used to end at 10s when the
             * watchdog fired and the ladder put 「网络不顺，正在自动重试…」 on the
             * loading overlay; today's connectionTimeout change moved the
             * watchdog to 14s so that Shaka's own retry gets a turn first, which
             * quietly made the silent window longer. So the banner comes back by
             * itself when a stall outlasts two and a half seconds — long enough
             * that an ordinary buffer blip does not flash it up, short enough
             * that nobody sits looking at a frozen frame wondering. It hides
             * itself again once playback resumes, the way it always did. */
            if (data) {
                if (!bufferNoticeTimer) {
                    bufferNoticeTimer = setTimeout(function () {
                        bufferNoticeTimer = null;
                        if (playing && !scrub) { showChrome(); }
                    }, 2500);
                }
            } else if (bufferNoticeTimer) {
                clearTimeout(bufferNoticeTimer);
                bufferNoticeTimer = null;
            }
        } else if (kind === "ended") {
            if (playing) { playing.subtitleCues = []; }
            clearSubtitles();
            clearDanmaku();
            if (playing) {
                Resume.finished(playing.detail.bvid, playing.cid);
                reportProgress(-1, true);   /* -1 is bilibili's "watched to the end" */
            }
            closeComments(true);
        closeEpisodeList(true);
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

            /* Expiry is the one fault no rung can fix — every rebuild from the
             * kept response 403s on every tier — and after an overnight suspend
             * it is the *first* fault: the player refuses to rebuild from a
             * stale response now and raises this instead. The answer is a
             * refetch from where the viewer is; if the manifest that expired
             * was a strong-token one, refetch strong directly — the weather
             * that demanded it has not changed just because the clock ran out.
             * Bounded twice per session: a fresh response passes the player's
             * guard by fetchedAt so this cannot ping-pong, but a silent loop
             * is this codebase's most expensive failure shape, so the cap
             * stays anyway. */
            if (playing.route === "dash" && playing.detail &&
                    String(data).indexOf("清单已过期") >= 0 &&
                    (playing.expiredRefetches || 0) < 2) {
                playing.expiredRefetches = (playing.expiredRefetches || 0) + 1;
                var atExp = Player.hasPosition() ? Player.position()
                          : (lastKnownPosition || playing.startMs || 0);
                var wantStrong = !!(playing.dashReady && playing.dashReady.strong &&
                                    playing.detail.aid);
                playing.failed = false;
                playing.startMs = atExp;
                el("player-loading").className = "";
                Player.startTiming();
                playing.timed = false;
                playing.timedLabel = "到画面(过期重取)";
                report("player", "清单已过期，重取 playurl（" +
                       (wantStrong ? "app 端点强令牌" : "web 端点") + "），从 " +
                       fmt(atExp) + " 接着放");
                var sessExp = playing;
                Player.stop();
                var startExp = function (dashExp) {
                    if (playing !== sessExp) { report("player", "过期重取回来时会话已经没了，丢弃"); return; }
                    var repExp = Player.pickDashVideo(dashExp);
                    playDash(dashExp, (repExp && repExp.id) || Settings.qnCap());
                };
                var webExp = function () {
                    API.playurlDash(sessExp.detail.bvid, sessExp.cid, Settings.qnCap(),
                        startExp, function (whyExp) {
                            if (playing !== sessExp) { report("player", "过期重取回来时会话已经没了，丢弃"); return; }
                            report("player", "过期重取 playurl 失败（" + whyExp + "）");
                            finalFallback("清单过期且重取失败 " + whyExp);
                        });
                };
                if (wantStrong) {
                    mintStrong(sessExp.detail.aid, sessExp.cid,
                        Settings.qnCap(), startExp, function (whyStExp) {
                            if (playing !== sessExp) { report("player", "过期重取回来时会话已经没了，丢弃"); return; }
                            report("player", "过期重取强令牌失败（" + whyStExp +
                                   "），改试 web 端点");
                            webExp();
                        });
                } else {
                    webExp();
                }
                return;
            }

            /* A web-token 403 goes to the app endpoint FIRST — before the
             * in-place restart, before mirror rotation, before anything. Those
             * restart the same web manifest whose token the CDN is refusing, so
             * they cannot succeed; worse, each one is another burst of refused
             * requests that fills this CDN's per-IP limiter, and the strong
             * token's own sidx reads then get throttled too (2026-08-11: the
             * restart-first ordering left the strong manifest with 4 tiers of 12
             * and the playhead lost to 0, because by the time it ran the limiter
             * was hot). Straight to the strong token keeps the position and the
             * quiet pipe. Player raises this via offerStrongToken; app.js also
             * reaches it when a load fails outright. */
            if (playing.route === "dash" && !playing.triedStrong &&
                    String(data).indexOf("403") >= 0 &&
                    playing.dashReady && !playing.dashReady.strong &&
                    playing.detail && (playing.detail.aid || playing.detail.bvid)) {
                /* The real playhead — lastKnownPosition freezes at 0 through the
                 * stall that precedes a 403 storm, and 2026-08-11 that rebuilt
                 * the strong manifest from 0:00 instead of where the viewer was. */
                var atMs = Player.hasPosition() ? Player.position()
                         : (lastKnownPosition || playing.startMs || 0);
                playing.triedStrong = true;
                noteWebRefused();
                /* Its segment indexes go with the mint (A): the files are the same. */
                var webForIndex = playing.dashReady;
                /* Stamp the manifest too, as the player-initiated path does:
                 * handing this web manifest back later must not re-arm the
                 * strong-token try it just spent. */
                if (playing.dashReady) { playing.dashReady.strongTried = true; }
                playing.failed = false;
                playing.startMs = atMs;
                el("player-loading").className = "";
                Player.startTiming();
                playing.timed = false;
                playing.timedLabel = "到画面(强令牌)";
                report("player", "web 令牌被拒（403），直奔 app 端点强令牌，从 " +
                       fmt(atMs) + " 重建");
                var sessST = playing;
                /* Tear the failing session down before the multi-second sidx
                 * reads — reset() bumps avGeneration/mseGeneration so the old
                 * Shaka's onerror cannot fire into this window, re-enter the
                 * handler (failed is now false), and race a web-manifest restart
                 * against the strong rebuild. 「任何会启动新播放的入口，第一件事
                 * 都是拆掉旧的」— the rule downgrade() was fixed to obey. atMs was
                 * read above, before this zeroes the playhead. */
                Player.stop();
                /* The aid may not be in hand, and the case where it is missing
                 * is exactly this one. The home feed's cards carry `id` rather
                 * than `aid` (normalise now reads both), and for any card that
                 * still arrives without one, the view() call that would supply
                 * it runs from loadMetaForPlaying — deliberately deferred until
                 * the picture is up so it does not contend with the player. A
                 * video that never gets a picture therefore never gets an aid,
                 * so the route built for videos that cannot start was reachable
                 * only by videos that had already started. Fetch it here rather
                 * than fall through to 「DASH 全灭」. */
                /* A swap's mint already in flight (or landed) is this one. */
                var swapSlotST = sessST.swapSlot;
                withAid(sessST, function (aidST) {
                    if (playing !== sessST) { report("player", "强令牌回来时会话已经没了，丢弃"); return; }
                    if (!aidST) {
                        report("player", "铸不了强令牌：手里没有 aid，用 bvid 也换不到");
                        finalFallback("强令牌缺 aid");
                        return;
                    }
                    (swapSlotST ? function (ok, fail) {
                        report("player", "用换令牌那次正在铸（或已铸好）的强令牌重建，不再铸第二次");
                        whenSettled(swapSlotST, ok, fail);
                    } : function (ok, fail) {
                        mintStrong(aidST, sessST.cid, Settings.qnCap(), ok, fail, webForIndex);
                    })(
                        function (strongDash) {
                            if (playing !== sessST) { report("player", "强令牌回来时会话已经没了，丢弃"); return; }
                            playing.dashReady = strongDash;
                            /* Remembered now, not after a minute of playback:
                             * the fact being recorded — web refused, app
                             * endpoint answered — has already happened. */
                            Player.learnStrong(sessST.cid, aidST);
                            var repST = Player.pickDashVideo(strongDash);
                            report("player", "app 端点强令牌就绪，" +
                                   (strongDash.tierNote || (strongDash.video ? strongDash.video.length + " 档" : "0 档")) +
                                   (strongDash.strongTiming ? "，" + strongDash.strongTiming : "") +
                                   "，从 " + fmt(playing.startMs || 0) + " 重建");
                            playDash(strongDash, (repST && repST.id) || Settings.qnCap());
                        }, function (whyST) {
                            if (playing !== sessST) { report("player", "强令牌回来时会话已经没了，丢弃"); return; }
                            report("player", "app 端点强令牌也不行（" + whyST + "）");
                            finalFallback("强令牌失败 " + whyST);
                        });
                });
                return;
            }
            /* The probe runs on every failure, not only the ones that rotate.
             * It is the line that separates "bilibili refused this stream" from
             * "AVPlay could not ask for it", and that distinction has been worth
             * several deploys. */
            var failedUrl = playing.urls && playing.urls[playing.urlIdx];
            if (failedUrl) { probeUrl(failedUrl, data); }

            /* Mirror rotation is for when progressive is the only route there
             * is. With a manifest already in hand it is a poor way to spend the
             * next six seconds — which is how long AVPlay takes to fail — and
             * measured on this set, three mirrors cost about twenty seconds of
             * black screen before the fallback that actually worked.
             *
             * The candidates do not deserve the time either: bilibili's own
             * `mirrorcosov` spare answers 403 on its own host for every video
             * tried, and the http twins are the same two hosts listed again for
             * AVPlay's older TLS stack, so a full rotation hits each host twice.
             * And when the probe comes back 206 the url and the network were
             * fine and the fault is in how AVPlay asks — which the same player
             * asking a different host does not fix. That is exactly what the
             * 越狱 report turned out to be. */
            var dashWaiting = playing.canDowngrade && !playing.downgraded &&
                              !!playing.dashReady;
            /* `refused` means the probe's plain XHR already came back 403 —
             * the *client* is being turned away, and asking the same hosts
             * from AVPlay four more times at seven seconds apiece changes
             * nothing. Measured 2026-08-03: the hopeless rotation was 25
             * seconds of black screen in front of an exit that was already
             * decided. */
            if (!dashWaiting && !playing.refused &&
                    playing.urls && playing.urlIdx + 1 < playing.urls.length) {
                playing.urlIdx++;
                playing.failed = false;
                /* Was the quietest branch in the handler: it can spend tens of
                 * silent seconds driving AVPlay through mirrors after DASH has
                 * already died — the minute-long log gap of 08-06 13:44. */
                report("player", "渐进式换镜像重试 " + (playing.urlIdx + 1) + "/" +
                       playing.urls.length);
                el("player-loading").className = "";
                Player.playProgressive(playing.urls[playing.urlIdx], playing.startMs || 0);
                return;
            }
            /* Downgrading restarts the video from the top in the other form.
             * That is right when nothing ever played, and wrong once the viewer
             * is watching — a dropped connection at four minutes in used to
             * throw them back to the beginning.
             *
             * Measured from where this video was *asked* to start, not from
             * zero. `lastKnownPosition` is seeded with `startMs` at the top of
             * play(), so on anything with a saved resume point it was already
             * past 3000 before a single frame decoded — and every progressive
             * failure on a half-watched video was swallowed here instead of
             * falling through to DASH. It presented as a spinner that never
             * resolved, and only on videos far enough in to have a position,
             * which is why it read as "some videos, sometimes": the same video
             * downgraded correctly on the next try, once the failed attempt had
             * reset the position to zero.
             *
             * Same distinction the progress report already makes — progress is
             * distance from startMs, never the clock. */
            var watchedMs = lastKnownPosition - (playing.startMs || 0);
            if (watchedMs > 3000) {
                /* This used to log 「保持不动」 and do exactly that — nothing.
                 * The guard was written against stale errors restarting a
                 * healthy video, but stale errors are already filtered by the
                 * generation guards; every error that can still reach this
                 * point is terminal. A media element with an error is dead
                 * until something loads it again, and AVPlay after
                 * PLAYER_ERROR is stopped. So 「保持不动」 preserved a corpse:
                 * frozen picture, no toast, and `playing.failed` swallowing
                 * every later error. The viewer's only exit was the return key
                 * and nothing on screen said so.
                 *
                 * Now: one restart, in place, from where the viewer actually
                 * is. DASH is preferred whatever route was playing — it is the
                 * proven-robust path, and if progressive just died mid-play
                 * there is no case for asking it again. A second terminal
                 * error mid-play gives up audibly; a silent freeze is the one
                 * outcome that is never acceptable. */
                if (!playing.replayed) {
                    playing.replayed = true;
                    playing.failed = false;
                    playing.startMs = lastKnownPosition;
                    el("player-loading").className = "";
                    Player.startTiming();
                    playing.timed = false;
                    playing.timedLabel = "到画面(重启)";
                    if (playing.dashReady && !dashIsStale(playing.dashReady)) {
                        playing.downgraded = true;
                        report("player", "播放中出错（" + data + "），从 " +
                               fmt(lastKnownPosition) + " 用 DASH 原地重启");
                        var rep2 = Player.pickDashVideo(playing.dashReady);
                        playDash(playing.dashReady,
                                 (rep2 && rep2.id) || playing.quality || 0);
                    } else if (playing.dashReady) {
                        /* The kept response has outlived its signatures — the
                         * long-pause case. Restarting from it fails on every
                         * segment; a fresh playurl is the restart that works.
                         * The web player does exactly this. */
                        playing.downgraded = true;
                        report("player", "播放中出错（" + data + "），清单已过期，" +
                               "重取 playurl 后从 " + fmt(lastKnownPosition) +
                               " 用 DASH 原地重启");
                        var session3 = playing;
                        API.playurlDash(playing.detail.bvid, playing.cid,
                                        Settings.qnCap(), function (dash3) {
                            if (playing !== session3) {
                                report("player", "原地重启：新清单到了但会话已经没了，丢弃");
                                return;
                            }
                            var rep3 = Player.pickDashVideo(dash3);
                            playDash(dash3, (rep3 && rep3.id) || playing.quality || 0);
                        }, function (w3) {
                            if (playing !== session3) { report("player", "原地重启的 playurl 回来时会话已经没了，丢弃"); return; }
                            report("player", "原地重启：重取 playurl 失败（" + w3 + "），退出");
                            trouble("播放错误：" + data);
                            failOut();
                        });
                    } else if (playing.urls && playing.urls.length &&
                               !playing.refused) {
                        report("player", "播放中出错（" + data + "），从 " +
                               fmt(lastKnownPosition) + " 原地重启渐进式");
                        Player.playProgressive(playing.urls[playing.urlIdx || 0],
                                               lastKnownPosition);
                    } else {
                        trouble("播放错误：" + data);
                        failOut();
                    }
                    return;
                }
                report("player", "原地重启后仍然出错，退出：" + data);
                trouble("播放错误：" + data);
                failOut();
                return;
            }
            /* Only progressive has anywhere to downgrade *to*. Fired on a video
             * that was already playing DASH, this restarted the identical
             * manifest — same codec family, same mirrors — and announced
             * "progressive refused" about a route that had never been used.
             * Caught on P13: a decode failure on DASH went round this way and
             * failed again three seconds later for exactly the same reason,
             * because nothing about the second attempt was different. A DASH
             * stream that will not decode is answered inside the player, by
             * coming back on H.264 — not here. */
            if (playing.route === "progressive" &&
                    playing.canDowngrade && !playing.downgraded) {
                downgrade(String(data)); return;
            }
            /* The strong-token retry lives at the top of this handler now (a
             * 403 goes there before the in-place restart can waste a round on
             * the same refused web token). By here it has either already run or
             * did not apply, so nothing to do but the shared fallbacks. */
            finalFallback(String(data));
        }

        /* The last two exits, shared so the strong-token retry can fall through
         * to them from its async failure callback. */
        function finalFallback(data) {
            /* Where the viewer actually is. lastKnownPosition zeroes when a
             * failing rebuild ticks t=0 — 2026-08-12 the progressive last
             * resort restarted a 32-minute position 「从 0:00 起」 for want of
             * this — and Player.position() falls back to the ladder's own
             * rebuild-from point, which survives that churn.
             *
             * Asked through `hasPosition` rather than through `||`: a viewer who
             * rewinds to 0:00 has a position, and it is zero. 2026-08-17 the
             * `||` here and in the two rungs above sent one back to 1:08:52
             * twice in two minutes. */
            var ffAt = Player.hasPosition() ? Player.position()
                     : (lastKnownPosition || 0);
            /* DASH is exhausted — but the progressive durl is a different file
             * on a different stack, already in hand from decide()'s parallel
             * fetch, and 「所有路都试过」 is not true until it has been asked.
             * One attempt, flagged so a durl that dies comes back here and
             * exits for real. Position over quality: resuming at 64 beats a
             * toast, and the next video starts fresh at full quality. */
            if (playing.route !== "progressive" && playing.progReady &&
                    !playing.progTried &&
                    playing.progReady.urls && playing.progReady.urls.length) {
                playing.progTried = true;
                playing.failed = false;
                /* DASH is what just died. Without this, the durl failing six
                 * seconds later reads as "progressive refused, try DASH" —
                 * downgrade() reuses the dead manifest and the whole ladder
                 * runs again, another burst of 403s into the limiter before
                 * the exit this was meant to be. */
                playing.downgraded = true;
                playing.startMs = ffAt;   /* progress restarts here */
                playing.route = "progressive";
                playing.quality = playing.progReady.quality;
                playing.urls = playing.progReady.urls;
                playing.urlIdx = 0;
                playing.refused = false;
                report("player", "DASH 全灭（" + data + "），最后一手：渐进式 qn=" +
                       playing.progReady.quality + " 走 AVPlay，从 " +
                       fmt(ffAt) + " 起");
                el("player-loading").className = "";
                setQualityBadge(QUALITY_NAMES[playing.progReady.quality] ||
                                ("QN " + playing.progReady.quality));
                Player.playProgressive(playing.urls[0], ffAt);
                return;
            }
            /* The strong token was tried (or was not applicable) and progressive
             * too — but the web endpoint's mid and low tiers may still serve
             * (480/360p), and the player's tier ladder reaches them. Hand the
             * web manifest back once: the player's strongEmitted flag is set now,
             * so it drops tiers normally instead of raising the strong-token
             * request again. Below progressive because a 720p durl is better than
             * a 480p tier — when the durl is not itself 403, which for these
             * videos it often is. */
            if (playing.route === "dash" && playing.dashReady &&
                    playing.triedStrong && !playing.triedLowDash) {
                playing.triedLowDash = true;
                playing.failed = false;
                playing.startMs = ffAt;
                /* Name the manifest actually being handed back — with the
                 * dashReady invariant it is whichever played last, and on
                 * 2026-08-12 this line claimed 「回到 web 端点」 while handing
                 * over an expired strong manifest, which sent the log reader
                 * down the wrong road. The player's own stale guard bounces an
                 * expired one back for a refetch either way. */
                /* The web manifest kept by the lesson path, when there is
                 * one — this exit exists to reach the web endpoint's low
                 * tiers, and dashReady is the strong manifest then. */
                var backDash = playing.webDash || playing.dashReady;
                report("player", "强令牌与渐进式都不行，回到" +
                       (backDash.strong ? "强令牌清单" : " web 端点") +
                       "压中低档，从 " + fmt(ffAt) + " 起");
                var repL = Player.pickDashVideo(backDash);
                playDash(backDash, (repL && repL.id) || Settings.qnCap());
                return;
            }
            /* Every route has been tried. If the probes came back 403 the
             * content itself is being withheld — reuploads of films get their
             * streams pulled while the page stays up — and "播放错误：
             * PLAYER_ERROR_CONNECTION_FAILED" sends the viewer looking for a
             * network problem that is not there. */
            var refused = playing.refused || String(data).indexOf("403") >= 0;
            /* The viewer gets a toast; the log used to get nothing — an exit
             * that cannot be found afterwards reads as a hang that never
             * ended. */
            report("player", "所有路都试过，有声退出（" +
                   (refused ? "403 被拒" : String(data)) + "）");
            /* Without an account there is no strong token (it needs access_key),
             * and that is the one thing that gets a refused stream through.
             * 10-23/24: two sets on no account, refused on most videos, told
             * to wait a few minutes. */
            trouble(refused
                ? (Auth.accessKey() ? "视频流被拒绝（403）——可能是临时限流，过几分钟再试，或换一个视频"
                                    : "视频流被拒绝（403）——先去「我的」扫码登录再试")
                : "播放错误：" + data);
            failOut();
        }
    });

    /* ---------------- keys ---------------- */

    Nav.onKey(function (k) {
        autoplaysSinceKey = 0;
        if (opening) {
            if (k === Nav.KEY.RETURN) { cancelOpening(); return true; }
            return k !== Nav.KEY.EXIT;
        }
        if (liveRoom) { return liveKey(k); }
        if (barPick) { return barPickKey(k); }
        if (actionView) {
            if (k === Nav.KEY.RETURN) { closeActionMenu(); return true; }
            return false;
        }
        if (episodeView) {
            if (k === Nav.KEY.RETURN) { closeEpisodeList(false); return true; }
            if (k === Nav.KEY.PLAY_PAUSE) { setPaused(!Player.userPaused()); return true; }
            if (k === Nav.KEY.PLAY) { if (Player.userPaused()) { setPaused(false); } return true; }
            if (k === Nav.KEY.PAUSE) { if (!Player.userPaused()) { setPaused(true); } return true; }
            if (k === Nav.KEY.UP || k === Nav.KEY.DOWN || k === Nav.KEY.ENTER) { return false; }
            if (k === Nav.KEY.EXIT) { return false; }
            return true;
        }
        if (commentsView) {
            if (k === Nav.KEY.RETURN) { leaveCommentReplies(); return true; }
            if (k === Nav.KEY.PLAY_PAUSE) { setPaused(!Player.userPaused()); return true; }
            if (k === Nav.KEY.PLAY) { if (Player.userPaused()) { setPaused(false); } return true; }
            if (k === Nav.KEY.PAUSE) { if (!Player.userPaused()) { setPaused(true); } return true; }
            /* TODO: comment likes need a TV-only route that Bilibili accepts.
             * This widget's file origin is rejected (HTTP 403) on reply/action;
             * do not leave an Enter shortcut that makes a known-bad request. */
            if (k === Nav.KEY.ENTER) { return true; }
            if (k === Nav.KEY.RIGHT && !commentsView.root) {
                var cur = Nav.current();
                var index = cur ? Number(cur.getAttribute("data-comment-index")) : -1;
                var row = commentsView.roots[index];
                if (row) { openCommentReplies(row, index); }
                return true;
            }
            if (k === Nav.KEY.UP || k === Nav.KEY.DOWN) { return false; }
            if (k === Nav.KEY.EXIT) { return false; }
            return true;
        }
        if (pendingNext) { return handleNextKeys(k); }
        if (optionsOpen) {
            if (k === Nav.KEY.RETURN) { if (!closeActMore(false)) { closeOptions(); } return true; }
            /* Up from the first row leaves the panel, mirroring the down key
             * that opened it — otherwise return is the only way out and there
             * is nothing on screen that says so. */
            /* Judged by position, not by `scrollTop <= 2`: opening the panel
             * scrolls the current chip into the centre, so scrollTop is well
             * above 2 for almost every video and UP was a dead key. */
            if (k === Nav.KEY.UP && nothingAboveInPanel(Nav.current())) {
                closeOptions(); return true;
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
                /* Toggle against what the viewer asked for, not against the
                 * element. `element.paused` is true for the whole of a load and
                 * of every rescue rebuild — so 确认 pressed during a slow patch
                 * used to read "it is paused" and *resume* a video nobody had
                 * paused, which is the opposite of the press. Third place in
                 * this file to learn that the element answers a different
                 * question from the one being asked; the watchdog and the
                 * banner both got it before this did. */
                setPaused(!Player.userPaused());
                return true;
            /* Remotes with separate keys: nav.js registers them, and they fell
             * into `default` and did nothing. */
            case Nav.KEY.PLAY:
                if (scrub) { commitScrub(); return true; }
                if (Player.userPaused()) { setPaused(false); }
                return true;
            case Nav.KEY.PAUSE:
                if (!Player.userPaused()) { setPaused(true); }
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
                backFromPlayer(); return true;
            case Nav.KEY.EXIT:
                return false;   /* let Nav close the app */
            default:
                return true;
        }
    });

    /* Which function a slow key spent its time in: these are the ones that
     * draw whole screens or panels. A line only over 50 ms. Reassigning the
     * declarations works because every caller looks them up by name. */
    function timed(name, fn) {
        return function () {
            var t0 = new Date().getTime();
            try { return fn.apply(this, arguments); }
            finally {
                var ms = new Date().getTime() - t0;
                if (ms > 50) { report("perf", name + " 用了 " + ms + "ms"); }
            }
        };
    }
    renderMine = timed("renderMine", renderMine);
    renderMineLibrary = timed("renderMineLibrary", renderMineLibrary);
    renderSettings = timed("renderSettings", renderSettings);
    renderSearch = timed("renderSearch", renderSearch);
    renderGrid = timed("renderGrid", renderGrid);
    paintCards = timed("paintCards", paintCards);
    fitCardMeta = timed("fitCardMeta", fitCardMeta);
    openOptions = timed("openOptions", openOptions);
    reopenRelated = timed("reopenRelated", reopenRelated);
    startLiveRoom = timed("startLiveRoom", startLiveRoom);
    switchLive = timed("switchLive", switchLive);
    stopLive = timed("stopLive", stopLive);

    Nav.onBack(function () {
        if (opening) { cancelOpening(); return; }
        if (liveRoom) { stopLive(); return; }
        if (imeOpen) { closeIme(false); return; }
        if (actionView) { closeActionMenu(); return; }
        if (episodeView) { closeEpisodeList(false); return; }
        if (commentsView) { leaveCommentReplies(); return; }
        if (playing) { backFromPlayer(); return; }
        Auth.cancelLogin();
        /* Backing out of "add an account" belongs on the switcher, not on the
         * home feed — the viewer was one press into a two-press errand. */
        if (state.screen === "login" && Accounts.count()) { renderAccounts(false); return; }
        if (isUp(state.screen)) {
            var onKind = state.screen, ur = upReturn;
            upReturn = null;
            if (ur && ur.kind === onKind && ur.detail) {
                /* The tab is only named, not painted: painting it under the
                 * player started its own requests, and their answers moved the
                 * ring onto the hidden screen — 我的's nav() landed it on
                 * 切换账号, one 确认 from opening the switcher behind the video
                 * (review, 10-20). Leaving the video paints it (stopPlayback),
                 * and newView() silences what the UP page still had in flight. */
                state.screen = upFrom;
                newView();
                returnTo(ur);
                return;
            }
            showScreen(upFrom, true);
            return;
        }
        if (state.screen === "mine" && mineView.kind !== "history") {
            mineView = mineView.kind === "videos"
                ? { kind: "folders", id: 0, title: "" }
                : { kind: "history", id: 0, title: "" };
            renderMine();
            return;
        }
        /* Restored, like pressing the 推荐 tab: going back to it used to fetch a
         * new page and drop the place (and every cover), while the tab itself
         * has always come back to where you were. */
        if (state.screen !== "rcmd") { loadFeed("rcmd", true); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    });

    /* ---------------- boot ---------------- */

    window.onload = function () {
        boot.onload = new Date().getTime();
        applyGridDensity();
        screenEl = el("screen");
        statusEl = el("status");
        toastEl = el("toast");
        Diag.init({ report: report });
        API.onNote(report);

        Nav.registerKeys();
        Nav.onNote(function (m) { report("nav", m); });
        Nav.onFocus(function (elm) {
            if (commentsView && elm && elm.getAttribute) {
                var ci = Number(elm.getAttribute("data-comment-index"));
                if (elm.hasAttribute("data-comment-index") &&
                        ci >= commentRows().length - 3) { loadComments(); }
                return;
            }
            maybeLoadMore(elm); maybeLoadMoreSearch(elm);
            schedulePrefetch(elm);
            /* The two paged grids of related videos. The feeds' own version is
             * switched off while either is up (`playing` / `pendingNext` in
             * maybeLoadMore), because these cards carry a `data-i` of their own
             * that would otherwise read as the viewer reaching the end of the
             * grid behind them. */
            if (pendingNext) { nextupGrid.follow(elm, nextupPage()); }
            if (optionsOpen) { panelGrid.follow(elm, panelPage()); }
            if (state.screen === "mine" && !playing && !pendingNext) { histGrid.follow(elm, histPage()); }
        });
        var tabs = document.querySelectorAll("#tabs .tab");
        for (var i = 0; i < tabs.length; i++) { bindTab(tabs[i]); }
        renderUserTabs();

        el("account").onselect = function () {
            Auth.cancelLogin();
            if (Accounts.count()) { renderAccounts(false); }
            else { renderLogin(null); }
        };
        paintAccount();
        refreshActiveProfile();
        /* Answerable with one person in the room: if the bare request comes
         * back signed in, the engine holds a session this code never chose. */
        whoami("启动");

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
                   " | av01=" + can("av01.0.08M.08") +
                   " | 封面=" + API.thumbFormat +
                   /* compat.js's verdicts: flex gap missing (Chromium 69),
                    * grid missing too (56 and older). */
                   " | 布局=" + ((/legacy-no-grid/.test(document.documentElement.className) ? "无grid" :
                                 /legacy-flex-gap/.test(document.documentElement.className) ? "无flex-gap" : "现代")));
        } catch (e) { report("engine", "probe failed: " + e.message); }

        /* A set with more than one person on it asks before showing anyone's
         * recommendations — the same thing a television does when it is shared.
         * With one account there is nothing to ask, and the selftest needs the
         * grid to be what boots. */
        var shared = Accounts.count() > 1;
        var selftest = (typeof SELFTEST !== "undefined" && SELFTEST &&
                        typeof SelfTest !== "undefined");
        if (shared && !selftest) { renderAccounts(true); startBootFeed(); }
        else { loadFeed("rcmd"); }

        /* Alongside the feed, not after it. Both take about the same time, and
         * having the history in hand when the grid paints is the difference
         * between the resume strip being part of the first screen and being a
         * row that appears afterwards. */
        if (Auth.isLoggedIn()) {
            fetchServerHistory(function () { maybeRefreshResumeRow(); });
        }

        /* Suspend and resume, which on this platform is what "turning the
         * television off and on again" means. See the section it belongs to. */
        watchForWake();

        /* Constructing Shaka measured about seven hundred milliseconds, and it
         * is built once and kept — so the only thing in question is when. Doing
         * it here spends it while the viewer is looking at the grid instead of
         * at the black screen before their first video. Late enough that the
         * feed has painted first: a busy main thread during that paint is worse
         * than a slow first play. */
        setTimeout(function () {
            try { Player.prewarm(); } catch (e) {}
        }, 1200);

        /* Well after the feed and the prewarm, and never during a selftest run:
         * this fires off-device requests, and the one thing already measured
         * here is that boot-time fetches lose races to the player. It answers a
         * distribution question, not a playback one — nothing on screen waits
         * for it. */
        /* And only when a collector is listening: the probe's whole output is
         * report lines, and with REPORT_TO empty it was still loading a remote
         * script and touching three hosts on every boot for nobody. */
        if (!selftest) {
            /* Self-update (update.js, 2026-10-18; the capability probe it
             * replaces measured all five routes open on 2026-08-03). It reports
             * which code this launch runs and why, then checks a minute later,
             * never while something plays, and every six hours after that. */
            try { Update.init({ report: report, busy: function () { return !!playing; } }); }
            catch (e) { report("update", "Update.init 抛异常：" + (e && e.message)); }
        }
        /* An update that could not reach the home screen was thrown out by
         * boot.js on this launch. The viewer sees nothing (the package just
         * runs), so this is the only way the developer hears of it. */
        try {
            var bootNote = Boot.info().note || "";
            if (/标坏|选代码时出错/.test(bootNote)) { Diag.incident("更新包启动失败：" + bootNote); }
        } catch (e) {}

        /* This launch's code is good: it got through onload and two seconds of
         * a first screen without a single JS error. boot.js clears its
         * `booting` mark on this; a launch that never says so marks the update
         * it ran as bad and the next launch runs the package. Not tied to the
         * home feed arriving — a network that is down keeps the feed away, and
         * that is no reason to throw away a good version. Harmless on the
         * package's own code. */
        setTimeout(function () {
            if (jsErrors) {
                report("update", "启动后两秒内出过 " + jsErrors + " 次 js 错误，这次启动不算成功（跑的是更新的话，下次打开退回安装包）");
                return;
            }
            if (!screenEl.innerHTML) { report("update", "启动两秒了屏幕上还什么都没有，这次启动不算成功"); return; }
            try { Boot.ok(); } catch (e) {}
        }, 2000);

        if (selftest) { SelfTest.run(); }
    };
})();
