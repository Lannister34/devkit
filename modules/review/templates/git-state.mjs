const STATE_NAME = 'devkit-review-state';

export function gitRepo({ exec, read, write }) {
  const git = (dir, args) =>
    exec('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  const statePath = (dir) =>
    git(dir, ['rev-parse', '--path-format=absolute', '--git-path', STATE_NAME]);
  const approved = (state) => {
    try {
      return read(state, 'utf8').trim();
    } catch {
      return '';
    }
  };
  return {
    worktrees(projectDir) {
      return git(projectDir, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
    },
    trees(dir) {
      const staged = git(dir, ['write-tree']);
      return staged ? { staged, approved: approved(statePath(dir)) } : null;
    },
    approve(dir, reviewed) {
      const staged = git(dir, ['write-tree']);
      if (reviewed !== undefined && staged !== reviewed) {
        throw new Error(
          `the staged tree is now ${staged}, but the review approved ${reviewed} — ` +
            'review the current tree before recording approval.',
        );
      }
      write(statePath(dir), `${staged}\n`, 'utf8');
      return staged;
    },
  };
}
