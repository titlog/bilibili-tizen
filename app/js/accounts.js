/* Who is signed in on this television.
 *
 * A living-room set is shared, so the app keeps a list of accounts rather than
 * one session, and everything that belongs to a person — watch history above
 * all — is stored under a key carrying that person's account id.
 *
 * The id is local and opaque, deliberately not the bilibili mid. The mid is not
 * known at the moment an account is created: the web fallback login hands back
 * cookies and nothing else, and who they belong to only emerges from a later
 * nav() call. Keying storage on something that arrives late would mean renaming
 * every namespace once it did.
 *
 * ## The cookie jar owns at most one account
 *
 * The web QR fallback cannot read the credentials it obtains — they land in
 * WebKit's cookie jar as Set-Cookie on a cross-domain hop, and the jar is
 * global, unreadable and unwritable from here. So an account acquired that way
 * can only be used while the jar still holds it, and there is no way to put it
 * back after another account has taken the jar over. `jarOwner` records which
 * account, if any, the jar currently belongs to; `needsRelogin` is how the UI
 * knows to ask for a fresh scan instead of silently serving someone else's feed.
 *
 * Accounts from the TV login path carry readable credentials and have none of
 * this problem, which is the whole reason that path exists.
 */
var Accounts = (function () {
    "use strict";

    var KEY = "bili.accounts";
    var GUEST = "guest";

    /* Storage that belongs to a person rather than to the television. Listed
     * here so that removing an account can take its data with it — an account
     * removed while its history stayed behind would hand that history to
     * whoever was assigned the same id next. */
    var SCOPED = ["bili.resume"];

    var LEGACY_SESSION = "bili.session";

    var data = null;   /* { seq, activeId, jarOwner, list: [] } */

    function blank() {
        return { seq: 0, activeId: GUEST, jarOwner: null, list: [] };
    }

    function hex(n) {
        var s = "", i;
        for (i = 0; i < n; i++) {
            s += "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16));
        }
        return s;
    }

    /* bilibili fingerprints a client by buvid3. One is minted per account and
     * then never changes: a fingerprint that differs on every request looks far
     * more like automation than a stable one does. */
    function newBuvid() {
        return hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" +
               hex(12) + hex(5) + "infoc";
    }

    function persist() {
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }

    /* Anything stored before this build had a single session and a single
     * history. Both become the first account, so nobody loses their place in a
     * video because the app learned to hold more than one person. */
    function migrate() {
        var raw = null;
        try { raw = localStorage.getItem(LEGACY_SESSION); } catch (e) { return; }

        var old = null;
        if (raw) { try { old = JSON.parse(raw); } catch (e) { old = null; } }

        var owner = GUEST;
        if (old && (old.SESSDATA || old.viaCookieJar)) {
            var acc = create();
            acc.session = old;
            data.list.push(acc);
            data.activeId = acc.id;
            /* A migrated jar session is still live in the jar right now — it is
             * the same engine and the same cookies — so it keeps ownership. */
            if (old.viaCookieJar && !old.SESSDATA) { data.jarOwner = acc.id; }
            owner = acc.id;
        }

        /* Whether or not there was a session, the existing history belongs to
         * whoever was using the set: the signed-in account if there was one,
         * otherwise the guest. */
        for (var i = 0; i < SCOPED.length; i++) {
            try {
                var v = localStorage.getItem(SCOPED[i]);
                if (v === null) { continue; }
                localStorage.setItem(SCOPED[i] + "@" + owner, v);
                localStorage.removeItem(SCOPED[i]);
            } catch (e) {}
        }

        try { localStorage.removeItem(LEGACY_SESSION); } catch (e) {}
    }

    function create() {
        data.seq += 1;
        return {
            id: "a" + data.seq,
            mid: 0,
            uname: "",
            face: "",
            level: null,
            buvid: newBuvid(),
            session: null,
            addedAt: new Date().getTime(),
            lastUsedAt: new Date().getTime()
        };
    }

    function load() {
        if (data) { return data; }
        var raw = null;
        try { raw = localStorage.getItem(KEY); } catch (e) {}
        if (raw) {
            try { data = JSON.parse(raw); } catch (e) { data = null; }
        }
        if (!data || !data.list) {
            data = blank();
            migrate();
            persist();
        }
        return data;
    }

    function get(id) {
        var d = load();
        for (var i = 0; i < d.list.length; i++) {
            if (d.list[i].id === id) { return d.list[i]; }
        }
        return null;
    }

    /* The engine's jar is global, so switching accounts has to empty it or the
     * previous account's cookies ride along on any request that carries
     * credentials. Returns whether it actually happened: the API is not present
     * on every firmware, and a caller that assumes it worked would let two
     * accounts bleed into each other silently. */
    function clearJar() {
        try {
            if (typeof tizen !== "undefined" && tizen.websetting &&
                tizen.websetting.removeAllCookies) {
                tizen.websetting.removeAllCookies();
                return true;
            }
        } catch (e) {}
        return false;
    }

    return {
        GUEST: GUEST,

        all: function () { return load().list; },
        count: function () { return load().list.length; },
        get: get,

        activeId: function () { return load().activeId || GUEST; },
        active: function () {
            var d = load();
            return d.activeId === GUEST ? null : get(d.activeId);
        },

        /* A key that belongs to the person using the set rather than to the set.
         * Callers re-derive it on every access instead of caching it, so that a
         * switch cannot leave a stale namespace behind. */
        scope: function (base) { return base + "@" + (load().activeId || GUEST); },

        /* The one place an account change happens. Everything else reads the
         * active account; nothing else writes it. */
        switchTo: function (id) {
            var d = load();
            if (id !== GUEST && !get(id)) { return null; }
            if (d.activeId === id) { return this.active(); }

            /* Empty the jar before anyone else's request can pick it up. The
             * account that owned it loses it — that is exactly the situation
             * needsRelogin exists to describe. */
            if (clearJar()) { d.jarOwner = null; }

            d.activeId = id;
            var acc = id === GUEST ? null : get(id);
            if (acc) { acc.lastUsedAt = new Date().getTime(); }
            persist();
            return acc;
        },

        /* Credentials in hand. Same person signing in again updates the account
         * they already have rather than growing a second face on the switcher.
         *
         * The mid is the reliable way to recognise them, and the TV path always
         * supplies it. The web fallback supplies nothing, so `intoId` carries
         * the app's intent instead — "this scan is meant to restore that row" —
         * and is honoured only when it cannot be somebody else's row. */
        remember: function (session, profile, intoId) {
            var d = load();
            profile = profile || {};
            var acc = null, i;

            if (profile.mid) {
                for (i = 0; i < d.list.length; i++) {
                    if (d.list[i].mid === profile.mid) { acc = d.list[i]; break; }
                }
            }
            if (!acc && intoId) {
                var target = get(intoId);
                if (target && (!target.mid || !profile.mid || target.mid === profile.mid)) {
                    acc = target;
                }
            }
            if (!acc) { acc = create(); d.list.push(acc); }

            acc.session = session;
            if (profile.mid) { acc.mid = profile.mid; }
            if (profile.uname) { acc.uname = profile.uname; }
            if (profile.face) { acc.face = profile.face; }
            if (profile.level !== undefined && profile.level !== null) {
                acc.level = profile.level;
            }
            acc.lastUsedAt = new Date().getTime();

            d.activeId = acc.id;
            /* A session with no readable SESSDATA lives entirely in the jar, so
             * this account now owns it. One with readable credentials does not
             * care what the jar holds. */
            d.jarOwner = (session && !session.SESSDATA) ? acc.id : d.jarOwner;
            persist();
            return acc;
        },

        /* Display fields learned after the fact, from nav().
         *
         * An account's mid does not change. If nav answers with a different one
         * than the login handed over, the answer is about somebody else — the
         * request did not carry this account's session — and writing it here
         * would rename the row to whoever the server did recognise. That is not
         * hypothetical: it stamped one person's name and mid onto three rows
         * belonging to different logins, and the only visible symptom was a new
         * account showing the previous account's face. Refuse and say so; the
         * caller reports it. */
        describe: function (id, profile) {
            var acc = get(id);
            if (!acc) { return null; }
            if (acc.mid && profile.mid && acc.mid !== profile.mid) { return null; }
            if (profile.mid) { acc.mid = profile.mid; }
            if (profile.uname) { acc.uname = profile.uname; }
            if (profile.face) { acc.face = profile.face; }
            if (profile.level !== undefined && profile.level !== null) {
                acc.level = profile.level;
            }
            persist();
            return acc;
        },

        remove: function (id) {
            var d = load();
            for (var i = 0; i < d.list.length; i++) {
                if (d.list[i].id !== id) { continue; }
                d.list.splice(i, 1);

                /* Take their history with them. Leaving it behind would hand it
                 * to whoever is assigned this id next. */
                for (var j = 0; j < SCOPED.length; j++) {
                    try { localStorage.removeItem(SCOPED[j] + "@" + id); } catch (e) {}
                }
                if (d.jarOwner === id) { clearJar(); d.jarOwner = null; }

                if (d.activeId === id) {
                    /* Fall back to whoever used the set most recently. */
                    var next = GUEST, best = -1;
                    for (var k = 0; k < d.list.length; k++) {
                        if ((d.list[k].lastUsedAt || 0) > best) {
                            best = d.list[k].lastUsedAt || 0;
                            next = d.list[k].id;
                        }
                    }
                    /* Unless the account being promoted is the one the jar
                     * holds — emptying it then would strand the very session
                     * about to be handed the screen. */
                    if (d.jarOwner !== next && clearJar()) { d.jarOwner = null; }
                    d.activeId = next;
                }
                persist();
                return true;
            }
            return false;
        },

        /* True when this account's credentials are gone: they only ever existed
         * in the jar, and the jar has since been emptied or taken over. The UI
         * turns this into "needs a fresh scan" rather than serving a signed-out
         * feed that looks like a broken account. */
        needsRelogin: function (acc) {
            if (!acc || !acc.session) { return true; }
            if (acc.session.SESSDATA) { return false; }
            return load().jarOwner !== acc.id;
        },

        /* Whether a request may let the engine attach the jar. Only when this
         * account is the one the jar holds — otherwise withCredentials would
         * quietly send someone else's session. */
        jarBelongsTo: function (id) { return load().jarOwner === id; },

        /* For the whoami probe only. Which account the jar is believed to hold
         * is a belief this code maintains, never one it can read back, so it is
         * worth saying out loud next to what the server actually answers. */
        jarOwner: function () { return load().jarOwner; },

        clearJar: clearJar
    };
})();
