import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeApproval, encodeApproval } from '../modules/review/templates/approval-record.mjs';
import { diffEntries } from '../modules/review/templates/diff-entries.mjs';
import { globMatcher } from '../modules/review/templates/path-glob.mjs';
import { decodeConfig } from '../modules/review/templates/review-config.mjs';
import { exemption } from '../modules/review/templates/review-exemptions.mjs';

const TEMPLATE = new URL('../modules/review/templates/review.json', import.meta.url);
const config = { ...decodeConfig(readFileSync(TEMPLATE, 'utf8')), maxLines: 40 };
const TREE = 'a'.repeat(40);

const modified = (path, lines) => ({ path, status: 'M', oldMode: '100644', newMode: '100644', lines });
const added = (path, lines = 1) => ({ path, status: 'A', oldMode: '000000', newMode: '100644', lines });
const deleted = (path, lines = 1) => ({ path, status: 'D', oldMode: '100644', newMode: '000000', lines });
const approvalOf = (...files) => ({ tree: TREE, files, blocking: false });

const afterApproval = (sinceApproval, approval = approvalOf('src/app.ts', 'lib/util.py')) =>
  exemption({ config, approval, sinceHead: sinceApproval, sinceApproval });
const docsCommit = (...sinceHead) =>
  exemption({ config, approval: null, sinceHead, sinceApproval: null });

test('a basename glob matches at any depth, a path glob from the root, and both ignore case', () => {
  const match = globMatcher(['*.md', 'docs/**', '**/src/**', 'requirements*.txt']);
  assert.ok(match('README.md'));
  assert.ok(match('a/b/NOTES.MD'));
  assert.ok(match('docs/x/y.png'));
  assert.ok(match('src/a.ts'));
  assert.ok(match('apps/web/src/a.ts'));
  assert.ok(match('requirements-dev.txt'));
  assert.equal(match('readme.mdx'), false);
  assert.equal(match('mydocs/x'), false);
  assert.equal(match('srcs/a.ts'), false);
});

test('glob metacharacters other than * and ? are literal', () => {
  const match = globMatcher(['a.(b)+.md']);
  assert.ok(match('a.(b)+.md'));
  assert.equal(match('aX(b)+.md'), false);
});

test('diff entries join raw status and modes with numstat lines, keeping odd paths whole', () => {
  const output = [
    ':100644 100644 422c2b7 6372083 M',
    'a.txt',
    ':000000 100644 0000000 bdc955b A',
    'bin.dat',
    ':100644 100755 587be6b 587be6b M',
    'tab\there.sh',
    '2\t1\ta.txt',
    '-\t-\tbin.dat',
    '0\t0\ttab\there.sh',
    '',
  ].join('\0');
  assert.deepEqual(diffEntries(output), [
    { path: 'a.txt', status: 'M', oldMode: '100644', newMode: '100644', lines: 3 },
    { path: 'bin.dat', status: 'A', oldMode: '000000', newMode: '100644', lines: null },
    { path: 'tab\there.sh', status: 'M', oldMode: '100644', newMode: '100755', lines: 0 },
  ]);
  assert.deepEqual(diffEntries(''), []);
});

test('an approval record round-trips, reads the bare tree an older release wrote, and rejects anything else', () => {
  assert.deepEqual(decodeApproval(encodeApproval(TREE, ['a', 'b c'], true)), {
    tree: TREE,
    files: ['a', 'b c'],
    blocking: true,
  });
  assert.deepEqual(decodeApproval(`${TREE}\n`), { tree: TREE, files: [], blocking: false });
  assert.equal(decodeApproval(''), null);
  assert.equal(decodeApproval('not a tree'), null);
  assert.equal(decodeApproval('{"tree":"abc","files":[],"blocking":false}'), null);
  assert.equal(decodeApproval(`{"tree":"${TREE}","files":[]}`), null);
  assert.equal(decodeApproval(`{"tree":"${TREE}","files":[1],"blocking":false}`), null);
  assert.equal(decodeApproval(`{"tree":"${TREE}","files":[],"blocking":"no"}`), null);
});

test('the review config is absent, valid, or rejected outright, never half-read', () => {
  assert.equal(decodeConfig(null), null);
  assert.throws(() => decodeConfig('{nope'), SyntaxError);
  const valid = { smallFix: { maxLines: 40 }, docs: { include: ['*.md'], exclude: [] }, alwaysReview: [] };
  assert.equal(decodeConfig(JSON.stringify(valid)).maxLines, 40);
  for (const broken of [
    { ...valid, smallFix: { maxLines: -1 } },
    { ...valid, smallFix: { maxLines: '40' } },
    { ...valid, smallFix: {} },
    { ...valid, docs: { include: ['*.md'] } },
    { ...valid, docs: { include: [''], exclude: [] } },
    { ...valid, alwaysReview: 'package.json' },
  ]) {
    assert.throws(() => decodeConfig(JSON.stringify(broken)), /review\.json/);
  }
});

test('the shipped config treats docs outside code directories as docs, and dependency files as always reviewed', () => {
  assert.ok(config.isDoc('README.md'));
  assert.ok(config.isDoc('docs/adr/0001-x.md'));
  assert.ok(config.isDoc('.gitignore'));
  assert.equal(config.isDoc('src/prompts/agent.md'), false);
  assert.equal(config.isDoc('packages/core/src/prompt.md'), false);
  assert.equal(config.isDoc('app.ts'), false);
  assert.equal(config.isDoc('config.json'), false);
  for (const path of ['package.json', 'web/package-lock.json', 'pyproject.toml', 'requirements.txt', 'uv.lock']) {
    assert.ok(config.alwaysReview(path), path);
  }
});

