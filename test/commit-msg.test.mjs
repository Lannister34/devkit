import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MODULE = new URL('../modules/git/', import.meta.url);
const { vars } = JSON.parse(readFileSync(new URL('module.json', MODULE), 'utf8'));
const hook = readFileSync(new URL('templates/lefthook.yml', MODULE), 'utf8');
const patterns = [...hook.matchAll(/-e '([^']*)'/g)].map(
  ([, pattern]) => new RegExp(pattern.replace('{{commitPattern}}', () => vars.commitPattern)),
);
const passes = (subject) => patterns.some((pattern) => pattern.test(subject));

test('the commit-msg hook takes the subjects git writes for merges and reverts', () => {
  for (const subject of [
    "Merge branch 'side'",
    "Merge branch 'main' of github.com:org/repo",
    "Merge remote-tracking branch 'origin/main'",
    'Revert "feat(api): drop the cache"',
    'Reapply "feat(api): drop the cache"',
  ]) {
    assert.ok(passes(subject), subject);
  }
});

test('the commit-msg hook holds a revert written by hand, and other subjects, to the convention', () => {
  assert.ok(passes('feat(api)!: drop the cache'));
  for (const subject of [
    'wip',
    'Merged the parsers',
    'Revert the cache',
    'Reverted the cache',
    'fixup! feat: x',
  ]) {
    assert.equal(passes(subject), false, subject);
  }
});
