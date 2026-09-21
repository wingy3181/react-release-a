'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let cwd = process.cwd();
const cli = path.join(__dirname, 'cli.cjs');
function call(args, failure = false) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (failure) {
    assert.notEqual(r.status, 0, `Expected rejection: ${args}`);
    return;
  }
  assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function state() {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, '.git/release-poc/state.json')),
  );
}
function prod() {
  return JSON.parse(
    fs.readFileSync(path.join(state().storage, 'production.json')),
  );
}
function git(...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function change(target, id) {
  call(['change', target, id]);
  const out = call(['merge', `feature/${id}`]);
  return out.split('\n').filter((x) => /^[a-f0-9]{40}$/.test(x));
}
function close(train) {
  call(['close', train]);
  call(['merge', state().branches[train].snapshot.branch]);
  call(['close', train]);
}
try {
  const out = call(['setup']);
  cwd = out.match(/POC_WORKSPACE=(.+)/)[1];
  console.log(`Sandbox: ${cwd}`);
  call(['train-cut', '2026.09.01'], true); // version-only changes must not select apps
  change('both', 'initial');
  call(['train-cut', '2026.09.01']);
  const t1 = 'release/2026.09.01';
  const before = state().branches[t1].apps;
  assert.deepEqual(Object.keys(before).sort(), ['api', 'shop']);
  call(['train-cut', '2026.09.02'], true);
  call(['close', t1], true);
  call(['deploy', t1, 'shop']);
  call(['deploy', t1, 'api', 'fail']);
  assert.notEqual(prod().api.version, before.api.version);
  const fix = change('api', 'api-fix');
  call(['pick', t1, 'api-fix', ...fix]);
  const after = state().branches[t1].apps;
  assert.equal(after.shop.sourceSha, before.shop.sourceSha);
  assert.notEqual(after.api.version, before.api.version);
  call(['pick', t1, 'api-fix', ...fix]);
  assert.deepEqual(state().branches[t1].apps, after);
  call(['pick', t1, 'api-fix', before.api.sourceSha], true);
  call(['deploy', t1, 'api']);
  close(t1);
  console.log(
    'PASS: both apps, failed deployment, isolated fix, idempotency, closure',
  );
  call(['train-cut', '2026.09.02'], true); // previously cherry-picked fix is already deployed
  change('shop', 'shop-next');
  call(['train-cut', '2026.09.02']);
  const t2 = 'release/2026.09.02';
  assert.deepEqual(Object.keys(state().branches[t2].apps), ['shop']);
  call(['deploy', t2, 'shop']);
  close(t2);
  console.log('PASS: direct deployed-source comparison selects only shop');
  change('api', 'api-next');
  call(['train-cut', '2026.09.03']);
  const t3 = 'release/2026.09.03';
  assert.deepEqual(Object.keys(state().branches[t3].apps), ['api']);
  const shared = change('shared', 'shared-fix');
  call(['pick', t3, 'shared-fix', ...shared]);
  assert.deepEqual(Object.keys(state().branches[t3].apps).sort(), [
    'api',
    'shop',
  ]);
  call(['hotfix-cut', 'api', 'urgent']);
  call(['hotfix-cut', 'api', 'another'], true);
  const urgent = change('api', 'urgent');
  call(['pick', 'hotfix/api/urgent', 'urgent', ...urgent]);
  call(['deploy', t3, 'api'], true);
  call(['deploy', 'hotfix/api/urgent', 'api']);
  call(['close', 'hotfix/api/urgent'], true);
  call(['pick', t3, 'urgent', ...urgent]);
  call(['close', 'hotfix/api/urgent']);
  call(['deploy', t3, 'api']);
  call(['deploy', t3, 'shop']);
  close(t3);
  console.log(
    'PASS: dynamic shared-library membership, hotfix exclusion and propagation',
  );
  change('shared', 'shared-next');
  call(['train-cut', '2026.09.04']);
  const t4 = 'release/2026.09.04';
  assert.deepEqual(Object.keys(state().branches[t4].apps).sort(), [
    'api',
    'shop',
  ]);
  call(['deploy', t4, 'shop']);
  call(['deploy', t4, 'api']);
  close(t4);
  call(['close', t4]);
  console.log('PASS: shared-library cut and repeated finalization');
  // A rebase-merged PR can contain multiple commits: one candidate bump per batch.
  call(['change', 'api', 'multi-a']);
  fs.writeFileSync(
    path.join(cwd, 'apps/api/src/poc-multi-b.ts'),
    'export {};\n',
  );
  git('add', 'apps/api/src/poc-multi-b.ts');
  git('commit', '-m', 'test(poc): second PR commit');
  const multi = call(['merge', 'feature/multi-a'])
    .split('\n')
    .filter((x) => /^[a-f0-9]{40}$/.test(x));
  assert.equal(multi.length, 2);
  // A hotfix gives us a branch that predates both commits.
  call(['hotfix-cut', 'api', 'multi']);
  const oldVersion = prod().api.version;
  call(['pick', 'hotfix/api/multi', 'multi', ...multi]);
  assert.equal(
    state().branches['hotfix/api/multi'].apps.api.version,
    require('semver').inc(oldVersion, 'patch'),
  );
  call(['deploy', 'hotfix/api/multi', 'api']);
  call(['close', 'hotfix/api/multi']);
  console.log('PASS: multi-commit PR produces one patch bump');
  console.log(`All scenarios passed. Sandbox retained: ${cwd}`);
} catch (e) {
  console.error(e);
  console.error(`Sandbox retained for diagnosis: ${cwd}`);
  process.exitCode = 1;
}
