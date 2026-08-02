/* A DASH manifest, built from what bilibili's playurl already told us.
 *
 * bilibili ships the pieces of a manifest — representations, codecs, byte
 * ranges for the init segment and the segment index — but no manifest. Writing
 * one and handing it to a real DASH player is what replaced a hand-rolled MSE
 * byte pump here, and with it: parsing the segment index, sizing requests,
 * evicting the buffer, spotting the end of the file, aborting fetches on a seek
 * and retrying refusals. Every one of those was a bug at some point in a single
 * day; none of them is ours to get wrong any more.
 *
 * Verified by tools/mpd-verify.mjs against real playurl payloads — an invalid
 * manifest fails as "the video will not start", with nothing to read.
 */
var Mpd = (function () {
    "use strict";

    /* The stream urls are query-heavy and full of & — unescaped, the manifest
     * is not well-formed XML and the player rejects the whole thing. */
    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    }

    /* Every mirror as its own BaseURL: DASH treats them as alternatives, so
     * the player fails over without any of that being our code. */
    function baseUrls(rep) {
        var urls = rep.urls && rep.urls.length ? rep.urls : [rep.baseUrl];
        var out = "";
        for (var i = 0; i < urls.length; i++) {
            if (!urls[i]) { continue; }
            out += "        <BaseURL>" + esc(urls[i]) + "</BaseURL>\n";
        }
        return out;
    }

    function representation(rep, extra) {
        if (!rep || !rep.segments) { return ""; }
        return '      <Representation id="' + esc(rep.id) +
               '" bandwidth="' + esc(rep.bandwidth || 1000000) +
               '" codecs="' + esc(rep.codecs) + '"' + (extra || "") + ">\n" +
               baseUrls(rep) +
               '        <SegmentBase indexRange="' + esc(rep.segments.index) + '">\n' +
               '          <Initialization range="' + esc(rep.segments.init) + '"/>\n' +
               "        </SegmentBase>\n" +
               "      </Representation>\n";
    }

    return {
        /* `maxId` caps the quality ladder — bilibili happily offers 4K and 8K
         * tiers this set has no business fetching over a domestic link. Passing
         * every tier below it in lets the player adapt downwards on its own,
         * which is the whole reason a deep seek into a long video no longer has
         * to stall: it drops a tier rather than waiting on bytes the CDN has
         * never cached. */
        build: function (dash, maxId) {
            if (!dash) { return ""; }

            var videos = (dash.video || []).filter(function (r) {
                return r.codecs && r.codecs.indexOf("avc1") === 0 &&
                       r.segments && (!maxId || r.id <= maxId);
            }).sort(function (a, b) { return (b.bandwidth || 0) - (a.bandwidth || 0); });

            var audios = (dash.audio || []).filter(function (r) {
                return r.segments;
            }).sort(function (a, b) { return (a.bandwidth || 0) - (b.bandwidth || 0); });

            if (!videos.length || !audios.length) { return ""; }

            var vBody = "";
            for (var i = 0; i < videos.length; i++) {
                var v = videos[i];
                vBody += representation(v,
                    ' width="' + esc(v.width || 1920) + '" height="' + esc(v.height || 1080) + '"' +
                    ' frameRate="' + esc(v.frameRate || v.frame_rate || "25") + '"');
            }
            var aBody = "";
            for (var j = 0; j < audios.length; j++) {
                aBody += representation(audios[j], ' audioSamplingRate="44100"');
            }

            /* `static` and isoff-on-demand: the whole file exists, addressed by
             * byte range, which is exactly what SegmentBase describes. */
            return '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"' +
                ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"' +
                ' type="static"' +
                ' mediaPresentationDuration="PT' + (Number(dash.duration) || 0) + 'S"' +
                ' minBufferTime="PT1.5S">\n' +
                "  <Period>\n" +
                '    <AdaptationSet contentType="video" mimeType="video/mp4"' +
                ' segmentAlignment="true" startWithSAP="1">\n' +
                vBody +
                "    </AdaptationSet>\n" +
                '    <AdaptationSet contentType="audio" mimeType="audio/mp4"' +
                ' segmentAlignment="true" startWithSAP="1" lang="und">\n' +
                aBody +
                "    </AdaptationSet>\n" +
                "  </Period>\n" +
                "</MPD>\n";
        }
    };
})();
