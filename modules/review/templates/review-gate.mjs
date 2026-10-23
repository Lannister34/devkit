const unresolvedRefusal = (commit) =>
  `Cannot tell which worktree this commit targets (${commit.unresolved}). ` +
  'Retry it as `git -C <literal path> commit`.';

const stagesRefusal = (commit) =>
  `This commit stages files itself (${commit.stages}), so it would write a tree nobody ` +
  'reviewed. Stage with `git add`, review, then commit without it.';

const skipsHooksRefusal = () =>
  'This commit skips the git hooks, which run the gates the review approval assumes. ' +
  'Fix what the hooks report instead.';

function unreviewedRefusal(worktree, trees, approveScript) {
  return (
    "This commit's staged tree has not been reviewed.\n\n" +
    `  worktree:  ${worktree}\n` +
    `  tree:      ${trees.staged}\n` +
    `  approved:  ${trees.approved || '(none)'}\n\n` +
    'Run the code-review agent on that worktree, fix every blocking finding, then let it record ' +
    'approval of this exact tree — the worktree path and tree id are the ones above:\n\n' +
    `  node "${approveScript}" "<worktree>" ${trees.staged}\n\n` +
    'Then retry the commit.'
  );
}

const failedOpen = (worktree, reason) =>
  `could not check the staged tree in ${worktree}, so the commit was let through: ${reason}`;

export function judge(commits, repo, { approveScript, scope }) {
  const blocks = [];
  const notes = [];
  for (const commit of commits) {
    if (commit.unresolved) {
      blocks.push(unresolvedRefusal(commit));
      continue;
    }
    const worktree = scope(commit.dir);
    if (worktree === null) continue;
    if (commit.stages) {
      blocks.push(stagesRefusal(commit));
      continue;
    }
    if (commit.skipsHooks) {
      blocks.push(skipsHooksRefusal());
      continue;
    }
    let trees;
    try {
      trees = repo.trees(worktree);
    } catch (error) {
      notes.push(failedOpen(worktree, error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (trees === null) {
      notes.push(failedOpen(worktree, 'git reported no staged tree'));
      continue;
    }
    if (trees.staged === trees.approved) continue;
    blocks.push(unreviewedRefusal(worktree, trees, approveScript));
  }
  return { blocks, notes };
}
