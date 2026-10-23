import path from 'node:path';

function pathsFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalize(dir, platform) {
  const resolved = pathsFor(platform).resolve(dir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function withinRoots(dir, roots, platform) {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  const sep = pathsFor(platform).sep;
  const candidate = normalize(dir, platform);
  return roots.some((root) => candidate === root || candidate.startsWith(root + sep));
}

const unresolvedRefusal = (commit) =>
  `Cannot tell which worktree this commit targets (${commit.unresolved}). ` +
  'Retry it as `git -C <literal path> commit`.';

const stagesRefusal = (commit) =>
  `This commit stages files itself (${commit.stages}), so it would write a tree nobody ` +
  'reviewed. Stage with `git add`, review, then commit without it.';

const skipsHooksRefusal = () =>
  'This commit skips the git hooks, which run the gates the review approval assumes. ' +
  'Fix what the hooks report instead.';

function unreviewedRefusal(commit, trees, approveScript) {
  return (
    "This commit's staged tree has not been reviewed.\n\n" +
    `  worktree:  ${commit.dir}\n` +
    `  tree:      ${trees.staged}\n` +
    `  approved:  ${trees.approved || '(none)'}\n\n` +
    'Run the code-review agent on that worktree, fix every blocking finding, then let it record ' +
    'approval of this exact tree — the worktree path and tree id are the ones above:\n\n' +
    `  node "${approveScript}" "<worktree>" ${trees.staged}\n\n` +
    'Then retry the commit.'
  );
}

const failedOpen = (dir, reason) =>
  `could not check the staged tree in ${dir}, so the commit was let through: ${reason}`;

export function judge(commits, repo, { approveScript, worktrees = [], platform }) {
  const roots = worktrees.map((root) => normalize(root, platform));
  const blocks = [];
  const notes = [];
  for (const commit of commits) {
    if (commit.unresolved) {
      blocks.push(unresolvedRefusal(commit));
      continue;
    }
    if (!withinRoots(commit.dir, roots, platform)) continue;
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
      trees = repo.trees(commit.dir);
    } catch (error) {
      notes.push(failedOpen(commit.dir, error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (trees === null) {
      notes.push(failedOpen(commit.dir, 'git reported no staged tree'));
      continue;
    }
    if (trees.staged === trees.approved) continue;
    blocks.push(unreviewedRefusal(commit, trees, approveScript));
  }
  return { blocks, notes };
}
