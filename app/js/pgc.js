/* PGC response shapes shared by search and the player. */
var PGC = (function () {
    "use strict";
    function clean(value) {
        return String(value || "").replace(/<[^>]*>/g, "");
    }
    function episode(e) {
        return {
            epId: Number(e.ep_id || e.id) || 0,
            aid: e.aid || 0, bvid: e.bvid || "", cid: e.cid || 0,
            title: clean(e.show_title || e.index_title || e.title),
            longTitle: clean(e.long_title), pic: e.cover || "",
            badge: e.badge || ((e.badge_info || {}).text) ||
                   (((e.badges || [])[0] || {}).text) || "",
            status: e.status || 0, durationMs: e.duration || 0
        };
    }
    function search(d) {
        var out = [], groups = d.result || [], i, j, rows, x;
        for (i = 0; i < groups.length; i++) {
            if (groups[i].result_type !== "media_bangumi" && groups[i].result_type !== "media_ft") { continue; }
            rows = groups[i].data || [];
            for (j = 0; j < rows.length; j++) {
                x = rows[j];
                out.push({ seasonId: Number(x.season_id || x.pgc_season_id) || 0,
                    title: clean(x.title), pic: x.cover || "", score: (x.media_score || {}).score || 0,
                    scoreCount: (x.media_score || {}).user_count || 0,
                    episodeCount: x.ep_size || 0, indexShow: x.index_show || "",
                    typeName: x.season_type_name || "", styles: x.styles || "", areas: x.areas || "",
                    desc: clean(x.desc), badges: x.badges || [], episodes: (x.eps || []).map(episode) });
            }
        }
        return out;
    }
    function season(d) {
        return { seasonId: Number(d.season_id) || 0, title: clean(d.title || d.season_title),
            pic: d.cover || "", score: (d.rating || {}).score || 0, desc: d.evaluate || "",
            paymentTip: (d.payment || {}).tip || "", episodes: (d.episodes || []).map(episode),
            sections: (d.section || []).map(function (s) {
                return { title: s.title || "", episodes: (s.episodes || []).map(episode) };
            }),
            seasons: (d.seasons || []).map(function (s) {
                return { seasonId: Number(s.season_id) || 0, title: s.season_title || "" };
            }) };
    }
    function redirect(url) {
        var m = /\/bangumi\/play\/(ep|ss)(\d+)(?:[/?#]|$)/.exec(String(url || ""));
        return m ? { kind: m[1], id: Number(m[2]) } : null;
    }
    function preview(d) { return Number((d || {}).is_preview) === 1; }
    return { episode: episode, search: search, season: season, redirect: redirect, preview: preview };
})();
