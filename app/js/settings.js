/* Preferences that outlive a session. Small enough not to warrant more. */
var Settings = (function () {
    "use strict";
    var KEY = "bili.settings";
    var data = null;
    var playbackQn = 0;   /* current video only; never written to localStorage */

    function load() {
        if (data) { return data; }
        try { data = JSON.parse(localStorage.getItem(KEY) || "{}"); }
        catch (e) { data = {}; }
        return data;
    }

    /* 画质上限（设置页「画质」，2026-10-18 起；此前是 config.js 里写死的 PREFERRED_QN = 80）。
     * 默认 4K：账号拿不到的档 bilibili 根本不给 —— 非大会员的 dash.video 只到 1080P（「4K 查过了」那节的表），
     * 所以默认值只在大会员身上起作用，其他人和以前一模一样。8K / HDR / 杜比视界不在选项里：这台电视 4K、
     * 那几档要别的 fnval 位和色彩处理，没验证过。 */
    var QN_STEPS = [120, 112, 80, 64, 32];

    return {
        qnSteps: function () { return QN_STEPS.slice(); },
        savedQnCap: function () {
            var q = Number(this.get("maxQn", 120));
            return QN_STEPS.indexOf(q) >= 0 ? q : 120;
        },
        qnCap: function () { return playbackQn || this.savedQnCap(); },
        playbackQnCap: function () { return playbackQn; },
        setPlaybackQnCap: function (q) {
            q = Number(q) || 0;
            playbackQn = QN_STEPS.indexOf(q) >= 0 ? q : 0;
        },
        get: function (k, fallback) {
            var v = load()[k];
            return v === undefined ? fallback : v;
        },
        set: function (k, v) {
            load()[k] = v;
            try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
        }
    };
})();
