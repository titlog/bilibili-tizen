/* Runtime settings. tools/deploy.sh rewrites REPORT_TO on every deploy. */

/* bilibili blocklists curl-shaped agents but accepts anything browser-like.
 * AVPlay sends no useful UA of its own, so this is set explicitly on the
 * stream. */
var USER_AGENT = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36";

/* Ask for the top tier and let bilibili clamp it to whatever the account is
 * entitled to: signed out that lands on 720p, signed in on 1080p or better.
 * Settings overrides this once the viewer picks a quality by hand. */
var PREFERRED_QN = 127;

/* Dev only: the app posts errors here so a run can be read from the terminal
 * instead of off the screen. Empty disables it. */
var REPORT_TO = "http://192.168.1.10:8099/report";
