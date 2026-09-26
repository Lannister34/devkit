#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compare, lowered } from './comment-baseline.mjs';
import { disallowedComments, GATED_FILE } from './comment-scan.mjs';

const BASELINE = '.devkit/comments-baseline.json';
const USAGE = 'devkit-comments [--update-baseline] [--] [files...]';
const RECOVERY = 'fix it, or delete it and run devkit-comments --update-baseline';

class UsageError extends Error {}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = (typeof error?.stderr === 'string' && error.stderr.trim()) || String(error?.message ?? error);
    throw new UsageError(`devkit-comments gates the tracked files of a git repository, and git failed: ${detail}`);
  }
}

const repositoryRoot = () => git(['rev-parse', '--show-toplevel']).trim();
const trackedFiles = (root) => git(['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean);

function namedFiles(files) {
  if (files.length === 0) return [];
  const keys = git(['ls-files', '-z', '--full-name', '--', ...files]).split('\0').filter(Boolean);
  if (keys.length === 0) throw new UsageError('none of the named paths is a tracked file of this repository');
  return [...new Set(keys)];
}

function parseArguments(argv) {
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  const files = end === -1 ? [] : argv.slice(end + 1);
  let update = false;
  for (const arg of options) {
    if (arg === '--update-baseline') update = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}; usage: ${USAGE}`);
    else files.push(arg);
  }
  return { update, files };
}

function readBaseline(root) {
  const path = join(root, BASELINE);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`${BASELINE} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ${RECOVERY}`);
  }
  const counts = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.values(parsed) : null;
  if (counts === null || !counts.every((count) => Number.isInteger(count) && count >= 0)) {
    throw new UsageError(`${BASELINE} must map file paths to whole comment counts; ${RECOVERY}`);
  }
  return parsed;
}

function report(over, stale) {
  for (const { file, comments, allowed } of over) {
    process.stderr.write(`${file}: ${comments.length} comment(s) where ${BASELINE} allows ${allowed}\n`);
    for (const { line, body } of comments) {
      process.stderr.write(`  ${file}:${line}  ${body.split('\n')[0]}\n`);
    }
  }
  for (const { file, count, allowed } of stale) {
    process.stderr.write(
      `${file}: ${count} comment(s) left where ${BASELINE} still allows ${allowed}; ` +
        'run devkit-comments --update-baseline\n',
    );
  }
}

function main(argv) {
  const { update, files: named } = parseArguments(argv);
  const root = repositoryRoot();
  const baseline = readBaseline(root);
  const complete = update || named.length === 0;
  const candidates = complete ? trackedFiles(root) : namedFiles(named);
  const files = candidates.filter((file) => GATED_FILE.test(file) && existsSync(join(root, file)));
  const found = files.map((file) => [file, disallowedComments(file, readFileSync(join(root, file), 'utf8'))]);
  if (update) {
    const path = join(root, BASELINE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(lowered(found, baseline), null, 2)}\n`);
    return 0;
  }
  const { over, stale } = compare(found, baseline ?? {}, { complete });
  report(over, stale);
  return over.length + stale.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
