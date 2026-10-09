#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findCommits, gitRepo, judge, SHELL_BY_TOOL } from './review-gate.mjs';

let reasons = [];
try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const shell = SHELL_BY_TOOL.get(payload?.tool_name);
  const command = payload?.tool_input?.command;
  if (shell !== undefined && typeof command === 'string') {
    const context = {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      shell,
      platform: process.platform,
      home: homedir(),
    };
    const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
    const approveScript = fileURLToPath(new URL('./approve-review.mjs', import.meta.url));
    reasons = judge(findCommits(command, context), repo, approveScript);
  }
} catch {
  reasons = [];
}
if (reasons.length > 0) {
  process.stderr.write(`${reasons.join('\n\n')}\n`);
  process.exitCode = 2;
}
