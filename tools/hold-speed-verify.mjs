/* Real Nav, Player and application routing, with a fake clock/media engine.
 * Private setup is injected in this VM only; production has no test channel. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL('../app/js/' + name, import.meta.url), 'utf8');
let checks = 0;
function harness() {
  let now = 1000, nextId = 0, effective = 1, toggles = 0, buffering = false, refuse = false;
  const timers = new Map(), events = {}, windowEvents = {}, nodes = new Map(), logs = [], dmRates = [], rates = [];
  const listen = (map, kind, fn) => (map[kind] ||= []).push(fn);
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, className: 'hidden', style: {}, textContent: '', innerHTML: '',
      paused: false, ended: false, currentTime: 10, duration: 120, readyState: 4,
      buffered: {length: 0}, contains: () => false, querySelectorAll: () => [], querySelector: () => null,
      listeners: {}, addEventListener(kind, fn) { (this.listeners[kind] ||= []).push(fn); },
      fire(kind) { for (const fn of this.listeners[kind] || []) fn({}); }, removeAttribute() {}, load() {},
      pause() { this.paused = true; toggles++; }, play() { this.paused = false; toggles++; return Promise.resolve(); },
      getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 100}) });
    return nodes.get(id);
  }
  const document = { body: node('body'), hidden: false, getElementById: node,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (kind, fn) => listen(events, kind, fn) };
  const stored = new Map();
  const c = vm.createContext({console, Promise, Math, document, REPORT_TO: '', SELFTEST: false,
    navigator: {userAgent: 'test'},
    localStorage: {getItem: k => stored.get(k) || null, setItem: (k,v) => stored.set(k,v)},
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } },
    setTimeout: (fn, ms = 0) => { const id = ++nextId; timers.set(id, {fn, at: now + ms}); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextId, clearInterval() {},
    Diag: {record: (kind, line) => logs.push({kind, line}), plain: s => s, priv: s => s},
    Auth: {isLoggedIn: () => false}, API: {related() {}}, Resume: {finished() {}}, Danmaku: new Proxy({}, {get: () => () => undefined}), EpisodeNav: new Proxy({}, {get: () => () => null}),
  });
  c.window = c;
  c.addEventListener = (kind, fn) => listen(windowEvents, kind, fn);
  for (const file of ['settings.js', 'nav.js']) vm.runInContext(source(file), c);
  const engine = {
    isBuffering: () => buffering, unload: () => Promise.resolve(),
    trickPlay: r => { if (refuse) throw new Error('refused'); effective = r; rates.push(r); }, cancelTrickPlay: () => { effective = 1; rates.push(1); },
    getVariantTracks: () => [],
  };
  const playerSource = source('player.js').replace('    return {\n        on:', `
    window.__holdPlayer = {
        setup: function () { mode = 'mse'; shakaPlayer = window.__engine; loadPending = false; },
        emit: emit, bind: bindMediaElement, rebuild: function () { playDashWithShaka({}, 0); },
        mode: function (m) { mode = m; }, loading: function (b) { loadPending = b; }
    };
    return {\n        on:`);
  c.__engine = engine;
  vm.runInContext(playerSource, c);
  vm.runInContext(source('hold-speed.js'), c);
  const appSource = source('app.js').replace('    window.onload = function () {', `
    window.__holdApp = {
        setup: function () {
            playing = { detail: {}, cid: 1 }; pendingNext = null; optionsOpen = false;
            commentsView = null; episodeView = null; scrub = null; opening = null;
            liveRoom = null; barPick = null; actionView = null;
            dm = { rate: window.__dmRate, pause: function () {}, clear: function () {}, set: function () {}, show: function () {}, hide: function () {} };
        },
        state: function (name, value) {
            if (name === 'panel') { optionsOpen = value; }
            if (name === 'next') { pendingNext = value; }
            if (name === 'scrub') { scrub = value; }
            if (name === 'comments') { commentsView = value; }
            if (name === 'episodes') { episodeView = value; }
        },
        panel: openOptions, stop: stopPlayback, hold: function () { return holdSpeed; }
    };
    window.onload = function () {`);
  c.__dmRate = r => dmRates.push(r);
  const on = c.Player.on;
  c.Player.on = fn => { c.__appPlayerEvent = fn; on(fn); };
  vm.runInContext(appSource, c);
  c.__holdPlayer.setup(); c.__holdApp.setup();
  const dispatch = (map, type, event = {}) => { for (const fn of map[type] || []) fn(event); };
  const key = (type, keyCode = 13, repeat = false) => dispatch(events, type, {keyCode, repeat, preventDefault() {}});
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  }
  return {c, key, advance, node, logs, dmRates, rates,
    down: () => key('keydown'), up: () => key('keyup'),
    elapseWithoutTimers: ms => { now += ms; },
    get rate() { return effective; }, get toggles() { return toggles; },
    get indicator() { return node('hold-speed').className === ''; },
    get waiting() { return node('hold-speed').className === 'waiting'; },
    boostLogs: () => logs.filter(x => x.line.includes('临时 2 倍速')),
    blur: () => dispatch(windowEvents, 'blur'),
    hidden: () => { document.hidden = true; dispatch(events, 'visibilitychange'); },
    buffering: b => { buffering = b; }, refuse: b => { refuse = b; },
  };
}
function check(name, run) { run(harness()); checks++; console.log('✓ hold speed: ' + name); }

check('short press pauses exactly once on release', h => {
  h.down(); h.advance(649); assert.equal(h.toggles, 0); h.up(); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true);
  h.advance(1000); assert.equal(h.rate, 1); assert.equal(h.indicator, false);
});
for (const chosen of [1, 1.5]) check(`${chosen}x → temporary 2x → ${chosen}x; chosen label and danmaku`, h => {
  h.c.Player.setRate(chosen); h.down(); h.advance(650);
  assert.equal(h.rate, 2); assert.equal(h.c.Player.effectiveRate(), 2);
  assert.equal(h.c.Player.rate(), chosen); assert.equal(h.indicator, true);
  assert.equal(h.dmRates.at(-1), 2); h.advance(1000); h.up();
  assert.equal(h.rate, chosen); assert.equal(h.c.Player.effectiveRate(), chosen);
  assert.equal(h.dmRates.at(-1), chosen); assert.equal(h.toggles, 0); assert.equal(h.indicator, false);
  assert.equal(h.boostLogs().length, 1); assert.match(h.boostLogs()[0].line, /start=1650 end=2650 duration=1000ms/);
});
check('repeats neither toggle nor restart the threshold', h => {
  h.down(); h.advance(400); h.key('keydown', 13, true); h.key('keydown'); h.advance(250);
  assert.equal(h.rate, 2); h.key('keydown', 13, true); h.advance(900); h.up();
  assert.equal(h.rate, 1); assert.equal(h.toggles, 0); assert.equal(h.boostLogs().length, 1);
});
check('already 2x keeps the engine rate unchanged', h => {
  h.c.Player.setRate(2); const before = h.rates.length;
  h.down(); h.advance(650); assert.equal(h.indicator, true); h.up();
  assert.equal(h.rate, 2); assert.equal(h.rates.length, before); assert.equal(h.toggles, 0);
});
check('paused Enter resumes immediately; repeats cannot boost or pause', h => {
  h.c.Player.pause(); h.down(); assert.equal(h.c.Player.userPaused(), false);
  const before = h.toggles; h.advance(700); h.key('keydown', 13, true); h.advance(700); h.up();
  assert.equal(h.toggles, before); assert.equal(h.rate, 1); assert.equal(h.indicator, false);
});
check('keyup past the threshold before its timer ran: neither pause nor a 0 ms boost', h => {
  h.down(); h.elapseWithoutTimers(650); h.up(); h.advance(1000);
  assert.deepEqual(h.rates, []); assert.equal(h.toggles, 0); assert.equal(h.boostLogs().length, 0);
});
check('PLAY_PAUSE retains immediate toggling', h => {
  h.key('keydown', 10252); assert.equal(h.c.Player.userPaused(), true);
  h.advance(800); h.key('keyup', 10252); assert.equal(h.toggles, 1); assert.equal(h.indicator, false);
});
check('scrub Enter retains immediate commit', h => {
  let target;
  h.c.Player.seekTo = ms => { target = ms; };
  h.c.__holdApp.state('scrub', {target: 42000}); h.down();
  assert.equal(target, 42000); h.up(); h.advance(800);
  assert.equal(h.toggles, 0); assert.equal(h.indicator, false);
});
for (const unavailable of ['avplay', 'live', 'loading', 'buffering']) check(`${unavailable} Enter retains immediate action`, h => {
  if (unavailable === 'loading') h.c.__holdPlayer.loading(true);
  else if (unavailable === 'buffering') h.buffering(true);
  else h.c.__holdPlayer.mode(unavailable);
  h.down(); assert.equal(h.c.Player.userPaused(), true); h.advance(800); h.up();
  assert.equal(h.c.Player.effectiveRate(), 1); assert.equal(h.indicator, false);
});
// A quality pick restarts the video through play(), whose first line ends
// the gesture — covered by the late-release/new-video cases below.
for (const state of ['panel', 'next', 'comments', 'episodes']) check(`release in ${state} cannot become a short press`, h => {
  h.down(); h.advance(200); h.c.__holdApp.state(state, true); h.up(); h.advance(1000);
  assert.equal(h.toggles, 0); assert.equal(h.indicator, false); assert.equal(h.rate, 1);
});
for (const boosted of [false, true]) check(`late release after stop/new video (${boosted ? 'boosted' : 'pending'})`, h => {
  h.c.Player.setRate(1.5); h.down(); h.advance(boosted ? 650 : 200);
  // stopPlayback() / play() cancel first, then tear the player down.
  h.c.__holdApp.hold().cancel('stop'); h.c.Player.stop(); h.c.__holdPlayer.setup(); h.c.__holdApp.setup();
  h.key('keydown', 13, true); h.advance(800); h.up();
  assert.equal(h.rate, 1.5); assert.equal(h.c.Player.rate(), 1.5); assert.equal(h.toggles, 0); assert.equal(h.indicator, false);
});
for (const boosted of [false, true]) check(`another key cancels ${boosted ? 'boost' : 'pending short press'}`, h => {
  h.down(); h.advance(boosted ? 650 : 200); h.key('keydown', 65); h.advance(1000); h.up();
  assert.equal(h.rate, 1); assert.equal(h.toggles, 0); assert.equal(h.indicator, false);
});
check('opening the panel ends the boost within a tick and consumes repeats', h => {
  h.down(); h.advance(650); h.c.__holdApp.state('panel', true); h.c.__holdApp.panel();
  h.advance(250); assert.equal(h.rate, 1); assert.equal(h.indicator, false);
  assert.match(h.boostLogs()[0].line, /reason=screen/);
  h.key('keydown', 13, true); h.up(); assert.equal(h.toggles, 0);
});
check('ending at a fractional chosen speed does not restart the media (player side only)', h => {
  h.c.Player.setRate(1.5); h.down(); h.advance(650);
  h.node('html5-video').ended = true; h.node('html5-video').paused = true;
  const appEvent = h.c.__appPlayerEvent;
  h.c.Player.on((kind, data) => { if (kind === 'holdcancel') appEvent(kind, data); });
  h.c.__holdPlayer.emit('ended'); h.up();
  assert.equal(h.c.Player.effectiveRate(), 1.5); assert.equal(h.toggles, 0); assert.equal(h.indicator, false);
});
for (const exit of ['blur', 'hidden']) check(`after ${exit} with no keyup, the next OK press still works`, h => {
  h.down(); h.advance(650); h[exit]();
  if (exit === 'hidden') h.c.document.hidden = false;
  h.down(); h.advance(100); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.rate, 1); assert.equal(h.indicator, false);
});
for (const exit of ['blur', 'hidden', 'error', 'status', 'tokenSwap', 'rebuild']) {
  check(`${exit} ends pending and active boosts`, () => {
    for (const boosted of [false, true]) {
      const h = harness(); h.down(); h.advance(boosted ? 650 : 200);
      if (exit === 'blur' || exit === 'hidden') h[exit]();
      else if (exit === 'rebuild') {
        // Reach the real loader's entry cancellation before any SDK/network work.
        assert.throws(() => h.c.__holdPlayer.rebuild());
      } else {
        // Stop after the player's lifecycle cancellation; application error/next
        // routing has its own existing suites and needs network/history fixtures.
        const appEvent = h.c.__appPlayerEvent;
        h.c.Player.on((kind, data) => { if (kind === 'holdcancel') appEvent(kind, data); });
        h.c.__holdPlayer.emit(exit, exit === 'status' ? 'retry' : 'failure');
      }
      h.advance(1000); h.up(); assert.equal(h.c.Player.effectiveRate(), 1); assert.equal(h.indicator, false);
      // The player interrupting a press leaves it an OK press: release pauses,
      // unless it already boosted. blur/hidden drop the press entirely.
      const dropped = exit === 'blur' || exit === 'hidden';
      assert.equal(h.toggles, boosted || dropped ? 0 : 1, `${exit} ${boosted ? 'boosted' : 'pending'}`);
    }
  });
}

check('a stall that begins during a tap still pauses on release', h => {
  h.down(); h.advance(200); h.buffering(true); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true); assert.equal(h.indicator, false);
});
check('release while the element is paused restores the chosen rate on resume', h => {
  h.down(); h.advance(650); assert.equal(h.rate, 2);
  h.node('html5-video').paused = true; h.key('keydown', 65);
  assert.equal(h.c.Player.effectiveRate(), 1); assert.equal(h.indicator, false);
  h.c.__holdPlayer.bind(); h.c.Player.on(() => {});
  h.c.Player.resume(); h.node('html5-video').fire('playing'); assert.equal(h.rate, 1); h.up();
});
check('a lost Enter keyup does not turn the next OK into a repeat', h => {
  h.c.__holdPlayer.mode('avplay'); h.down(); assert.equal(h.c.Player.userPaused(), true);
  h.advance(2000); h.down(); assert.equal(h.c.Player.userPaused(), false); h.up();
});
check('repeats of a held OK on AVPlay toggle only once', h => {
  h.c.__holdPlayer.mode('avplay'); h.down();
  for (let i = 0; i < 4; i++) { h.advance(100); h.key('keydown', 13, true); }
  h.advance(100); h.down(); h.up();
  assert.equal(h.c.Player.userPaused(), true);
});
check('a retry notice during a tap still pauses on release', h => {
  const appEvent = h.c.__appPlayerEvent;
  h.c.Player.on((kind, data) => { if (kind === 'holdcancel') appEvent(kind, data); });
  h.down(); h.advance(200); h.c.__holdPlayer.emit('status', 'retry'); h.advance(100); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true); assert.equal(h.rate, 1);
});
check('a hold that starts while buffering boosts once buffering ends', h => {
  h.down(); h.advance(300); h.buffering(true); h.advance(700);
  assert.equal(h.rate, 1); assert.equal(h.indicator, false); assert.equal(h.waiting, true);
  h.buffering(false); h.advance(300); assert.equal(h.rate, 2); assert.equal(h.indicator, true); assert.equal(h.waiting, false);
  h.advance(500); h.up(); assert.equal(h.rate, 1); assert.equal(h.toggles, 0);
});
check('a hold that never gets its boost pauses on release', h => {
  h.down(); h.advance(300); h.buffering(true); h.advance(1500); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true); assert.equal(h.indicator, false);
  h.advance(1000); assert.equal(h.rate, 1);
});
check('an element resumed without resume() drops the released boost', h => {
  h.down(); h.advance(650); assert.equal(h.rate, 2);
  h.node('html5-video').paused = true; h.key('keydown', 65); assert.equal(h.rate, 2);
  h.c.__holdPlayer.bind(); h.c.Player.on(() => {});  // the element listener only, not app routing
  h.node('html5-video').paused = false; h.node('html5-video').fire('playing');
  assert.equal(h.rate, 1); h.up();
});
check('release between retries, just after buffering ended, still pauses', h => {
  h.down(); h.advance(300); h.buffering(true); h.advance(800);   // ticks at 650, 900; next 1150
  h.buffering(false); h.elapseWithoutTimers(20); h.up();
  assert.equal(h.toggles, 1); assert.deepEqual(h.rates, []); assert.equal(h.boostLogs().length, 0);
  assert.equal(h.waiting, false);
});
check('a refused boost is tried once and the release still pauses', h => {
  h.refuse(true); h.down(); h.advance(3000);
  assert.equal(h.logs.filter(x => x.line.includes('倍速设不上')).length, 1);
  assert.equal(h.indicator, false); assert.equal(h.waiting, false); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true);
});
check('an overlay opened without a key ends the boost within a tick', h => {
  h.down(); h.advance(650); assert.equal(h.rate, 2);
  h.c.__holdApp.state('comments', true); h.advance(250);
  assert.equal(h.rate, 1); assert.equal(h.indicator, false); h.up(); assert.equal(h.toggles, 0);
});
check('the first held OK of a run reports its repeat timing once', h => {
  const notes = []; h.c.Nav.onNote(m => notes.push(m));
  h.down(); for (let i = 0; i < 3; i++) { h.advance(i ? 100 : 500); h.key('keydown', 13, true); } h.up();
  h.down(); h.advance(500); h.key('keydown', 13, true); h.up();
  const held = notes.filter(m => m.includes('确认键按住'));
  assert.equal(held.length, 1); assert.match(held[0], /首个连发 500ms，之后 2 次、最长间隔 100ms，e.repeat 有/);
  h.advance(50); h.down(); h.up();
  assert.equal(notes.filter(m => m.includes('抬起后')).length, 1);
});
for (const boosted of [false, true]) check(`ended through the app's own routing: release during the next-video lookup does not pause (${boosted ? 'boosted' : 'pending'})`, h => {
  // Real Player.on → beginAutoNext; API.related never answers, so this is
  // the window before the countdown, where the keys are still the player's.
  h.c.Player.setRate(1.5); h.down(); h.advance(boosted ? 650 : 200);
  h.node('html5-video').ended = true; h.node('html5-video').paused = true;
  h.c.__holdPlayer.emit('ended'); h.advance(100); h.up();
  assert.equal(h.c.Player.userPaused(), false); assert.equal(h.node('pause-glyph').className, 'hidden');
  assert.equal(h.c.Player.effectiveRate(), 1.5); assert.equal(h.indicator, false);
});
check('a hold with no repeats is reported once, as having none', h => {
  const notes = []; h.c.Nav.onNote(m => notes.push(m));
  h.down(); h.advance(300); h.up();                 // a tap: not a hold
  h.down(); h.advance(2000); h.up(); h.down(); h.advance(2000); h.up();
  const held = notes.filter(m => m.includes('确认键按住'));
  assert.equal(held.length, 1); assert.match(held[0], /确认键按住 2000ms：没有连发/);
});
check('a release past the threshold before the timer ran says so', h => {
  h.down(); h.elapseWithoutTimers(700); h.up();
  assert.equal(h.logs.filter(x => x.line.includes('计时器还没跑')).length, 1); assert.equal(h.toggles, 0);
});
for (const exit of ['blur', 'hidden', 'unseen keydown']) check(`a release we did not see pressed is not measured (${exit})`, h => {
  const notes = []; h.c.Nav.onNote(m => notes.push(m));
  h.down(); h.advance(100); h.up();                           // an earlier tap
  if (exit === 'unseen keydown') { h.advance(5000); h.up(); }
  else { h.down(); h.advance(100); h[exit](); if (exit === 'hidden') h.c.document.hidden = false; h.advance(5000); h.up(); }
  assert.equal(notes.filter(m => m.includes('确认键按住')).length, 0);
});
check('a lost keyup after a 2x hold: the next fresh OK press still pauses', h => {
  h.down(); h.advance(2000); assert.equal(h.rate, 2);   // its keyup never arrives
  h.advance(1500); h.down();                             // > REPEAT_GAP_MS: a new press
  assert.equal(h.rate, 1); assert.equal(h.indicator, false);
  assert.match(h.boostLogs().at(-1).line, /reason=lost keyup/);
  h.advance(100); h.up();
  assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true);
});
check('a lost keyup while waiting on buffering: the next fresh OK press acts at once', h => {
  h.down(); h.advance(300); h.buffering(true); h.advance(1500);    // waiting, its keyup never arrives
  assert.equal(h.waiting, true);
  h.down();                                                         // new press; still buffering → immediate toggle
  assert.equal(h.waiting, false); assert.equal(h.toggles, 1); assert.equal(h.c.Player.userPaused(), true);
  h.up(); assert.equal(h.toggles, 1);
});
console.log(`✓ hold speed ${checks}/${checks}`);
