/* Preferences that outlive a session. Small enough not to warrant more. */
var Settings = (function () {
    "use strict";
    var KEY = "bili.settings";
    var data = null;

    function load() {
        if (data) { return data; }
        try { data = JSON.parse(localStorage.getItem(KEY) || "{}"); }
        catch (e) { data = {}; }
        return data;
    }

    return {
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
