/* ------------------------------------------------------------------
 * The only file you need to edit.
 *
 * Paste a bilibili CDN url here. The README shows the two API calls
 * that produce one. Use a NO-LOGIN url for the first run (qn=32,
 * fnval=1) so the Referer question is the only variable in play.
 * ------------------------------------------------------------------ */

var VIDEO_URL = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/40/04/3660440/3660440-1-16.mp4?e=ig8euxZM2rNcNbRVhwdVhwdlhWdVhwdVhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&platform=pc&nbs=1&trid=545870c324294ccf95dc07b8ea64315u&mid=0&og=hw&deadline=1785626795&uipk=5&oi=1435586353&gen=playurlv3&os=akam&upsig=6205de014da7eca04946215512f7d8d5&uparams=e,platform,nbs,trid,mid,og,deadline,uipk,oi,gen,os&hdnts=exp=1785626795~hmac=bebc6c468d97b2f001a855e8b2e06a07f0052868988dfdf30f1964747ececfc8&bvc=vod&nettype=0&bw=412809&lrs=0&dl=0&f=u_0_0&qn_dyeid=ca3052b99533e153008443086a6e648b&agrr=1&buvid=&build=0&orderid=0,2";

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
var REPORT_TO = "http://192.168.1.10:8099/report";
