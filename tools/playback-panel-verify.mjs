/* The playback controls share one choice row. Exercise the production
 * open/close path and rendered choice callbacks with interleaved responses;
 * this controlled DOM does not claim to validate TV geometry or decoding. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const html = source('app/index.html'), appSource = source('app/js/app.js');
const entries = ['panel-quality', 'panel-subtitles', 'panel-autoplay'];
let count = 0;
function check(label, run) { run(); count++; console.log('✓ ' + label); }

check('one shared control row above episode shortcuts, with unique IDs and helpers', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate DOM ID');
  const start = html.indexOf('id="opt-playback-controls"');
  const end = html.indexOf('id="opt-episode-controls"');
  assert.ok(start >= 0 && end > start, 'playback settings must precede episode shortcuts');
  const row = html.slice(start, end).match(/<div class="actions">([\s\S]*?)\n        <\/div>/);
  assert.ok(row, 'missing shared actions row');
  assert.deepEqual([...row[1].matchAll(/\bid="([^"]+)"/g)].map(match => match[1]), entries);
  const helpers = ['closePlaybackChoices', 'paintPlaybackControls', 'paintPlaybackChoices', 'bindPlaybackControls'];
  helpers.push('paintAutoplayControl', 'bindAutoplayControl');
  for (const name of helpers) {
    assert.equal([...appSource.matchAll(new RegExp('^    function ' + name + '\\(', 'gm'))].length, 1, name);
  }
});

function harness() {
  const stored = new Map(), nodes = new Map(), timers = new Map(), intervals = new Map();
  const qualityRequests = [], subtitleRequests = [];
  let focus = null, timerId = 0, actual = 80, keyHandler;
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const value = {id, textContent: '', className: '', style: {}, children: [], offsetParent: {},
      contains(target) { return this.children.includes(target); },
      querySelectorAll(selector) { return selector === '.opt' ? this.children : []; },
      querySelector(selector) {
        if (selector === '.focusable') return this.children[0] || null;
        const match = selector.match(/^\[data-playback-choice="([^"]*)"\]$/);
        return match ? this.children.find(child => child.getAttribute('data-playback-choice') === match[1]) || null : null;
      },
      addEventListener() {},
      getBoundingClientRect() { return {left: 0, top: 0, bottom: 60, width: 200, height: 60}; }
    };
    Object.defineProperty(value, 'innerHTML', {
      get() { return this.markup || ''; },
      set(markup) {
        this.markup = markup;
        this.children = [...markup.matchAll(/<div class="([^"]*)" role="button" data-playback-choice="([^"]*)">([\s\S]*?)<\/div>/g)]
          .map(match => ({className: match[1], textContent: match[3],
            getAttribute: name => name === 'data-playback-choice' ? match[2] : null}));
        if (id === 'panel-act-more') this.children = [...markup.matchAll(/id="(act-(?:coin|fav)-\d+)"/g)]
          .map(match => node(match[1]));
      }
    });
    nodes.set(id, value);
    return value;
  }
  const storage = {getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key)};
  const context = vm.createContext({console, localStorage: storage, REPORT_TO: '', SELFTEST: false,
    document: {getElementById: node, querySelectorAll: () => [],
      querySelector: selector => /^#[\w-]+$/.test(selector) ? node(selector.slice(1)) : null,
      body: node('body'), addEventListener() {}},
    setTimeout: (f, ms) => { const id = ++timerId; timers.set(id, {f, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (f, ms) => { const id = ++timerId; intervals.set(id, {f, ms}); return id; },
    clearInterval: id => intervals.delete(id),
    Diag: {plain: value => value, record() {}, incident() {}},
    Auth: {isLoggedIn: () => false, accessKey: () => ''},
    Nav: {onBack() {}, onKey: f => { keyHandler = f; }, current: () => focus, focus: target => { focus = target; },
      KEY: {RETURN: 10009, UP: 38, DOWN: 40, ENTER: 13, PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19}},
    Player: {on() {}, stop() {}, mode: () => 'shaka', currentQuality: () => actual, qualityChoices: () => [80, 64, 32],
      selectQuality: (qn, done) => { qualityRequests.push({qn, done}); return true; }},
    EpisodeNav: {adjacent: () => null},
    API: {videoActionReady: () => true, view: (b, ok) => ok({bvid: b, cid: 2, title: 'next'}),
      subtitle: (url, ok, fail) => subtitleRequests.push({url, ok, fail})}
  });
  context.window = context;
  context.addEventListener = () => {};
  vm.runInContext(source('app/js/settings.js'), context);
  const marker = '    window.onload = function () {';
  assert.equal(appSource.split(marker).length, 2);
  vm.runInContext(appSource.replace(marker, `
    /* Only unrelated panel sections are stubbed. Playback controls, their
     * shared rendering, async callbacks and key handling remain production code. */
    var testPaintActions = paintPanelActions;
    paintDesc = paintPanelActions = loadPanelActions = loadFollow = paintParts =
        paintSeason = paintEpisodeControls = paintSpeed = function () {};
    panelGrid = { reset: function () {}, clear: function () {} };
    nextupGrid = { reset: function () {} }; prefetchCard = function () {};
    window.__panelTest = {
        open: function (session) { playing = session; optionsOpen = false; toastEl = el("toast"); openOptions(); },
        autoplay: bindAutoplayControl, end: beginAutoNext,
        actions: function () {
            Auth.isLoggedIn = function () { return true; };
            var state = panelActState();
            state.coins = 0;
            state.folders = [{id: 1, title: "First"}, {id: 2, title: "Second"}];
            testPaintActions();
        },
        choice: function () { return playbackChoice; }
    };
