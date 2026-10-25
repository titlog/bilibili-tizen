/* Which code this launch runs: the copy in the installed package, or a newer
 * version update.js downloaded and verified earlier. Also the trust root of
 * self-update — the public key below is the only thing that can make this app
 * run code it was not installed with, and this file is never part of an update.
 *
 * Why it exists (CLAUDE.md 「自动更新」): every copy of this app is sideloaded,
 * and sideloading needs a computer, Tizen tooling and a Samsung certificate.
 * Asking a viewer to redo that for each fix is asking them not to bother.
 *
 * The decision has to be made while the page is still being parsed. app.js
 * starts the client from `window.onload`; a script inserted after parsing ends
 * runs after `load` has already fired, and the app never boots. So the chosen
 * scripts go in through `document.write`, which the parser runs in order, each
 * one finishing before `load` — the same timing the old <script> tags had.
 *
 * Signatures are checked when an update is downloaded (update.js), not here: the
 * bundle comes out of this app's own localStorage, and anything able to write
 * there can already run code in this app. Verifying again would mean an async
 * step in the one place that cannot have one.
 *
 * A bundle that cannot get the app to its first screen is marked bad on the next
 * launch and the package's own code runs instead: `booting` is set just before
 * the bundle's scripts go in, and only Boot.ok() — called by app.js once the
 * home screen is drawn — clears it. ES5, like everything in app/js: the oldest
 * supported set runs Chromium 69. */
