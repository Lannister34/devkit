import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compare, lowered } from '../packages/checks/comment-baseline.mjs';
import { disallowedComments } from '../packages/checks/comment-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages', 'checks', 'comments.mjs');
const bodies = (fileName, text) => disallowedComments(fileName, text).map((c) => c.body);

test('look-alikes inside code are not comments', () => {
  const text = [
    'const pattern = /\\/\\*x/;',
    'const set = /[/*]/;',
    'const url = `https://host/$' + '{path} // not a comment`;',
    'const view = <p>// text, not a comment</p>;',
    "const quoted = '/* nor this */';",
  ].join('\n');
  assert.deepEqual(bodies('view.tsx', text), []);
});

test('every real comment form is found, with its line', () => {
  const text = [
    'const view = <p>{/* in jsx */}</p>; // trailing',
    '/* block */',
    'function empty() {',
    '  // alone in a body',
    '}',
    '/** doc */',
    'export const x = 1;',
    '// at the end',
    '/** a docblock after the last token */',
  ].join('\n');
  assert.deepEqual(disallowedComments('view.tsx', text), [
    { line: 1, body: '/* in jsx */' },
    { line: 1, body: '// trailing' },
    { line: 2, body: '/* block */' },
    { line: 4, body: '// alone in a body' },
    { line: 6, body: '/** doc */' },
    { line: 8, body: '// at the end' },
    { line: 9, body: '/** a docblock after the last token */' },
  ]);
});

test('a TODO line and tool directives are allowed; their look-alikes are not', () => {
  const text = [
    '#!/usr/bin/env node',
    '// TODO: split the parser from the loader',
    '// @ts-expect-error the fixture is deliberately malformed',
    '// @ts-expect-error: the fixture is deliberately malformed',
    '// biome-ignore lint/style/noNonNullAssertion: checked above',
    '/* biome-ignore lint/style/noNonNullAssertion: checked above */',
    '// eslint-disable-next-line no-console',
    '/// <reference types="vite/client" />',
    '/** @jsxImportSource preact */',
    '/** @vitest-environment jsdom */',
    'const lazy = /* @__PURE__ */ make();',
    '// TODO:',
    '// @ts-expect-error',
    '// @ts-expect-errorless reason',
    '// @ts-ignore',
    '// @ts-nocheck',
    '// eslint-disabled',
    '/* eslint-disable',
    ' a paragraph riding behind the directive */',
    '/* biome-ignore',
    ' lint: a paragraph riding behind the directive */',
    '/* @ts-expect-error',
    ' a paragraph riding behind the directive */',
    '/** @jsx */',
    '/* TODO: not a line comment */',
  ].join('\n');
  assert.deepEqual(bodies('tool.ts', text), [
    '// TODO:',
    '// @ts-expect-error',
    '// @ts-expect-errorless reason',
    '// @ts-ignore',
    '// @ts-nocheck',
    '// eslint-disabled',
    '/* eslint-disable\n a paragraph riding behind the directive */',
    '/* biome-ignore\n lint: a paragraph riding behind the directive */',
    '/* @ts-expect-error\n a paragraph riding behind the directive */',
    '/** @jsx */',
    '/* TODO: not a line comment */',
  ]);
});

test('a JSDoc type annotation is a directive in JavaScript only', () => {
  const text = "/** @type {import('vite').UserConfig} */\nexport default {};";
  assert.deepEqual(bodies('vite.config.mjs', text), []);
  assert.equal(bodies('vite.config.ts', text).length, 1);
});

test('stylesheets: comments are found outside strings, and a one-line TODO is allowed', () => {
  const text = [
    '/* ===== banner ===== */',
    '.a::before { content: "/* not a comment */"; }',
    '.b { background: url(data:image/svg+xml,%3Csvg%3E/*not a comment*/%3C/svg%3E); }',
    '.b2 { background: url(    spaced/*not a comment*/.png); }',
    ".content-\\[\\'\\*\\'\\] { color: red; }",
    '/* after an escaped quote */',
    '.c { content: "unterminated; }',
    '/* after a bad string */',
    '/* stylelint-disable */',
    '/* biome-ignore lint/suspicious/noDuplicateSelectors: merged on purpose */',
    '/* biome-ignored prose */',
    '/* TODO: split tokens out of this file */',
  ].join('\n');
  assert.deepEqual(disallowedComments('styles.css', text), [
    { line: 1, body: '/* ===== banner ===== */' },
    { line: 6, body: '/* after an escaped quote */' },
    { line: 8, body: '/* after a bad string */' },
    { line: 11, body: '/* biome-ignored prose */' },
  ]);
});

test('the baseline fails a file above its count and a file below it', () => {
  const found = [
    ['grew.ts', [{}, {}]],
    ['shrank.ts', [{}]],
    ['held.ts', [{}]],
  ];
  const baseline = { 'grew.ts': 1, 'shrank.ts': 2, 'held.ts': 1, 'deleted.ts': 3 };
  const partial = compare(found, baseline, { complete: false });
  assert.deepEqual(
    partial.over.map((entry) => entry.file),
    ['grew.ts'],
  );
  assert.deepEqual(
    partial.stale.map((entry) => entry.file),
    ['shrank.ts'],
  );
  const whole = compare(found, baseline, { complete: true });
  assert.deepEqual(
    whole.stale.map((entry) => entry.file),
    ['shrank.ts', 'deleted.ts'],
  );
});

