/* Self-update: can this widget carry its own new versions?
 *
 * Why this matters more than any feature: an unofficial client for somebody
 * else's service cannot live in Samsung's store. The precedent is exact —
 * Samsung pulled the unofficial Twitch.tv app in early 2019 for not being
 * official, and Twitch itself only appeared in 2022, published by Twitch. So
 * every user of this app sideloads it, and sideloading needs Tizen tooling, a
 * Samsung distribution certificate and a computer on the same LAN. Asking a
 * viewer to redo that for every fix is asking them not to bother.
 *
 * The community Twitch client solves it by fetching its newest code at every
 * launch, so the sideload happens once in a device's life. Whether the same
 * trick is available here is a platform question with several independent
 * answers, and reading the code cannot settle any of them:
 *
 *   - can the set reach a code host at all (DNS, and a TLS stack older than
 *     WebKit's — the same stack that fails handshakes with some CDN nodes)
 *   - does the widget's policy permit `new Function` (CSP unsafe-eval)
 *   - does it permit a script element pointing at a blob:
 *   - does it permit one pointing at https://
 *   - can bytes be persisted to wgt-private, which is what makes an update
 *     survive to the next launch instead of being re-fetched forever
 *
 * Any one of eval/blob/remote-script is enough to run new code; the storage
 * answer decides whether an offline television still opens. So each is probed
 * on its own and reported on its own line — a single "self-update: no" would
 * hide which of five walls we hit, and this codebase has paid for that kind of
 * summary before.
 *
 * Deliberately self-contained, with its own reporting: an updater whose job is
 * to repair a broken build must not depend on that build having loaded. It also
 * runs on a timer rather than at load, because the one thing already measured
 * here is that boot-time fetches compete with playback for connections.
 */
