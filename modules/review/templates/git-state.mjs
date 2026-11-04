import { devNull } from 'node:os';
import { decodeApproval, encodeApproval } from './approval-record.mjs';
import { diffEntries } from './diff-entries.mjs';
import { CONFIG_PATH } from './review-config.mjs';

const STATE_NAME = 'devkit-review-state';

export function gitRepo({ exec, read, write }) {
  const run = (dir, args) =>
    exec(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-C', dir, ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  const git = (dir, args) => run(dir, args).trim();
  const statePath = (dir) =>
    git(dir, ['rev-parse', '--path-format=absolute', '--git-path', STATE_NAME]);
  const approval = (state) => {
    try {
      return decodeApproval(read(state, 'utf8'));
    } catch {
      return null;
    }
  };
  const stagedFiles = (dir) =>
    run(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
      .split('\0')
      .filter((path) => path !== '');
  return {
    worktrees(projectDir) {
      return git(projectDir, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
    },
    trees(dir) {
      const staged = git(dir, ['write-tree']);
      return staged ? { staged, approval: approval(statePath(dir)) } : null;
    },
    changes(dir, base) {
      const against = base === undefined ? [] : [base];
      return diffEntries(
        run(dir, ['diff', '--cached', '--raw', '--numstat', '-z', '--no-renames', ...against]),
      );
    },
    config(dir) {
      try {
        return run(dir, ['cat-file', 'blob', `HEAD:${CONFIG_PATH}`]);
      } catch {
        return null;
      }
    },
    approve(dir, reviewed, { blocking = false } = {}) {
      const staged = git(dir, ['write-tree']);
      if (reviewed !== undefined && staged !== reviewed) {
        throw new Error(
          `the staged tree is now ${staged}, but the review approved ${reviewed} — ` +
            'review the current tree before recording approval.',
        );
      }
      write(statePath(dir), encodeApproval(staged, stagedFiles(dir), blocking), 'utf8');
      return staged;
    },
  };
}
