/* Adjacent parts and collection episodes: the panel's 上一集 / 下一集 and
 * autoplay's next (app.js nextUp). Recommendations are never an episode. */
var EpisodeNav = (function () {
    "use strict";
    function adjacent(detail, cid, direction) {
        if (!detail || (direction !== -1 && direction !== 1)) { return null; }
        var pages = detail.pages || [], at = -1, i;
        for (i = 0; i < pages.length; i++) {
            if (Number(pages[i].cid) === Number(cid)) { at = i; break; }
        }
        if (at >= 0 && pages[at + direction]) {
            return { kind: "part", cid: pages[at + direction].cid, index: at + direction };
        }
        /* Past the first or last part (or a single one): the collection's. */
        var season = detail.season, episodes = season && season.episodes;
        if (!episodes) { return null; }
        var current = -1;
        for (i = 0; i < episodes.length; i++) {
            if (episodes[i].bvid === detail.bvid) { current = i; break; }
        }
        if (current < 0 || !episodes[current + direction]) { return null; }
        return { kind: "season", index: current + direction, cid: episodes[current + direction].cid };
    }
    return { adjacent: adjacent };
})();