test('updating the baseline records it once, then only ever lowers it', () => {
  const found = [
    ['a.ts', [{}, {}, {}]],
    ['b.ts', [{}]],
    ['clean.ts', []],
  ];
  assert.deepEqual(lowered(found, null), { 'a.ts': 3, 'b.ts': 1 });
  assert.deepEqual(lowered(found, { 'a.ts': 1, 'b.ts': 4, 'gone.ts': 2 }), {
    'a.ts': 1,
    'b.ts': 1,
  });
});

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-comments-')));
after(() => rmSync(sandbox, { recursive: true, force: true }));
writeFileSync(join(sandbox, 'gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
process.env.XDG_CONFIG_HOME = sandbox;
process.env.GIT_CEILING_DIRECTORIES = dirname(sandbox);

const repo = join(sandbox, 'repo');
const baselineFile = join(repo, '.devkit', 'comments-baseline.json');
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const baseline = () => JSON.parse(readFileSync(baselineFile, 'utf8'));

test('the command gates tracked files against the baseline it records', () => {
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'legacy.ts'), '// legacy\nexport const a = 1;\n');
  execFileSync('git', ['-C', repo, 'add', 'legacy.ts']);

  assert.equal(run(repo).status, 1);
  assert.equal(run(repo, '--update-baseline').status, 0);
  assert.equal(run(repo).status, 0);

  writeFileSync(join(repo, 'legacy.ts'), '// legacy\n// new\nexport const a = 1;\n');
  const grown = run(repo, 'legacy.ts');
  assert.equal(grown.status, 1);
  assert.match(grown.stderr, /legacy\.ts:2 {2}\/\/ new/);

  writeFileSync(join(repo, 'legacy.ts'), 'export const a = 1;\n');
  assert.equal(run(repo).status, 1);
  assert.equal(run(repo, '--update-baseline').status, 0);
  assert.deepEqual(baseline(), {});
});

test('files are keyed by their path from the repository root, whatever the caller passes', () => {
  const pkg = join(repo, 'pkg');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'deep.ts'), '// deep\nexport const d = 1;\n');
  execFileSync('git', ['-C', repo, 'add', 'pkg/src/deep.ts']);

  const fromPackage = run(pkg, 'src/deep.ts');
  assert.equal(fromPackage.status, 1);
  assert.match(fromPackage.stderr, /^pkg\/src\/deep\.ts: 1 comment/m);
  assert.equal(run(pkg, '--update-baseline').status, 0);
  assert.deepEqual(baseline(), {});
  rmSync(baselineFile);
  assert.equal(run(pkg, '--update-baseline').status, 0);
  assert.deepEqual(baseline(), { 'pkg/src/deep.ts': 1 });
  assert.equal(run(pkg, 'src/deep.ts').status, 0);
  assert.equal(run(pkg, './src/deep.ts').status, 0);
  assert.equal(run(pkg, join(pkg, 'src', 'deep.ts')).status, 0);
  assert.equal(run(repo, 'pkg\\src\\deep.ts').status, 0);
  assert.equal(run(repo, '--', 'pkg/src/deep.ts').status, 0);
  assert.equal(run(pkg).status, 0);
});

test('the command refuses what it cannot gate, loudly', () => {
  const unknown = run(repo, '--update-baselin');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option --update-baselin/);
  assert.equal(run(repo, '-h').status, 2);

  writeFileSync(join(repo, 'untracked.ts'), '// untracked\n');
  const untracked = run(repo, 'untracked.ts');
  assert.equal(untracked.status, 2);
  assert.match(untracked.stderr, /none of the named paths is a tracked file/);
  writeFileSync(join(sandbox, 'outside.ts'), '// outside\n');
  const outside = run(repo, join(sandbox, 'outside.ts'));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /git failed/);

  writeFileSync(baselineFile, '{ not json');
  const corrupt = run(repo);
  assert.equal(corrupt.status, 2);
  assert.match(corrupt.stderr, /comments-baseline\.json is not valid JSON/);
  assert.equal(run(repo, '--update-baseline').status, 2);

  writeFileSync(baselineFile, '{ "pkg/src/deep.ts": "one" }\n');
  const malformed = run(repo);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /must map file paths to whole comment counts/);
  writeFileSync(baselineFile, '{ "pkg/src/deep.ts": 1 }\n');

  const nowhere = run(sandbox);
  assert.equal(nowhere.status, 2);
  assert.match(nowhere.stderr, /git failed/);
});

test('the scripts devkit installs or ships carry no comment the gate would reject', () => {
  const shipped = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'modules', 'packages/checks'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /^modules\/.+\/templates\/.+\.(mjs|js|ts|css)$/.test(path) || /^packages\/checks\/.+\.mjs$/.test(path));
  assert.ok(shipped.length >= 6);
  for (const path of shipped) {
    assert.deepEqual(disallowedComments(path, readFileSync(join(ROOT, path), 'utf8')), [], path);
  }
});
