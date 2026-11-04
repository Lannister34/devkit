#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRepo } from './git-state.mjs';
import { isUncOrDevice } from './path-resolver.mjs';

const worktree = resolve(process.argv[2] ?? '.');
const reviewed = process.argv[3];
const REPO_PATH = /^(?![/\\]|[A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/;

function options(args) {
  const named = [];
  let blocking = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--blocking') {
      blocking = true;
    } else if (args[i] === '--file' && REPO_PATH.test(args[i + 1] ?? '')) {
      named.push(args[i + 1].replaceAll('\\', '/'));
      i += 1;
    } else if (args[i] === '--file') {
      throw new Error('--file takes a path relative to the repository root, inside it');
    } else {
      throw new Error(`unknown option ${args[i]}`);
    }
  }
  return { blocking, named };
}

try {
  const { blocking, named } = options(process.argv.slice(4));
  if (isUncOrDevice(worktree, process.platform)) {
    throw new Error('refusing to run git against a UNC or device path');
  }
  if (!reviewed) {
    throw new Error(
      'pass the tree id you reviewed: approve-review.mjs <worktree> <tree> ' +
        '(get it with `git -C <worktree> write-tree`)',
    );
  }
  const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
  const tree = repo.approve(worktree, reviewed, { blocking, named });
  process.stdout.write(
    blocking
      ? `Recorded ${tree} for ${worktree} with defects: ` +
          'no code change over it passes until a second round approves\n'
      : `Approved ${tree} for ${worktree}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Approval not recorded for ${worktree}: ${message}\n`);
  process.exitCode = 1;
}
