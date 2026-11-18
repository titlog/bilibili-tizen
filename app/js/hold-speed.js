/* One Enter gesture in plain VOD playback: a tap pauses on release, a hold
 * past Nav.LONG_ENTER_MS plays at 2x until release.
 *
 * A press that never got its boost (the player was busy, refused it, or
 * interrupted it) is still an OK press: its release pauses, as OK always did.
 * A cancelled press (another key, a new video, the screen changing) stays
 * consumed until keyup, so its repeats cannot act on what replaced it.
 *
 * From the threshold on, one tick every RETRY_MS both retries a boost the
 * player could not take yet and watches the screen: anything that is no
 * longer plain playback (panel, comments, countdown...) ends the press, so
 * the overlays need no hook of their own. app.js cancels directly only where
 * the screen check cannot see the change: a new video (playVideo / play),
 * the player closing (stopPlayback) and a video ending (beginAutoNext — the
 * keys stay the player's while the next one is looked up, and a release
 * there used to pause). Do not drop those three as redundant. */
var HoldSpeed = (function () {
    "use strict";

    var RETRY_MS = 250;

    function create(options) {
        var press = null;

        function now() { return new Date().getTime(); }

        function tick() {
            if (!press || press.cancelled) { return; }
            press.tried = true;
            if (!options.canToggle()) { cancel("screen"); return; }
            if (!press.boosted && !press.noBoost) { tryBoost(); }
            if (press.boosted || !press.noBoost) { press.timer = setTimeout(tick, RETRY_MS); }
        }

        function tryBoost() {
            /* Buffering or loading: wait, and say so, while it is held. */
            if (!options.eligible()) {
                if (!press.waiting) { press.waiting = true; options.changed("wait"); }
                return;
            }
            /* Refused with the player ready (player.js logged why): one try. */
            if (!Player.holdRate(2)) { press.noBoost = true; settle(); return; }
            press.waiting = false;
            press.boosted = true;
            press.boostAt = now();
            options.changed("on");
        }

        /* Take down the indicator and, if it ran, the boost. */
        function settle(reason) {
            if (press.waiting) { press.waiting = false; options.changed(""); }
            if (!press.boosted) { return; }
            press.boosted = false;
            press.spent = true;
            Player.releaseHoldRate();
            options.changed("");
            var t = now();
            options.log("临时 2 倍速 start=" + press.boostAt + " end=" + t +
                        " duration=" + (t - press.boostAt) + "ms reason=" + reason);
        }

        /* The player ended a boost on its own (retry notice, error, rebuild,
         * token swap, its own pause). The screen is still the player's, so the
         * press keeps its OK meaning: no boost from here, release still acts. */
        function interrupt(reason) {
            if (!press) { return; }
            press.noBoost = true;
            settle(reason);
        }

        function cancel(reason) {
            if (!press) { return; }
            clearTimeout(press.timer);
            press.cancelled = true;
            settle(reason);
        }

        Nav.onKeyUp(function (k) {
            if (k !== Nav.KEY.ENTER || !press) { return false; }
            /* Past the threshold before its timer could run (a busy event
             * loop): a hold, too late to boost — neither 2x nor a pause. */
            var lateHold = !press.tried && now() - press.started >= Nav.LONG_ENTER_MS;
            /* Not eligible(): a stall during the press must not eat the pause.
             * A boost that ran (or was ended by the player) is the whole gesture. */
            var short = !press.cancelled && !press.boosted && !press.spent && !lateHold &&
                options.canToggle();
            if (lateHold && !press.cancelled) {
                options.log("确认键按了 " + (now() - press.started) + "ms 才松开，计时器还没跑（主线程忙）：这次不加速也不暂停");
            }
            cancel("keyup");
            press = null;
            if (short) { options.toggle(); }
            return true;
        });
        /* This press's keyup may never reach us after these: drop the press,
         * or the next OK would be swallowed as its repeat. */
        window.addEventListener("blur", function () { cancel("blur"); press = null; });
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) { cancel("hidden"); press = null; }
        });

        return {
            begin: function () {
                press = { started: now(), tried: false, waiting: false, boosted: false,
                          spent: false, noBoost: false, cancelled: false };
                press.timer = setTimeout(tick, Nav.LONG_ENTER_MS);
            },
            /* repeat: Nav's classification. A new Enter press while one is
             * still open means that one's keyup was lost (no blur, no hide):
             * settle and drop it, and let this press route as itself. */
            key: function (k, repeat) {
                if (!press) { return false; }
                if (k === Nav.KEY.ENTER && !repeat) { cancel("lost keyup"); press = null; return false; }
                if (k === Nav.KEY.ENTER) { return true; }
                cancel("key " + k);
                return false;
            },
            cancel: cancel,
            interrupt: interrupt
        };
    }

    return { create: create, RETRY_MS: RETRY_MS };
})();
