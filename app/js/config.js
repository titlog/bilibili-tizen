/* ------------------------------------------------------------------
 * The only file you need to edit.
 *
 * Paste a bilibili CDN url here. The README shows the two API calls
 * that produce one. Use a NO-LOGIN url for the first run (qn=32,
 * fnval=1) so the Referer question is the only variable in play.
 * ------------------------------------------------------------------ */

var VIDEO_URL = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/40/04/3660440/3660440-1-16.mp4?e=ig8euxZM2rNcNbRVhwdVhwdlhWdVhwdVhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&nbs=1&trid=17381e7475674a5d9670769ab806864u&deadline=1785624197&uipk=5&gen=playurlv3&os=akam&og=hw&platform=pc&mid=0&oi=1435586353&upsig=e992db2e3bff780fe2246efdb9524ac6&uparams=e,nbs,trid,deadline,uipk,gen,os,og,platform,mid,oi&hdnts=exp=1785624197~hmac=9af8cf670d024a909919389e016c5d979c7df54325da0237303d364565269c14&bvc=vod&nettype=0&bw=412809&lrs=0&buvid=&build=0&dl=0&f=u_0_0&qn_dyeid=1c712bb07a27891600aad98e6a6e5a65&agrr=1&orderid=0,2";

/* Leave empty for run one. Once tests pass without it, come back and
 * try SESSDATA here to see whether AVPlay forwards cookies correctly.
 * Format: "SESSDATA=xxxxxxxx" */
var COOKIE = "";

/* Measured on this CDN: any User-Agent works except a curl/* one, and no
 * Referer at all is accepted while a foreign Referer is rejected. So the UA
 * only has to be non-empty and not look like curl. */
var USER_AGENT = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36";

/* How long test 02 shows video before returning to the report, in ms. */
var PLAY_SECONDS = 12;

/* Tests 04 and 05 do not use VIDEO_URL. They call the API themselves, the way
 * a real client would, and play whatever DASH streams come back. Any public
 * no-login video works here. */
var DASH_BVID = "BV1Nr3s6rE79";
var DASH_CID  = 40432239522;

/* Dev convenience: the app posts each run's results here so they can be read
 * from the terminal instead of off the screen. tools/deploy.sh rewrites the
 * address, and tools/collect.mjs is what listens. Empty disables reporting. */
var REPORT_TO = "";
