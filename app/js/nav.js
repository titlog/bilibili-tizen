/* D-pad focus management.
 *
 * There is no pointer on a TV, so every interactive element is a member of a
 * focus group and the remote moves between them geometrically: the next focus
 * is whichever candidate lies in the pressed direction and is closest. That
 * behaves correctly for ragged grids without anyone declaring a grid width.
 */
var Nav = (function () {
    "use strict";

    var current = null;
    var handlers = {};

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
        ENTER: 13, RETURN: 10009, EXIT: 10182,
        PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19,
        FF: 417, REW: 412
    };

    function focusables() {
        var all = document.querySelectorAll(".focusable");
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.offsetParent !== null) { out.push(el); }
        }
        return out;
    }

    function centre(el) {
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r };
    }

    function setFocus(el) {
        if (!el) { return; }
        if (current && current !== el) { current.className = current.className.replace(/\s*focused/g, ""); }
        current = el;
        if (el.className.indexOf("focused") < 0) { el.className += " focused"; }
        scrollIntoView(el);
    }

    /* The TV browser's own scrollIntoView jumps; easing by hand keeps the
     * selected row roughly centred, which is what makes a grid feel right. */
    function scrollIntoView(el) {
        var scroller = el;
        while (scroller && scroller !== document.body &&
               !(scroller.className && scroller.className.indexOf("scroll") >= 0)) {
            scroller = scroller.parentNode;
        }
        if (!scroller || scroller === document.body) { return; }
        var er = el.getBoundingClientRect();
        var sr = scroller.getBoundingClientRect();
        var target = er.top - sr.top + scroller.scrollTop - (sr.height / 2) + (er.height / 2);
        scroller.scrollTop = Math.max(0, target);
    }

    function move(dx, dy) {
        if (!current) { setFocus(focusables()[0]); return; }
        var from = centre(current);
        var best = null, bestScore = Infinity;
        var list = focusables();

        for (var i = 0; i < list.length; i++) {
            if (list[i] === current) { continue; }
            var to = centre(list[i]);
            var ox = to.x - from.x, oy = to.y - from.y;

            /* Must actually lie in the pressed direction, with a little slack so
             * that near-aligned items still count. */
            if (dx > 0 && ox <= 4) { continue; }
            if (dx < 0 && ox >= -4) { continue; }
            if (dy > 0 && oy <= 4) { continue; }
            if (dy < 0 && oy >= -4) { continue; }

            /* Distance along the axis of travel dominates; drift across it is
             * penalised so the eye follows a straight line. */
            var along = Math.abs(dx ? ox : oy);
            var across = Math.abs(dx ? oy : ox);
            var score = along + across * 3;
            if (score < bestScore) { bestScore = score; best = list[i]; }
        }
        if (best) { setFocus(best); }
    }

    document.addEventListener("keydown", function (e) {
        var k = e.keyCode;
        if (handlers.key && handlers.key(k) === true) { return; }

        switch (k) {
            case KEY.LEFT:  move(-1, 0); break;
            case KEY.RIGHT: move(1, 0);  break;
            case KEY.UP:    move(0, -1); break;
            case KEY.DOWN:  move(0, 1);  break;
            case KEY.ENTER:
                if (current && current.onselect) { current.onselect(); }
                break;
            case KEY.RETURN:
                if (handlers.back) { handlers.back(); }
                break;
            case KEY.EXIT:
                try { tizen.application.getCurrentApplication().exit(); } catch (err) {}
                break;
            default: return;
        }
        e.preventDefault();
    });

    return {
        KEY: KEY,
        focus: setFocus,
        current: function () { return current; },
        /* Called after a screen swaps its DOM, to land focus somewhere sane. */
        reset: function (selector) {
            current = null;
            var el = selector ? document.querySelector(selector) : focusables()[0];
            setFocus(el || focusables()[0]);
        },
        onBack: function (fn) { handlers.back = fn; },
        onKey: function (fn) { handlers.key = fn; },
        registerKeys: function () {
            try {
                var want = ["MediaPlayPause", "MediaPlay", "MediaPause",
                            "MediaFastForward", "MediaRewind"];
                for (var i = 0; i < want.length; i++) {
                    try { tizen.tvinputdevice.registerKey(want[i]); } catch (e) {}
                }
            } catch (e) {}
        }
    };
})();