test('a commit that touches only docs passes without any approval', () => {
  assert.deepEqual(docsCommit(modified('README.md', 300), added('docs/guide.md'), deleted('NOTES.txt')), {
    exempt: true,
    reason: 'a docs-only commit',
  });
});

test('a docs commit stops being docs-only on a code file, a code directory, the rules, the gate, or a dependency list', () => {
  for (const entry of [
    modified('app.ts', 1),
    modified('src/prompts/agent.md', 1),
    modified('CLAUDE.md', 1),
    modified('packages/x/CLAUDE.md', 1),
    modified('.claude/agents/code-review.md', 1),
    modified('.claude/skills/x/SKILL.md', 1),
    modified('requirements.txt', 1),
  ]) {
    assert.equal(docsCommit(modified('README.md', 1), entry).exempt, false, entry.path);
  }
});

test('a doc that becomes a symlink or a submodule is not a doc change', () => {
  const symlink = { path: 'README.md', status: 'T', oldMode: '100644', newMode: '120000', lines: 1 };
  const submodule = { path: 'notes.md', status: 'A', oldMode: '000000', newMode: '160000', lines: null };
  assert.equal(docsCommit(symlink).exempt, false);
  assert.equal(docsCommit(submodule).exempt, false);
});

test('a commit with nothing staged beyond HEAD is not docs-only', () => {
  assert.equal(docsCommit().exempt, false);
});

test('a fix within the limit to reviewed files passes, and one line over it is refused', () => {
  const atLimit = afterApproval([modified('src/app.ts', 30), modified('lib/util.py', 10)]);
  assert.deepEqual(atLimit, { exempt: true, reason: 'a small fix over the approved tree: 40 of 40 lines' });
  const over = afterApproval([modified('src/app.ts', 30), modified('lib/util.py', 11)]);
  assert.equal(over.exempt, false);
  assert.match(over.reason, /41 changed lines, over the limit of 40/);
});

test('docs changed beside a small fix neither count toward the limit nor need to have been reviewed', () => {
  const verdict = afterApproval([modified('src/app.ts', 10), modified('README.md', 500), added('docs/new.md')]);
  assert.deepEqual(verdict, { exempt: true, reason: 'a small fix over the approved tree: 10 of 40 lines' });
});

test('a small fix may not add, delete, retype or re-mode a file, touch one it was not approved for, or change a binary', () => {
  const cases = [
    [added('src/new.ts'), /added, deleted, or changed in type/],
    [deleted('src/app.ts'), /added, deleted, or changed in type/],
    [{ path: 'src/app.ts', status: 'T', oldMode: '100644', newMode: '120000', lines: 1 }, /changed in type/],
    [{ path: 'src/app.ts', status: 'M', oldMode: '100644', newMode: '100755', lines: 0 }, /file mode/],
    [modified('src/other.ts', 1), /was not in the reviewed diff/],
    [modified('src/app.ts', null), /is binary/],
  ];
  for (const [entry, reason] of cases) {
    const verdict = afterApproval([entry]);
    assert.equal(verdict.exempt, false, entry.path);
    assert.match(verdict.reason, reason);
  }
});

test('a dependency file, the rules or the gate need a review however small the change', () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pyproject.toml', 'CLAUDE.md', '.claude/hooks/review-gate.mjs']) {
    const verdict = afterApproval([modified(path, 1)], approvalOf(path));
    assert.equal(verdict.exempt, false, path);
    assert.match(verdict.reason, /always needs a review/);
  }
});

test('an approval from an older release names no files, so nothing passes as a small fix over it', () => {
  const verdict = afterApproval([modified('src/app.ts', 1)], approvalOf());
  assert.equal(verdict.exempt, false);
  assert.match(verdict.reason, /was not in the reviewed diff/);
});

test('with no approval recorded, only a docs-only commit passes', () => {
  const verdict = exemption({ config, approval: null, sinceHead: [modified('src/app.ts', 1)], sinceApproval: null });
  assert.equal(verdict.exempt, false);
  assert.match(verdict.reason, /no approval is recorded/);
});

test('over a review that found defects, no fix passes however small, and a docs-only commit still does', () => {
  const defects = { ...approvalOf('src/app.ts'), blocking: true };
  for (const sinceApproval of [[modified('src/app.ts', 1)], [], [modified('README.md', 3)]]) {
    const verdict = exemption({
      config,
      approval: defects,
      sinceHead: [modified('src/app.ts', 8), ...sinceApproval],
      sinceApproval,
    });
    assert.equal(verdict.exempt, false);
    assert.match(verdict.reason, /found defects, so their fixes pass only once a second round approves/);
  }
  assert.equal(afterApproval([modified('README.md', 3)], defects).reason, 'a docs-only commit');
});

test('a limit of zero leaves only docs passing beside an approval', () => {
  const strict = { ...config, maxLines: 0 };
  const verdict = exemption({
    config: strict,
    approval: approvalOf('src/app.ts'),
    sinceHead: [modified('src/app.ts', 1)],
    sinceApproval: [modified('src/app.ts', 1)],
  });
  assert.equal(verdict.exempt, false);
});
