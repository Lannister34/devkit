#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findCommits } from './commit-reader.mjs';
import { gitRepo } from './git-state.mjs';
import { toolCommand } from './hook-payload.mjs';
import { judge } from './review-gate.mjs';

const reason = (error) => (error instanceof Error ? error.message : String(error));

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const host = { cwd: process.cwd(), platform: process.platform, home: homedir() };
  const call = toolCommand(payload, host);
  const commits = call === null ? [] : findCommits(call.command, call.context);
  if (commits.length > 0) {
    const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
    const approveScript = fileURLToPath(new URL('./approve-review.mjs', import.meta.url));
    const projectDir =
      process.env.CLAUDE_PROJECT_DIR || (typeof payload.cwd === 'string' && payload.cwd) || host.cwd;
    let worktrees = [];
    try {
      worktrees = repo.worktrees(projectDir);
    } catch (error) {
      process.stderr.write(
        `require-review: could not list the project's worktrees, gate left open: ${reason(error)}\n`,
      );
    }
    const { blocks, notes } = judge(commits, repo, {
      approveScript,
      worktrees,
      platform: host.platform,
    });
    for (const note of notes) process.stderr.write(`require-review: ${note}\n`);
    if (blocks.length > 0) {
      process.stderr.write(`${blocks.join('\n\n')}\n`);
      process.exitCode = 2;
    }
  }
} catch (error) {
  process.stderr.write(`require-review: gate failed open: ${reason(error)}\n`);
}