` + marker), context);
  const {Settings} = context;
  Settings.set('maxQn', 80);
  Settings.set('preferredQn', 80);
  Settings.set('showSubtitles', false);
  Settings.set('subtitleLanguage', 'en');
  const tracks = [{lan: 'en', lan_doc: 'English', subtitle_url: 'english'},
    {lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'chinese'}];
  const session = {detail: {bvid: 'BVTEST'}, cid: 1, timed: true, route: 'dash',
    qualityReady: true, quality: 80, subtitleTracks: tracks};
  context.__panelTest.open(session);
  const box = node('playback-choices');
  function select(value) {
    const target = box.querySelector('[data-playback-choice="' + value + '"]');
    assert.ok(target, 'missing choice ' + value);
    focus = target;
    target.onselect();
  }
  return {node, Settings, session, context, storage, qualityRequests, subtitleRequests, select, intervals,
    choice: () => context.__panelTest.choice(),
    values: () => box.children.map(child => child.getAttribute('data-playback-choice')),
    focused: () => focus,
    actions: () => context.__panelTest.actions(),
    enter(id) { focus = node(id); assert.equal(typeof focus.onselect, 'function', id + ' not bound'); focus.onselect(); },
    back: () => keyHandler(10009),
    finishQuality(qn) { actual = qn || 80; qualityRequests.at(-1).done(''); }
  };
}

check('opening the production panel binds all controls and keeps their preferences independent', () => {
  const h = harness();
  assert.equal(h.node('options').className, 'scroll rows');
  assert.equal(h.node('panel-quality').textContent, '画质 1080p');
  assert.equal(h.node('panel-subtitles').textContent, '字幕 关');
  assert.equal(h.Settings.get('autoplayNext', true), true);
  assert.equal(h.node('panel-autoplay').textContent, '自动连播 开');
  h.enter('panel-quality');
  assert.deepEqual(h.values(), ['0', '80', '64', '32']);
  h.select('0'); h.finishQuality(0);
  assert.equal(h.Settings.qualityPreference(), 0);
  assert.equal(h.Settings.get('showSubtitles'), false);
  h.enter('panel-subtitles');
  assert.deepEqual(h.values(), ['off', 'auto', '0', '1']);
  h.select('0');
  assert.equal(h.qualityRequests.length, 1, 'subtitle index 0 must not request Auto quality');
  assert.equal(h.subtitleRequests.at(-1).url, 'english');
  h.subtitleRequests.at(-1).ok([{from: 0, to: 10, text: 'English caption'}]);
  assert.equal(h.node('subtitle-text').textContent, 'English caption');
  h.enter('panel-autoplay');
  assert.equal(h.node('panel-autoplay').textContent, '自动连播 关');
  const fresh = vm.createContext({localStorage: h.storage});
  vm.runInContext(source('app/js/settings.js'), fresh);
  assert.equal(fresh.Settings.qualityPreference(), 0);
  assert.equal(fresh.Settings.get('showSubtitles'), true);
  assert.equal(fresh.Settings.subtitleLanguage(), 'en');
  assert.equal(fresh.Settings.get('autoplayNext'), false);
});

check('a late subtitle response keeps quality choices and focus while rendering captions', () => {
  const h = harness();
  h.enter('panel-subtitles'); h.select('0');
  h.enter('panel-quality'); h.select('32');
  assert.equal(h.session.qualityBusy, true);
  h.subtitleRequests.at(-1).ok([{from: 0, to: 10, text: 'caption during quality switch'}]);
  assert.equal(h.choice(), 'quality');
  assert.deepEqual(h.values(), ['0', '80', '64', '32']);
  assert.equal(h.focused().getAttribute('data-playback-choice'), '32');
  assert.equal(h.node('subtitle-text').textContent, 'caption during quality switch');
  assert.equal(h.node('playback-control-status').textContent, '正在切换画质…');
  h.finishQuality(32);
  assert.equal(h.Settings.qualityPreference(), 32);
  assert.equal(h.node('playback-control-status').textContent, '');
});

check('a late quality result keeps subtitle choices, focus and the selected language', () => {
  const h = harness();
  h.enter('panel-quality'); h.select('64');
  h.enter('panel-subtitles'); h.select('1');
  h.finishQuality(64);
  assert.equal(h.choice(), 'subtitles');
  assert.deepEqual(h.values(), ['off', 'auto', '0', '1']);
  assert.equal(h.focused().getAttribute('data-playback-choice'), '1');
  assert.equal(h.Settings.subtitleLanguage(), 'zh-hans');
  assert.equal(h.Settings.qualityPreference(), 64);
  h.subtitleRequests.at(-1).ok([{from: 0, to: 10, text: '切档之后的字幕'}]);
  assert.equal(h.node('subtitle-text').textContent, '切档之后的字幕');
});

check('autoplay leaves either open menu intact and Back restores the right entry before closing', () => {
  for (const entry of ['panel-quality', 'panel-subtitles']) {
    const h = harness();
    h.enter(entry);
    const before = h.values(), choice = h.choice();
    h.enter('panel-autoplay');
    assert.equal(h.Settings.get('autoplayNext'), false);
    assert.equal(h.Settings.qualityPreference(), 80);
    assert.equal(h.Settings.subtitleLanguage(), 'en');
    assert.equal(h.Settings.get('showSubtitles'), false);
    assert.equal(h.choice(), choice);
    assert.deepEqual(h.values(), before);
    assert.equal(h.back(), true);
    assert.equal(h.choice(), '');
    assert.equal(h.node('playback-choices').className, 'opt-row hidden');
    assert.equal(h.focused(), h.node(entry));
    assert.equal(h.node('options').className, 'scroll rows');
    assert.equal(h.back(), true);
    assert.equal(h.node('options').className, 'hidden scroll rows');
  }
});

check('playback and action choices are exclusive and Return restores the latest opener', () => {
  for (const playback of ['panel-quality', 'panel-subtitles']) {
    for (const action of ['panel-coin', 'panel-fav']) {
      for (const actionFirst of [false, true]) {
        const h = harness(); h.actions();
        const [first, last] = actionFirst ? [action, playback] : [playback, action];
        h.enter(first); h.enter(last);
        assert.equal(h.choice(), actionFirst ? playback.slice(6) : '');
        assert.equal(h.node('panel-act-more').className, actionFirst ? 'act-more hidden' : 'act-more');
        assert.equal(h.node('playback-choices').className, actionFirst ? 'opt-row' : 'opt-row hidden');
        assert.equal(h.back(), true);
        assert.equal(h.focused(), h.node(last));
        assert.equal(h.node('panel-act-more').className, 'act-more hidden');
        assert.equal(h.choice(), '');
        assert.equal(h.node('options').className, 'scroll rows');
        h.back(); assert.equal(h.node('options').className, 'hidden scroll rows');
      }
    }
  }
});

check('rebinding autoplay reflects changes made through the shared settings preference', () => {
  const h = harness();
  for (const enabled of [false, true]) {
    h.Settings.set('autoplayNext', enabled); h.context.__panelTest.autoplay();
    assert.equal(h.node('panel-autoplay').textContent, '自动连播 ' + (enabled ? '开' : '关'));
  }
});

check('the production end-of-video chooser starts a countdown only when autoplay is enabled', () => {
  for (const enabled of [false, true]) {
    const h = harness(); h.Settings.set('autoplayNext', enabled);
    h.session.detail.related = [{bvid: 'NEXT'}]; h.context.__panelTest.end();
    assert.equal(h.node('nextup').className, 'scroll');
    assert.equal(h.intervals.size, enabled ? 1 : 0);
    if (!enabled) assert.match(h.node('nextup-hint').textContent, /自动播放已关闭/);
    else assert.equal([...h.intervals.values()][0].ms, 1000);
  }
});

check('device autoplay steps toggle once and restore both initial preferences', () => {
  const deviceSource = source('app/js/selftest.js').replace('    function run() {',
    '    window.__autoplayDeviceSteps = autoplayControlSteps;\n    function run() {');
  for (const initial of [false, true]) {
    const h = harness(); h.Settings.set('autoplayNext', initial);
    vm.runInContext(deviceSource, h.context);
    const steps = h.context.__autoplayDeviceSteps; assert.equal(steps.length, 8);
    steps[0][2](); assert.equal(h.Settings.get('autoplayNext'), true);
    h.context.__panelTest.autoplay(); h.context.Nav.focus(h.node('panel-autoplay'));
    let presses = 0;
    h.context.document.createEvent = () => ({initEvent(kind) { this.kind = kind; }});
    h.context.document.dispatchEvent = e => {
      if (e.kind === 'keyup' && e.keyCode === 13) { presses++; h.node('panel-autoplay').onselect(); }
    };
    assert.equal(steps[3][2](), null); assert.equal(presses, 1);
    assert.equal(h.Settings.get('autoplayNext'), false);
    steps.at(-1)[2](); assert.equal(h.Settings.get('autoplayNext'), initial);
  }
});

console.log(`${count}/${count} combined playback panel scenarios passed (three controls; controlled DOM, not device acceptance).`);
