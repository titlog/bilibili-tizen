/* Runtime settings. tools/deploy.sh rewrites REPORT_TO on every deploy. */

/* bilibili blocklists curl-shaped agents but accepts anything browser-like.
 * AVPlay sends no useful UA of its own, so this is set explicitly on the
 * stream. */
var USER_AGENT = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36";

/* 80 is 1080p and is what a signed-in account reliably gets on a plain host.
 * Asking for 127 was worse in practice: the tiers above 1080p come back on
 * restricted CDN nodes far more often, and every refusal costs a retry cycle
 * of black screen. Higher tiers are still one press away in the panel. */
var PREFERRED_QN = 80;

/* Dev only: the app posts errors here so a run can be read from the terminal
 * instead of off the screen. Empty disables it. */
var REPORT_TO = "http://192.168.1.10:8099/report";