var Updater = (function () {
    "use strict";

    /* Candidate hosts for hosting the code, most-likely first. jsDelivr is
     * carried because it mirrors GitHub and is reachable in places
     * raw.githubusercontent.com is not — worth knowing before the distribution
     * story is built on one hostname. Each is a small, stable, public file:
     * this measures reachability, not content. */
    var HOSTS = [
        { name: "raw.githubusercontent", url: "https://raw.githubusercontent.com/jellyfin/jellyfin-tizen/master/package.json" },
        { name: "jsdelivr",              url: "https://cdn.jsdelivr.net/npm/shaka-player@4.3.4/package.json" },
        { name: "github-codeload",       url: "https://codeload.github.com/jellyfin/jellyfin-tizen/tar.gz/refs/heads/master" }
    ];

    function send(msg) {
        if (typeof REPORT_TO === "undefined" || !REPORT_TO) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", REPORT_TO, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.timeout = 3000;
            xhr.send(JSON.stringify({ event: "log", detail: { msg: "update: " + msg } }));
        } catch (e) {}
    }

    /* ---- 1. reachability ---- */
    function probeHosts(done) {
        var left = HOSTS.length, results = [];
        for (var i = 0; i < HOSTS.length; i++) {
            (function (h) {
                var t0 = new Date().getTime();
                var xhr = new XMLHttpRequest();
                try { xhr.open("GET", h.url, true); } catch (e) {
                    results.push(h.name + "=open失败"); if (!--left) { finish(); } return;
                }
                /* A range keeps the codeload tarball from being pulled in full —
                 * the question is whether the host answers, not what it holds. */
                try { xhr.setRequestHeader("Range", "bytes=0-511"); } catch (e) {}
                xhr.timeout = 12000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) { return; }
                    var ms = new Date().getTime() - t0;
                    var n = (xhr.responseText || "").length;
                    results.push(h.name + "=" + xhr.status + "(" + n + "B," + ms + "ms)");
                    if (!--left) { finish(); }
                };
                xhr.ontimeout = function () {
                    results.push(h.name + "=超时"); if (!--left) { finish(); }
                };
                xhr.onerror = function () {
                    /* Status 0 with no error text is what a refused TLS handshake
                     * looks like from here — the same shape the CDN's cut
                     * connections take, and not distinguishable from DNS failure
                     * without a second signal. Said plainly rather than guessed. */
                    results.push(h.name + "=失败(状态0,可能TLS或DNS)");
                    if (!--left) { finish(); }
                };
                try { xhr.send(); } catch (e) {
                    results.push(h.name + "=send抛异常"); if (!--left) { finish(); }
                }
            })(HOSTS[i]);
        }
        function finish() { send("可达性 " + results.join(" ")); done(); }
    }

    /* ---- 2. new Function (CSP unsafe-eval) ---- */
    function probeEval() {
        try {
            /* Not `eval`: a real updater would compile fetched source, and
             * `new Function` is what a compiled bundle uses. They are governed
             * by the same CSP keyword but not by the same code path. */
            var f = new Function("return 6*7;");
            send("new Function " + (f() === 42 ? "可用" : "返回值不对"));
        } catch (e) {
            send("new Function 被拒(" + (e && e.name) + ")");
        }
    }

    /* ---- 3. blob: script element ---- */
    function probeBlobScript(done) {
        try {
            window.__updaterBlobOk = false;
            var blob = new Blob(["window.__updaterBlobOk = true;"],
                                { type: "application/javascript" });
            var url = URL.createObjectURL(blob);
            var s = document.createElement("script");
            s.onload = function () {
                send("blob: 脚本 " + (window.__updaterBlobOk ? "可用" : "加载了但没执行"));
                try { URL.revokeObjectURL(url); } catch (e) {}
                if (s.parentNode) { s.parentNode.removeChild(s); }
                done();
            };
            s.onerror = function () {
                send("blob: 脚本 被拒");
                try { URL.revokeObjectURL(url); } catch (e) {}
                if (s.parentNode) { s.parentNode.removeChild(s); }
                done();
            };
            s.src = url;
            document.head.appendChild(s);
        } catch (e) {
            send("blob: 脚本 抛异常(" + (e && e.name) + ")");
            done();
        }
    }

    /* ---- 4. remote https script element ---- */
    function probeRemoteScript(done) {
        try {
            var s = document.createElement("script");
            var t0 = new Date().getTime();
            var settled = false;
            function once(what) {
                if (settled) { return; }
                settled = true;
                send("远程 script 标签 " + what +
                     " (" + (new Date().getTime() - t0) + "ms)");
                if (s.parentNode) { s.parentNode.removeChild(s); }
                done();
            }
            s.onload = function () { once("可用"); };
            s.onerror = function () { once("被拒或取不到"); };
            setTimeout(function () { once("超时"); }, 12000);
            /* A tiny, stable, real library. Loading it proves the whole path:
             * DNS, TLS, and the widget policy permitting off-origin script. */
            s.src = "https://cdn.jsdelivr.net/npm/mustache@4.2.0/mustache.min.js";
            document.head.appendChild(s);
        } catch (e) {
            send("远程 script 标签 抛异常(" + (e && e.name) + ")");
            done();
        }
    }

    /* ---- 5. persistence to wgt-private ---- */
    function probeStorage() {
        if (typeof tizen === "undefined" || !tizen.filesystem) {
            send("wgt-private 没有 tizen.filesystem");
            return;
        }
        var payload = "window.__updaterDiskOk = true; // " + new Date().getTime();
        try {
            /* resolve throws synchronously without the filesystem privileges,
             * which config.xml already declares for the old manifest path. */
            tizen.filesystem.resolve("wgt-private", function (dir) {
                var name = "update-probe.js", file;
                try { file = dir.resolve(name); } catch (e) { file = null; }
                if (!file) {
                    try { file = dir.createFile(name); }
                    catch (e2) { send("wgt-private 建文件失败(" + (e2 && e2.name) + ")"); return; }
                }
                file.openStream("w", function (s) {
                    s.write(payload);
                    s.close();
                    /* Written is not enough — an update that cannot be read back
                     * next launch is no update. Round-trip or it does not count. */
                    file.openStream("r", function (r) {
                        /* `read(charCount)`, not `readText()` — Tizen's
                         * FileStream has no such method, and calling it threw
                         * an uncaught TypeError that killed this probe silently
                         * mid-flight. Nothing reported it except window.onerror,
                         * which is the only reason it was ever seen. */
                        var back = "";
                        try {
                            var n = r.bytesAvailable;
                            back = (n > 0) ? r.read(n) : "";
                        } catch (rerr) {
                            r.close();
                            send("wgt-private 读失败(" + (rerr && rerr.name) + ")");
                            return;
                        }
                        r.close();
                        send("wgt-private 读写 " +
                             (back === payload ? "可用(" + back.length + "B 回环一致)"
                                               : "回环不一致(读回 " + back.length +
                                                 "B / 写入 " + payload.length + "B)"));
                    }, function (e3) {
                        send("wgt-private 可写不可读(" + (e3 && e3.name) + ")");
                    }, "UTF-8");
                }, function (e4) {
                    send("wgt-private 写失败(" + (e4 && e4.name) + ")");
                }, "UTF-8");
            }, function (e5) {
                send("wgt-private resolve 失败(" + (e5 && e5.name) + ")");
            }, "rw");
        } catch (e) {
            send("wgt-private resolve 同步抛异常(" + (e && e.name) + ")");
        }
    }

    return {
        /* Called on a timer after boot. Serialised rather than fired at once:
         * five probes racing each other would measure contention instead of
         * capability, and one of them is deliberately a reachability timing. */
        probe: function () {
            send("能力探测开始（判断自更新是否可行）");
            probeEval();
            probeStorage();
            probeBlobScript(function () {
                probeRemoteScript(function () {
                    probeHosts(function () {
                        send("能力探测结束");
                    });
                });
            });
        }
    };
})();
