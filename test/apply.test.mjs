import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APPLY = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apply.mjs');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-apply-')));
after(() => rmSync(sandbox, { recursive: true, force: true }));
writeFileSync(join(sandbox, 'gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');

function project(name, files) {
  const root = join(sandbox, name);
  execFileSync('git', ['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function planWith(applier, modules, root, ...extra) {
  const run = spawnSync(
    process.execPath,
    [applier, '--target', root, '--modules', modules, '--json', ...extra],
    {
      encoding: 'utf8',
    },
  );
  assert.ok(run.status === 0 || run.status === 3, run.stderr);
  return { status: run.status, summary: JSON.parse(run.stdout) };
}

const plan = (root, ...extra) => planWith(APPLY, 'core,review', root, ...extra);

function devkitShipping(template) {
  const root = join(sandbox, 'devkit-copy');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'modules', 'hooks', 'templates'), { recursive: true });
  copyFileSync(APPLY, join(root, 'bin', 'apply.mjs'));
  const manifest = {
    name: 'hooks',
    phase: 'foundation',
    requires: [],
    detect: { always: true },
    conflicts: [],
    files: [
      {
        from: 'templates/settings.json',
        to: '.claude/settings.json',
        strategy: 'merge-json',
        ownedArrays: { 'hooks.PreToolUse': 'gate.mjs' },
      },
    ],
  };
  writeFileSync(join(root, 'modules', 'hooks', 'module.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(root, 'modules', 'hooks', 'templates', 'settings.json'), `${JSON.stringify(template)}\n`);
  return join(root, 'bin', 'apply.mjs');
}

test('an upgrade replaces the earlier gate hook entry and keeps the project own hooks', () => {
  const theirs = {
    matcher: 'Edit',
    hooks: [{ type: 'command', command: 'node lint-on-edit.mjs' }],
  };
  const earlier = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node .claude/hooks/require-review.mjs' }],
  };
  const root = project('upgrade', {
    '.claude/settings.json': `${JSON.stringify({ hooks: { PreToolUse: [earlier, theirs] } }, null, 2)}\n`,
  });
  const planned = plan(root, '--apply').summary.changes.find(
    (c) => c.path === '.claude/settings.json',
  );
  assert.match(planned.reason, /replaces 1 earlier devkit entry/);

  const hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks
    .PreToolUse;
  const gates = hooks.filter((entry) => JSON.stringify(entry).includes('require-review.mjs'));
  assert.equal(gates.length, 1);
  assert.equal(gates[0].matcher, 'Bash|PowerShell');
  assert.deepEqual(hooks[0], theirs);

  const again = plan(root).summary;
  assert.ok(again.unchanged.some((entry) => entry.path === '.claude/settings.json'));
});

test('a template that changes only the matcher still replaces the earlier devkit group', () => {
  const gate = { type: 'command', command: 'node .claude/hooks/gate.mjs' };
  const shipped = { matcher: 'Bash|PowerShell|Write', hooks: [gate] };
  const applier = devkitShipping({ hooks: { PreToolUse: [shipped] } });
  const root = project('matcher-only', {
    '.claude/settings.json': `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [gate] }] } }, null, 2)}\n`,
  });
  const planned = planWith(applier, 'hooks', root, '--apply').summary.changes.find(
    (c) => c.path === '.claude/settings.json',
  );
  assert.match(planned.reason, /replaces 1 earlier devkit entry/);
  const hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks
    .PreToolUse;
  assert.deepEqual(hooks, [shipped]);
  const again = planWith(applier, 'hooks', root).summary;
  assert.ok(again.unchanged.some((entry) => entry.path === '.claude/settings.json'));
});

test('an upgrade prunes a mixed matcher group instead of dropping the project hook inside it', () => {
  const gate = { type: 'command', command: 'node .claude/hooks/require-review.mjs' };
  const lint = { type: 'command', command: 'node .claude/hooks/lint.mjs' };
  const root = project('mixed', {
    '.claude/settings.json': `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [gate, lint] }] } }, null, 2)}\n`,
  });
  const planned = plan(root, '--apply').summary.changes.find(
    (c) => c.path === '.claude/settings.json',
  );
  assert.match(planned.reason, /replaces 1 earlier devkit entry\(ies\) in hooks\.PreToolUse/);
  assert.deepEqual(planned.detail.replaced, [{ path: 'hooks.PreToolUse', item: gate }]);

  const hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks
    .PreToolUse;
  assert.equal(hooks.length, 2);
  assert.deepEqual(hooks[0], { matcher: 'Bash', hooks: [lint] });
  assert.equal(hooks[1].matcher, 'Bash|PowerShell');

  const again = plan(root).summary;
  assert.ok(again.unchanged.some((entry) => entry.path === '.claude/settings.json'));
});
