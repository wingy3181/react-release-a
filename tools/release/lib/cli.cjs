#!/usr/bin/env node
'use strict';

// Shell entry points delegate parsing/state to Node. Versioning always uses Nx CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const semver = require('semver');
const apps = { shop: '@org/shop', api: '@org/api' };
let root = process.cwd();
let state;
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      NX_DAEMON: 'false',
      NX_ISOLATE_PLUGINS: 'false',
      NX_INTERACTIVE: 'false',
      NX_NO_CLOUD: 'true',
    },
    ...options,
  });
  if (r.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')}\n${r.stderr || ''}\n${r.stdout || ''}`,
    );
  return (r.stdout || '').trim();
}
const git = (...args) => run('git', args);
const nx = (...args) => run('npx', ['--no-install', 'nx', ...args]);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = `${p}.tmp`;
  fs.writeFileSync(t, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(t, p);
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
function clean() {
  assert(
    !git('status', '--porcelain'),
    'Working tree must be clean. Resolve/abort any interrupted Git operation first.',
  );
}
function sha(ref = 'HEAD') {
  return git('rev-parse', '--verify', `${ref}^{commit}`);
}
function branch() {
  return git('branch', '--show-current');
}
function version(app) {
  return read(path.join(root, 'apps', app, 'package.json')).version;
}
function save() {
  write(path.join(root, '.git/release-poc/state.json'), state);
}
function commit(message) {
  git('add', '--all');
  git('commit', '-m', message);
}
function push() {
  git('push', 'origin', branch());
}
function tag(name, target) {
  const exists = git('tag', '--list', name);
  if (exists) assert(sha(name) === sha(target), `Tag collision: ${name}`);
  else git('tag', '-a', name, target, '-m', name);
  git('push', 'origin', `refs/tags/${name}`);
}
function checkRemote(expected) {
  assert(
    expected && git('remote', 'get-url', 'origin') === expected,
    'origin does not match the explicitly selected remote.',
  );
  assert(
    git('remote', 'get-url', '--push', 'origin') === expected,
    'origin push URL differs from the selected remote.',
  );
}
function project(app) {
  assert(apps[app], `Unknown app ${app}; use shop or api`);
  return apps[app];
}
function bump(app, specifier) {
  nx('release', 'version', specifier, `--projects=${project(app)}`);
}
function getBranch(name) {
  assert(state.branches[name], `Unknown release/hotfix branch: ${name}`);
  return state.branches[name];
}
function checkout(name) {
  clean();
  git('checkout', name);
}
function stableJson(x) {
  if (Array.isArray(x)) return x.map(stableJson);
  if (x && typeof x === 'object')
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, stableJson(x[k])]),
    );
  return x;
}
function content(ref, file) {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return null;
  }
}
function normalized(ref, file) {
  const raw = content(ref, file);
  if (raw === null) return null;
  if (Object.keys(apps).some((a) => file === `apps/${a}/package.json`)) {
    const j = JSON.parse(raw);
    delete j.version;
    return JSON.stringify(stableJson(j));
  }
  if (file === 'package-lock.json') {
    const j = JSON.parse(raw);
    for (const a of Object.keys(apps))
      if (j.packages?.[`apps/${a}`]) delete j.packages[`apps/${a}`].version;
    return JSON.stringify(stableJson(j));
  }
  return raw;
}
function affected(base, head) {
  const files = git('diff', '--name-only', '--no-renames', base, head)
    .split('\n')
    .filter(Boolean)
    .filter((f) => normalized(base, f) !== normalized(head, f));
  if (!files.length) return [];
  const output = nx(
    'show',
    'projects',
    '--affected',
    `--files=${files.join(',')}`,
    '--json',
  );
  const names = JSON.parse(output);
  return Object.keys(apps).filter((a) => names.includes(apps[a]));
}
function production() {
  return read(path.join(state.storage, 'production.json'));
}
function patchFingerprint(id) {
  return run('git', ['patch-id', '--stable'], {
    input: git('show', '--format=', id),
  }).split(' ')[0];
}
function containsFix(tip, id) {
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', id, tip], { cwd: root })
      .status === 0
  )
    return true;
  const fp = patchFingerprint(id);
  return git('rev-list', tip)
    .split('\n')
    .some((c) => patchFingerprint(c) === fp);
}
function candidate(b, selected, key) {
  // Journal before mutations: an interrupted preparation is blocked, never silently repeated.
  const op = b.operations[key];
  if (op?.status === 'complete') return op.candidates;
  assert(
    !op,
    `Operation ${key} was interrupted. Inspect sandbox; do not blindly bump again.`,
  );
  b.operations[key] = { status: 'preparing', base: sha() };
  save();
  for (const app of selected) {
    let next = semver.inc(version(app), 'patch');
    while (git('tag', '--list', `${project(app)}@${next}`))
      next = semver.inc(next, 'patch');
    // Explicit only when skipping a consumed version; normal operations use patch.
    bump(app, next === semver.inc(version(app), 'patch') ? 'patch' : next);
  }
  if (git('status', '--porcelain')) commit(`chore(release): ${key}`);
  push();
  const records = {};
  for (const app of selected) {
    const v = version(app);
    const sourceSha = sha();
    const name = `${project(app)}@${v}`;
    tag(name, sourceSha);
    records[app] = { version: v, sourceSha, tag: name };
    b.apps[app] = records[app];
  }
  b.operations[key] = { status: 'complete', candidates: records };
  save();
  console.log(JSON.stringify(records, null, 2));
  return records;
}
function cutTrain(id) {
  assert(/^\d{4}\.\d{2}\.\d{2}$/.test(id || ''), 'Usage: cut.sh yyyy.mm.nn');
  const name = `release/${id}`;
  if (state.branches[name]) {
    console.log(`Already created: ${name}`);
    return;
  }
  assert(
    !Object.values(state.branches).some((b) => b.kind === 'train' && !b.closed),
    'A normal train is still open (including snapshot bookkeeping).',
  );
  assert(
    !git('ls-remote', '--heads', 'origin', 'refs/heads/release/*'),
    'Remote has an open release branch.',
  );
  checkout('main');
  const cutoff = sha();
  const prod = production();
  const selected = Object.keys(apps).filter((a) =>
    affected(prod[a].tag, cutoff).includes(a),
  );
  assert(selected.length, 'No application content changes since production.');
  git('checkout', '-b', name);
  const b = (state.branches[name] = {
    kind: 'train',
    cut: cutoff,
    apps: {},
    operations: {},
    fixes: [],
  });
  save();
  candidate(b, selected, `cut-${id}`);
}
function cutHotfix(app, id) {
  project(app);
  assert(
    /^[a-zA-Z0-9._-]+$/.test(id || ''),
    'Usage: cut.sh shop|api identifier',
  );
  const name = `hotfix/${app}/${id}`;
  if (state.branches[name]) {
    console.log(`Already created: ${name}`);
    return;
  }
  assert(
    !Object.entries(state.branches).some(
      ([n, b]) => n.startsWith(`hotfix/${app}/`) && !b.closed,
    ),
    `An ${app} hotfix is already open.`,
  );
  assert(
    !git('ls-remote', '--heads', 'origin', `refs/heads/hotfix/${app}/*`),
    'Remote hotfix already open.',
  );
  clean();
  git('checkout', '-b', name, production()[app].tag);
  state.branches[name] = {
    kind: 'hotfix',
    app,
    apps: {},
    operations: {},
    fixes: [],
  };
  save();
  push();
  console.log(name);
}
function pick(name, operation, refs) {
  assert(
    /^[a-zA-Z0-9._-]+$/.test(operation || '') && refs.length,
    'Usage: cherry-pick.sh branch operation-id sha [sha ...]',
  );
  const b = getBranch(name);
  assert(!b.closed && !b.snapshot, 'Branch is closed or finalizing.');
  const ids = refs.map((r) => sha(r));
  const key = `pick-${operation}`;
  const previous = b.picks?.[key];
  if (previous) {
    assert(
      JSON.stringify(previous.ids) === JSON.stringify(ids),
      'Operation ID reused with different commits.',
    );
    assert(
      b.operations[key]?.status === 'complete',
      'Interrupted cherry-pick operation; inspect and recover sandbox first.',
    );
    console.log('Already processed');
    return;
  }
  for (const id of ids) {
    assert(
      git('rev-list', '--parents', '-n', '1', id).split(' ').length === 2,
      'Supply rebase-merged, non-merge commits.',
    );
    assert(
      spawnSync('git', ['merge-base', '--is-ancestor', id, 'main'], {
        cwd: root,
      }).status === 0,
      'Fix must first be merged to main.',
    );
  }
  checkout(name);
  const before = sha();
  b.picks ??= {};
  b.picks[key] = { ids, before };
  save();
  git('cherry-pick', ...ids);
  const selected = affected(before, sha());
  assert(
    b.kind !== 'hotfix' || selected.every((a) => a === b.app),
    'Hotfix affects another app. Stop and review; operation remains blocked.',
  );
  b.fixes.push(...ids);
  save();
  candidate(b, selected, key);
}
function verify(name) {
  const b = getBranch(name);
  const prod = production();
  assert(Object.keys(b.apps).length, 'No prepared candidates.');
  for (const [a, c] of Object.entries(b.apps))
    assert(
      prod[a]?.version === c.version && prod[a]?.sourceSha === c.sourceSha,
      `${a}: production does not match ${c.tag}`,
    );
  console.log(`Verified ${name}`);
}
function close(name) {
  const b = getBranch(name);
  if (b.closed) {
    console.log('Already closed');
    return;
  }
  verify(name);
  if (b.kind === 'hotfix') {
    for (const [n, t] of Object.entries(state.branches))
      if (t.kind === 'train' && !t.closed) {
        for (const id of b.fixes)
          assert(
            containsFix(n, id),
            `Propagate hotfix ${id} into ${n} before closing.`,
          );
      }
  } else {
    assert(
      !Object.values(state.branches).some(
        (x) => x.kind === 'hotfix' && !x.closed,
      ),
      'Close active hotfixes before finalizing train.',
    );
    if (!b.snapshot) {
      checkout(name);
      tag(`train/${name.slice(8)}`, sha());
      checkout('main');
      const snapshot = `bookkeeping/${name.slice(8)}`;
      git('checkout', '-b', snapshot);
      for (const [app, c] of Object.entries(b.apps)) {
        const next = semver.inc(c.version, 'preminor', 'snapshot');
        assert(
          !semver.gt(version(app), next),
          `${app}: main already advanced beyond ${next}`,
        );
        if (version(app) !== next) bump(app, next);
      }
      commit(`chore(release): snapshots after ${name}`);
      push();
      b.snapshot = { branch: snapshot, sha: sha() };
      save();
      console.log(`Merge bookkeeping PR: ${snapshot}, then rerun close.`);
      return;
    }
    assert(
      state.merges[b.snapshot.branch],
      'Snapshot PR must be merged before branch deletion.',
    );
  }
  checkout('main');
  git('push', 'origin', '--delete', name);
  git('branch', '-D', name);
  b.closed = true;
  save();
  console.log(`Closed ${name}`);
}
function change(target, name) {
  assert(
    ['shop', 'api', 'both', 'shared'].includes(target),
    'Usage: change.sh shop|api|both|shared feature-name',
  );
  assert(/^[a-zA-Z0-9._-]+$/.test(name || ''), 'Invalid feature name');
  checkout('main');
  git('checkout', '-b', `feature/${name}`);
  // Separate files make unrelated synthetic PRs independently cherry-pickable.
  const dirs =
    target === 'shared'
      ? ['packages/shared/models/src']
      : (target === 'both' ? ['shop', 'api'] : [target]).map(
          (a) => `apps/${a}/src`,
        );
  for (const dir of dirs)
    fs.writeFileSync(
      path.join(root, dir, `poc-${name}.ts`),
      `// Release POC source change: ${name}\nexport {};\n`,
    );
  commit(`test(poc): ${target} ${name}`);
  push();
  console.log(`feature/${name}`);
}
function merge(name) {
  if (state.merges[name]) {
    console.log(state.merges[name].join('\n'));
    return;
  }
  assert(
    name?.startsWith('feature/') || name?.startsWith('bookkeeping/'),
    'Only feature/bookkeeping PRs can be simulated.',
  );
  checkout('main');
  const before = sha();
  checkout(name);
  git('rebase', 'main');
  checkout('main');
  git('merge', '--ff-only', name);
  push();
  const ids = git('rev-list', '--reverse', `${before}..HEAD`)
    .split('\n')
    .filter(Boolean);
  state.merges[name] = ids;
  save();
  console.log(ids.join('\n'));
}
function deploy(name, app, mode = 'success') {
  const b = getBranch(name);
  const c = b.apps[app];
  assert(c, 'No candidate for app');
  assert(['success', 'fail'].includes(mode), 'Use success or fail');
  if (b.kind === 'train')
    assert(
      !Object.values(state.branches).some(
        (x) => x.kind === 'hotfix' && x.app === app && !x.closed,
      ),
      'Hotfix in progress: normal deployment blocked.',
    );
  checkout(name);
  assert(
    sha() === c.sourceSha || !affected(c.sourceSha, sha()).includes(app),
    'Candidate is stale: relevant changes since build source.',
  );
  const artifact = path.join(
    state.storage,
    'artifacts',
    `${app}-${c.version}.json`,
  );
  if (!fs.existsSync(artifact)) {
    const original = branch();
    git('checkout', '--detach', c.sourceSha);
    try {
      const real = process.env.RELEASE_POC_REAL_BUILD === '1';
      let archive;
      let artifactId = `mock:${app}:${c.version}:${c.sourceSha}`;
      if (real) {
        nx('run', `${project(app)}:build`);
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        archive = path.join(path.dirname(artifact), `${app}-${c.version}.tgz`);
        assert(
          fs.existsSync(path.join(root, `apps/${app}/dist`)),
          'Build output missing',
        );
        run('tar', [
          '-czf',
          archive,
          '-C',
          path.join(root, `apps/${app}/dist`),
          '.',
        ]);
        artifactId = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`;
      }
      write(artifact, {
        ...c,
        simulated: !real,
        archive,
        artifactId,
      });
    } finally {
      git('checkout', original);
    }
  }
  const prod = production();
  const record = read(artifact);
  assert(
    record.sourceSha === c.sourceSha && record.version === c.version,
    'Artifact provenance mismatch',
  );
  if (record.archive)
    assert(
      record.artifactId ===
        `sha256:${crypto.createHash('sha256').update(fs.readFileSync(record.archive)).digest('hex')}`,
      'Artifact checksum mismatch',
    );
  if (mode === 'fail') {
    console.log('Simulated failure: artifact retained, production unchanged.');
    return;
  }
  assert(
    !semver.gt(prod[app].version, c.version),
    'Refusing deployment downgrade.',
  );
  prod[app] = record;
  write(path.join(state.storage, 'production.json'), prod);
  console.log(`Simulated production: ${app} ${c.version}`);
}
function bootstrap() {
  // Persist a journal before the first tag/push so setup can safely resume.
  if (!state.bootstrap) {
    const sourceSha = sha();
    const prod = {};
    for (const a of Object.keys(apps)) {
      const v = version(a);
      assert(
        semver.valid(v) && !semver.prerelease(v),
        `${a}: bootstrap requires a stable baseline version.`,
      );
      prod[a] = {
        version: v,
        sourceSha,
        tag: `${project(a)}@${v}`,
        artifactId: 'bootstrap',
      };
      const existing = git('tag', '--list', prod[a].tag);
      assert(
        !existing || sha(existing) === sourceSha,
        `Baseline tag collision: ${prod[a].tag}`,
      );
    }
    state.bootstrap = { status: 'preparing', production: prod };
    save();
  }
  const initial = state.bootstrap;
  if (initial.status === 'complete') {
    console.log('Already initialized.');
    return;
  }
  assert(branch() === 'main', 'Resume initialization on main.');
  for (const c of Object.values(initial.production)) tag(c.tag, c.sourceSha);
  const prodPath = path.join(state.storage, 'production.json');
  if (!fs.existsSync(prodPath)) write(prodPath, initial.production);
  for (const [a, c] of Object.entries(initial.production)) {
    const next = semver.inc(c.version, 'preminor', 'snapshot');
    assert(
      [c.version, next].includes(version(a)),
      `${a}: unexpected version during bootstrap recovery.`,
    );
    if (version(a) !== next) bump(a, next);
  }
  const allowed = [
    'apps/shop/package.json',
    'apps/api/package.json',
    'package-lock.json',
  ];
  const changed = git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().replace(/^[A-Z?!]{1,2}\s+/, ''));
  assert(
    changed.every((f) => allowed.includes(f)),
    'Unexpected changes during initialization; inspect before retrying.',
  );
  if (changed.length) {
    git('add', '--', ...allowed);
    git('commit', '-m', 'chore(poc): initial development snapshots');
  }
  push();
  initial.status = 'complete';
  save();
}
function setupInPlace(args) {
  const remoteIndex = args.indexOf('--remote');
  const remote = args[remoteIndex + 1];
  assert(
    remoteIndex >= 0 && remote && !remote.startsWith('--'),
    'Usage: setup.sh --in-place --remote EXACT_ORIGIN_URL [--dry-run]',
  );
  assert(
    args.every(
      (a, i) =>
        ['--in-place', '--remote', '--dry-run'].includes(a) ||
        i === remoteIndex + 1,
    ),
    'Unknown setup argument.',
  );
  root = git('rev-parse', '--show-toplevel');
  assert(
    fs.statSync(path.join(root, '.git')).isDirectory(),
    'In-place POC requires a regular checkout, not a linked worktree.',
  );
  checkRemote(remote);
  assert(branch() === 'main', 'Initialize on main.');
  const marker = path.join(root, '.git/release-poc/state.json');
  if (fs.existsSync(marker)) {
    state = read(marker);
    assert(
      state.mode === 'in-place' && state.remote === remote,
      'Existing state belongs to another mode/remote.',
    );
    if (state.bootstrap?.status === 'complete') {
      console.log('Already initialized.');
      return;
    }
  } else {
    if (!args.includes('--dry-run')) clean();
    state = {
      mode: 'in-place',
      remote,
      storage: path.join(root, '.git/release-poc/runtime'),
      branches: {},
      merges: {},
    };
  }
  if (args.includes('--dry-run')) {
    console.log(
      JSON.stringify(
        {
          workspace: root,
          remote,
          mode: 'in-place',
          baseline: sha(),
          apps: Object.fromEntries(
            Object.keys(apps).map((a) => [
              a,
              {
                current: version(a),
                snapshot: semver.inc(version(a), 'preminor', 'snapshot'),
              },
            ]),
          ),
          actions: [
            'Verify remote main and existing tags',
            'Push baseline app tags',
            'Seed mock production manifest',
            'Commit and push initial snapshots on main',
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const lock = path.join(path.dirname(marker), 'lock');
  fs.mkdirSync(lock);
  try {
    if (!state.bootstrap) {
      const remoteMain = git(
        'ls-remote',
        '--heads',
        'origin',
        'refs/heads/main',
      ).split(/\s/)[0];
      assert(
        remoteMain === sha(),
        'Push main first; local HEAD must equal remote main before initialization.',
      );
      assert(
        !git(
          'ls-remote',
          '--heads',
          'origin',
          'refs/heads/release/*',
          'refs/heads/hotfix/*',
        ),
        'Existing release/hotfix branches require review before initialization.',
      );
      git('fetch', 'origin', '--tags');
    }
    bootstrap();
    console.log(`POC_WORKSPACE=${root}`);
  } finally {
    fs.rmdirSync(lock);
  }
}
function setup(args = []) {
  if (args.includes('--in-place')) return setupInPlace(args);
  assert(
    args.length === 0,
    'Use --in-place --remote URL, or no arguments for a disposable clone.',
  );
  const source = git('rev-parse', '--show-toplevel');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-release-poc-'));
  const remote = path.join(home, 'origin.git');
  const work = path.join(home, 'work');
  run('git', ['init', '--bare', remote]);
  run('git', ['clone', '--no-hardlinks', source, work]);
  // Overlay only the POC implementation/config, allowing testing before these files are committed.
  fs.cpSync(
    path.join(source, 'tools/release'),
    path.join(work, 'tools/release'),
    { recursive: true },
  );
  fs.copyFileSync(path.join(source, 'nx.json'), path.join(work, 'nx.json'));
  root = work;
  git('remote', 'set-url', 'origin', remote);
  git('config', 'user.name', 'Release POC');
  git('config', 'user.email', 'release-poc@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('checkout', '-B', 'main');
  fs.appendFileSync(path.join(work, '.git/info/exclude'), '\nnode_modules\n');
  // Preserve npm's relative workspace links so builds consume this checkout's
  // libraries, not the original workspace. Copy-on-write where supported.
  fs.cpSync(
    path.join(source, 'node_modules'),
    path.join(work, 'node_modules'),
    {
      recursive: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    },
  );
  for (const app of Object.keys(apps))
    assert(
      fs.realpathSync(path.join(work, 'node_modules', project(app))) ===
        fs.realpathSync(path.join(work, 'apps', app)),
      'Workspace package links must resolve inside the sandbox. Run npm ci in the source workspace.',
    );
  if (git('status', '--porcelain'))
    commit('chore(poc): release implementation');
  state = {
    storage: path.join(home, 'state'),
    branches: {},
    merges: {},
    remote,
  };
  bootstrap();
  console.log(`POC_WORKSPACE=${work}`);
  return work;
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (args.includes('--help')) {
    const usage = {
      setup: '[--in-place --remote EXACT_ORIGIN_URL [--dry-run]]',
      'train-cut': 'yyyy.mm.nn',
      'hotfix-cut': 'shop|api identifier',
      pick: 'release-or-hotfix-branch operation-id sha [sha ...]',
      verify: 'release-or-hotfix-branch',
      close: 'release-or-hotfix-branch',
      change: 'shop|api|both|shared feature-name',
      merge: 'feature/name|bookkeeping/train-id',
      deploy: 'release-or-hotfix-branch shop|api [success|fail]',
      status: '(no arguments)',
    };
    console.log(
      `Usage: ${command} ${usage[command] || ''}\nSee tools/release/README.md. Deployments are simulated; Git operations use the initialized remote.`,
    );
    return;
  }
  if (command === 'setup') return setup(args);
  root = git('rev-parse', '--show-toplevel');
  const marker = path.join(root, '.git/release-poc/state.json');
  assert(
    fs.existsSync(marker),
    'Initialize first with simulation/setup.sh (disposable) or --in-place --remote URL.',
  );
  state = read(marker);
  checkRemote(state.remote);
  assert(
    state.mode === 'in-place' ||
      (path.isAbsolute(state.remote) && fs.existsSync(state.remote)),
    'Disposable mode requires its local remote.',
  );
  assert(
    !state.bootstrap || state.bootstrap.status === 'complete',
    'Initialization incomplete; rerun setup with the original arguments.',
  );
  const lock = path.join(root, '.git/release-poc/lock');
  assert(
    !fs.existsSync(lock),
    'Another operation is active. If a process crashed, inspect state before removing the lock.',
  );
  fs.mkdirSync(lock);
  try {
    const commands = {
      'train-cut': () => cutTrain(args[0]),
      'hotfix-cut': () => cutHotfix(...args),
      pick: () => pick(args[0], args[1], args.slice(2)),
      verify: () => verify(args[0]),
      close: () => close(args[0]),
      change: () => change(...args),
      merge: () => merge(args[0]),
      deploy: () => deploy(...args),
      status: () =>
        console.log(
          JSON.stringify({ ...state, production: production() }, null, 2),
        ),
    };
    assert(commands[command], `Unknown command ${command}`);
    commands[command]();
  } finally {
    fs.rmdirSync(lock);
  }
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