var Boot = (function () {
    "use strict";

    /* The bundle contract this file implements: a body, ordered stylesheets and
     * ordered scripts (see tools/update-release.mjs). A release whose boot.js
     * expects something different of a bundle bumps this, and sets with an
     * older boot.js skip that release — it needs a reinstall. */
    var SHELL = 1;

    /* The package's own version, for engines without tizen.application (the
     * desktop devserver). tools/update-verify.mjs keeps it equal to config.xml. */
    var PACKAGED_FALLBACK = "1.4.7";

    /* ECDSA P-256 public key, SPKI, base64. Written by tools/update-key.mjs; the
     * private half never enters the repository. */
    var PUBKEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqkizDOZVUFlUKI+LTuB4trds6XRtB7q+HofMsn+BU9ek7aZNuLN3ouaqE9+BWDTC8mJ1Vr+TtN8jlFSWqVy+cg==";

    /* The package's load order, after config.js (its own tag: deploy.sh
     * rewrites it) and this file. tools/lint.mjs reads this list; a bundle
     * carries its own, so a release can add a file. */
    var SCRIPTS = ["compat.js", "md5.js", "mpd.js", "qr.js", "accounts.js", "auth.js", "resume.js",
                   "settings.js", "diag.js", "api.js", "nav.js", "player.js", "danmaku.js", "episode-nav.js", "app.js", "update.js", "selftest.js"];

    var K_BUNDLE = "bili.update.bundle", K_META = "bili.update.meta",
        K_BOOTING = "bili.update.booting", K_BAD = "bili.update.bad";

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

    function packagedVersion() {
        try {
            var v = tizen.application.getCurrentApplication().appInfo.version;
            if (v) { return String(v); }
        } catch (e) {}
        return PACKAGED_FALLBACK;
    }

    /* Dotted numbers, compared field by field; a missing field is 0. */
    function cmp(a, b) {
        var x = String(a || "").split("."), y = String(b || "").split(".");
        for (var i = 0; i < Math.max(x.length, y.length); i++) {
            var p = parseInt(x[i] || "0", 10) || 0, q = parseInt(y[i] || "0", 10) || 0;
            if (p !== q) { return p > q ? 1 : -1; }
        }
        return 0;
    }

    function badList() { return parse(get(K_BAD)) || {}; }
    function markBad(version) {
        var bad = badList();
        bad[version] = new Date().getTime();
        put(K_BAD, JSON.stringify(bad));
    }
    function drop() { del(K_BUNDLE); del(K_META); del(K_BOOTING); }

    /* What this launch decided, for update.js to report — this file has no
     * diagnostics channel of its own, and a decision nobody can read is how a
     * fallback turns into a mystery. */
    var info = { packaged: packagedVersion(), running: "", note: "" };
    var names = {};   /* blob url → file name, for window.onerror lines */

    function choose() {
        var meta = parse(get(K_META));
        if (!meta || !meta.version) { return null; }
        if (cmp(meta.version, info.packaged) <= 0) {
            /* A newer package was installed by hand since this was downloaded. */
            drop();
            info.note = "下载过的 " + meta.version + " 不比安装包 " + info.packaged + " 新，删掉了";
            return null;
        }
        if ((meta.shell || 1) > SHELL) {
            drop();
            info.note = meta.version + " 要更新的安装包（shell " + meta.shell + "，这台 " + SHELL + "），删掉了";
            return null;
        }
        if (badList()[meta.version]) {
            drop();
            info.note = meta.version + " 在这台电视上启动失败过，用安装包";
            return null;
        }
        if (get(K_BOOTING) === meta.version) {
            markBad(meta.version);
            drop();
            info.note = "上次用 " + meta.version + " 启动没走到首页，标坏，退回安装包 " + info.packaged;
            return null;
        }
        var b = parse(get(K_BUNDLE));
        if (!b || b.version !== meta.version || !b.files || !b.scripts || !b.scripts.length) {
            drop();
            info.note = "本地的 " + meta.version + " 更新包读不出来（存了一半？），删掉了";
            return null;
        }
        return b;
    }

    function tag(src) { document.write('<script src="' + src + '"><\/script>'); }

    function blobUrl(text, type) {
        return URL.createObjectURL(new Blob([text], { type: type }));
    }

    /* Swap in the bundle's markup and styles, then its scripts. Everything that
     * can throw on a malformed bundle happens before the page is touched. */
    function run(b) {
        var urls = [];
        for (var i = 0; i < b.scripts.length; i++) {
            var name = b.scripts[i], text = b.files["js/" + name];
            var u = text != null ? blobUrl(text, "application/javascript") : "js/" + name;
            names[u] = name;
            urls.push(u);
        }
        var styles = b.styles || [];

        if (typeof b.files.body === "string") {
            var body = document.body, kids = body.childNodes;
            for (var j = kids.length - 1; j >= 0; j--) {
                if (kids[j].nodeName !== "SCRIPT") { body.removeChild(kids[j]); }
            }
            body.insertAdjacentHTML("afterbegin", b.files.body);
        }
        if (styles.length) {
            var links = document.querySelectorAll('link[rel="stylesheet"]');
            for (var k = 0; k < links.length; k++) { links[k].parentNode.removeChild(links[k]); }
            for (var s = 0; s < styles.length; s++) {
                var css = b.files[styles[s]], node;
                if (css != null) {
                    node = document.createElement("style");
                    node.textContent = css;
                } else {
                    node = document.createElement("link");
                    node.rel = "stylesheet";
                    node.href = styles[s];
                }
                document.head.appendChild(node);
            }
        }

        put(K_BOOTING, b.version);
        for (var m = 0; m < urls.length; m++) { tag(urls[m]); }
    }

    function packaged() {
        info.running = info.packaged;
        for (var i = 0; i < SCRIPTS.length; i++) { tag("js/" + SCRIPTS[i]); }
    }

    if (typeof document !== "undefined" && document.write) {
        var chosen = null;
        try { chosen = choose(); }
        catch (e) { info.note = "选代码时出错：" + (e && e.message) + "，用安装包"; }
        if (chosen) {
            try {
                run(chosen);
                info.running = chosen.version;
            } catch (e2) {
                /* The page may be half swapped by now; a reload starts clean
                 * and, with the version marked bad, takes the package. */
                markBad(chosen.version);
                drop();
                try { location.reload(); } catch (e3) { packaged(); }
            }
        } else {
            packaged();
        }
    }

    return {
        SHELL: SHELL,
        PUBKEY: PUBKEY,
        cmp: cmp,
        keys: { bundle: K_BUNDLE, meta: K_META, booting: K_BOOTING, bad: K_BAD },
        isBad: function (version) { return !!badList()[version]; },
        /* {packaged, running, note} — what this launch chose and why. */
        info: function () { return { packaged: info.packaged, running: info.running, note: info.note }; },
        /* The home screen is up: this launch's code is good. */
        ok: function () { del(K_BOOTING); },
        /* window.onerror sees a bundle's scripts as blob: urls; this names them. */
        scriptName: function (src) { return names[src] || String(src || "").split("/").pop(); }
    };
})();
