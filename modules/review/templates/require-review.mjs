#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findCommits, gitRepo, judge, toolCommand } from './review-gate.mjs';

let reasons = [];
try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const host = { cwd: process.cwd(), platform: process.platform, home: homedir() };
  const call = toolCommand(payload, host);
  if (call !== null) {
    const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });
    const approveScript = fileURLToPath(new URL('./approve-review.mjs', import.meta.url));
    reasons = judge(findCommits(call.command, call.context), repo, approveScript);
  }
} catch {
  reasons = [];
}
if (reasons.length > 0) {
  process.stderr.write(`${reasons.join('\n\n')}\n`);
  process.exitCode = 2;
}
