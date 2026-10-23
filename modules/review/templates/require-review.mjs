#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommits } from './commit-reader.mjs';
import { gitRepo } from './git-state.mjs';
import { toolCommand } from './hook-payload.mjs';
import { isUncOrDevice } from './path-resolver.mjs';
import { judge } from './review-gate.mjs';
import { resolveProjectWorktree } from './worktree-scope.mjs';

const reason = (error) => (error instanceof Error ? error.message : String(error));

function projectRoot(payload, host) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const cwd = typeof payload.cwd === 'string' && payload.cwd;
  if (cwd && !isUncOrDevice(resolve(cwd), host.platform)) return cwd;
  return host.cwd;
}

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const host = { cwd: process.cwd(), platform: process.platform, home: homedir() };
  const call = toolCommand(payload, host);
  const commits = call === null ? [] : findCommits(call.command, call.context);
  if (commits.length > 0) {
    const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
    const approveScript = fileURLToPath(new URL('./approve-review.mjs', import.meta.url));
    let worktrees = [];
    try {
      worktrees = repo.worktrees(projectRoot(payload, host));
    } catch (error) {
      process.stderr.write(
        `require-review: could not list the project's worktrees, gate left open: ${reason(error)}\n`,
      );
    }
    const scope = (dir) =>
      resolveProjectWorktree(dir, worktrees, host.platform, { lstat: lstatSync });
    const { blocks, notes } = judge(commits, repo, { approveScript, scope });
    for (const note of notes) process.stderr.write(`require-review: ${note}\n`);
    if (blocks.length > 0) {
      process.stderr.write(`${blocks.join('\n\n')}\n`);
      process.exitCode = 2;
    }
  }
} catch (error) {
  process.stderr.write(`require-review: gate failed open: ${reason(error)}\n`);
}
