import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_PIN = /^github:Lannister34\/devkit#v(\d+)\.(\d+)\.(\d+)&path:/;

const version = (text) => text.split('.').map(Number);
const notAfter = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test('modules pin devkit packages only to releases that already exist', () => {
  const release = version(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  const pins = readdirSync(join(ROOT, 'modules')).flatMap((name) => {
    const module = JSON.parse(readFileSync(join(ROOT, 'modules', name, 'module.json'), 'utf8'));
    return Object.entries(module.dependencies?.devDependencies ?? {}).map(([pkg, spec]) => ({ name, pkg, spec }));
  });
  const own = pins.filter(({ spec }) => SELF_PIN.test(spec));
  assert.ok(own.length > 0, 'no module pins a devkit package');
  for (const { name, pkg, spec } of own) {
    const pinned = SELF_PIN.exec(spec).slice(1).map(Number);
    assert.ok(notAfter(pinned, release) <= 0, `${name}: ${pkg} pins ${spec}, newer than this release ${release.join('.')}`);
  }
});
