#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRepo } from './review-gate.mjs';

const worktree = resolve(process.argv[2] ?? '.');
try {
  const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
  process.stdout.write(`Approved ${repo.approve(worktree)} for ${worktree}\n`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Approval not recorded for ${worktree}: ${reason}\n`);
  process.exitCode = 1;
}
