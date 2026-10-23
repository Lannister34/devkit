#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRepo } from './git-state.mjs';
import { isUncOrDevice } from './path-resolver.mjs';

const worktree = resolve(process.argv[2] ?? '.');
const reviewed = process.argv[3];
try {
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
  process.stdout.write(`Approved ${repo.approve(worktree, reviewed)} for ${worktree}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Approval not recorded for ${worktree}: ${message}\n`);
  process.exitCode = 1;
}
