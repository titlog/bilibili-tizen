/* Exercise deploy.sh's real config writers and EXIT traps in a temporary app.
 * No SDK, signing profile, network or television is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const deploy = fs.readFileSync(new URL('deploy.sh', import.meta.url), 'utf8');
const blocks = [...deploy.matchAll(/^[^\n]*python3 - <<'PY'\n([\s\S]*?)^PY$/gm)]
  .map(match => match[1]).filter(code => code.includes('var SELFTEST ='));
assert.equal(blocks.length, 2, 'find the cleanup and injection Python blocks');
const [restore, inject] = blocks;
const cleanup = deploy.match(/^restore_config\(\) \{[\s\S]*?^trap 'exit 130' INT TERM$/m)?.[0];
assert.ok(cleanup, 'find the real restore function and exit traps');
const modes = ['false', ...new Set([...deploy.matchAll(/^\[ "\$1" = "[^"]+" \] && SELFTEST=(.+)$/gm)]
  .map(match => match[1].replace(/^'(.*)'$/, '$1')))];
assert.ok(modes.includes('"controls-followup"'), 'include the hyphenated test mode');
const original = fs.readFileSync(new URL('../app/js/config.js', import.meta.url), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-deploy-config-'));
const app = path.join(temp, 'app'), config = path.join(app, 'js', 'config.js');
fs.mkdirSync(path.dirname(config), {recursive: true});
const env = {...process.env, APP: app, HOST_IP: '192.0.2.1', DIAG_TO: 'http://192.0.2.2/diagnostics'};

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {env: {...env, ...extra},
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000});
  assert.ifError(result.error);
  return result;
}
function python(code, mode = 'false') {
  const result = run('python3', ['-c', code], {SELFTEST: mode});
  assert.equal(result.status, 0, result.stderr);
}
function value(name) {
  const declaration = fs.readFileSync(config, 'utf8').match(new RegExp('^var ' + name + ' = (.+);$', 'm'));
  assert.ok(declaration, 'config declares ' + name);
  return JSON.parse(declaration[1]);
}
function injected(mode) {
  assert.equal(value('SELFTEST'), JSON.parse(mode), 'inject ' + mode);
  assert.equal(value('REPORT_TO'), 'http://192.0.2.1:8099/report');
  assert.equal(value('DIAG_TO'), env.DIAG_TO);
}
function restored(label) {
  assert.equal(value('SELFTEST'), false, label + ': clear SELFTEST');
  assert.equal(value('REPORT_TO'), '', label + ': clear REPORT_TO');
  assert.equal(value('DIAG_TO'), '', label + ': clear DIAG_TO');
}

try {
  for (const mode of modes) {
    fs.writeFileSync(config, original);
    python(inject, mode); injected(mode);
    python(restore); restored(mode);
  }
  // A previous interrupted build may already have left a test mode in source.
  fs.writeFileSync(config, original);
  python(inject, '"controls-followup"');
  python(inject, 'false'); injected('false');
  python(restore); restored('normal build after controls-followup');

  for (const [exit, status] of [['exit 0', 0], ['exit 7', 7], ['kill -TERM $$', 130]]) {
    fs.writeFileSync(config, original);
    python(inject, '"controls-followup"');
    const result = run('zsh', ['-c', cleanup + '\n' + exit + '\n']);
    assert.equal(result.status, status, result.stderr);
    restored(exit);
  }
  console.log('Deploy config: ' + modes.length + ' modes, normal-build recovery and 3 exit paths passed.');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
