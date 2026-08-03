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

    /* bilibili offers every tier three times over — H.264, H.265 and AV1 — and
     * exactly one of them belongs in the manifest: a DASH AdaptationSet is a
     * set of alternatives the player may switch between mid-stream, and codecs
     * are not that.
     *
     * AV1 first as of 2026-08-03 evening, matching the official web player's
     * default — and that parity is the argument: the CDN treats each codec's
     * file on its own terms, and the av01 copies ride whatever path bilibili's
     * own player keeps healthy. The night this flipped, one video's hev1 and
     * avc1 1080p files were starved to 25-50 KB/s (403 for the TV's tokens)
     * while av01 served at full speed, and the web player never felt it.
     * H.265 next: same picture in ~15% fewer bytes than av01 on these files,
     * so it stays the fallback for the many uploads with no av01 tracks.
     *
     * The old fear — that this panel might software-decode AV1 and trade a
     * bandwidth problem for a dropped-frames problem — was never measured.
     * The 丢帧 counter in the 卡住/恢复播放 lines is the judge now that av01
     * actually plays; if it climbs, the revert is putting hev1 back in front.
     *
     * The set is asked rather than assumed — `isTypeSupported` with the codec
     * string bilibili actually sent, not a guess at what a 2024 Samsung ought
     * to manage. Where there is nothing to ask (the verifier runs this file
     * under node), only H.264 is taken: it is the one every engine has. */
    var FAMILIES = ["av01", "hev1", "hvc1", "avc1"];

    function family(codecs) { return String(codecs || "").split(".")[0]; }

    /* Memoised: the same handful of codec strings come back for every video,
     * and `isTypeSupported` is not guaranteed to be a table lookup — on some
     * engines it goes and asks the decoder. This sits on the path between
     * pressing a button and seeing a picture, so it gets asked once. */
    var supportCache = {};

    function ask(c) {
        try {
            return MediaSource.isTypeSupported('video/mp4; codecs="' + c + '"');
        } catch (e) { return false; }
    }

    function playable(codecs) {
        if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) {
            return family(codecs) === "avc1";
        }
        if (supportCache[codecs] === undefined) {
            supportCache[codecs] = ask(codecs);
            /* The engine probe answers true for `av01.0.08M.08` while the
             * payload states `av01.0.08M.08.0.110.01.01.01.0` — same profile,
             * level and depth; the tail is colour metadata, not decode
             * capability. A platform isTypeSupported that rejects the long
             * form silently deletes the whole family from the manifest, so
             * ask again with the 4-part prefix before believing a no. */
            if (!supportCache[codecs]) {
                var parts = String(codecs).split(".");
                if (parts.length > 4) {
                    supportCache[codecs] = ask(parts.slice(0, 4).join("."));
                }
            }
        }
        return supportCache[codecs];
    }

    var chosen = "";

    function chooseVideos(all, maxId, prefer) {
        var usable = [];
        for (var i = 0; i < (all || []).length; i++) {
            var r = all[i];
            if (r && r.codecs && r.segments && (!maxId || r.id <= maxId)) { usable.push(r); }
        }

        /* H.264 is the baseline this has to beat. A family that cannot reach
         * the same tier is not an improvement however few bytes it uses —
         * trading 1080p for 720p is a downgrade dressed as an optimisation. */
        function topOf(fam) {
            var top = 0;
            for (var j = 0; j < usable.length; j++) {
                if (family(usable[j].codecs) === fam) { top = Math.max(top, usable[j].id || 0); }
            }
            return top;
        }
        var baseline = topOf("avc1");

        var order = prefer ? [prefer] : FAMILIES;
        for (var k = 0; k < order.length; k++) {
            var fam = order[k], reps = [], allOk = true;
            for (var m = 0; m < usable.length; m++) {
                if (family(usable[m].codecs) !== fam) { continue; }
                if (!playable(usable[m].codecs)) { allOk = false; break; }
                reps.push(usable[m]);
            }
            if (!allOk || !reps.length) { continue; }
            if (fam !== "avc1" && topOf(fam) < baseline) { continue; }
            chosen = fam;
            return reps;
        }
        chosen = "";
        return [];
    }

    return {
        /* Which codec family the last `build` settled on, for the log — "why is
         * this stalling" and "what is it actually decoding" are the same
         * question often enough. */
        chosen: function () { return chosen; },

        /* `maxId` caps the quality ladder — bilibili happily offers 4K and 8K
         * tiers this set has no business fetching over a domestic link. Passing
         * every tier below it in lets the player adapt downwards on its own,
         * which is the whole reason a deep seek into a long video no longer has
         * to stall: it drops a tier rather than waiting on bytes the CDN has
         * never cached.
         *
         * `prefer` pins the codec family; the player uses it to come back on
         * H.264 when a first attempt failed for anything but the network. */
        build: function (dash, maxId, prefer) {
            if (!dash) { return ""; }

            var videos = chooseVideos(dash.video, maxId, prefer)
                .sort(function (a, b) { return (b.bandwidth || 0) - (a.bandwidth || 0); });

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
