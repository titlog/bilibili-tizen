/* Runtime settings. tools/deploy.sh rewrites REPORT_TO on every deploy. */

/* bilibili blocklists curl-shaped agents but accepts anything browser-like.
 * AVPlay sends no useful UA of its own, so this is set explicitly on the
 * stream. */
var USER_AGENT = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36";

/* 1080P 高清. The tiers above it are 大会员 only, so asking for them buys
 * nothing but restricted CDN nodes and retry cycles. Fixed rather than
 * adjustable: on a television nobody goes looking for a quality menu. */
var PREFERRED_QN = 80;

/* Dev only: the app posts errors here so a run can be read from the terminal
 * instead of off the screen. Empty disables it. */
var REPORT_TO = "http://192.168.1.10:8099/report";

/* Set by tools/deploy.sh --selftest: walks the whole flow on the device and
 * reports each step to the collector. Never on in a normal build. */
var SELFTEST = false;
