import { decodeConfig } from './review-config.mjs';
import { exemption } from './review-exemptions.mjs';

const reasonOf = (error) => (error instanceof Error ? error.message : String(error));

const unresolvedRefusal = (commit) =>
  `Cannot tell which worktree this commit targets (${commit.unresolved}). ` +
  'Retry it as `git -C <literal path> commit`.';

const stagesRefusal = (commit) =>
  `This commit stages files itself (${commit.stages}), so it would write a tree nobody ` +
  'reviewed. Stage with `git add`, review, then commit without it.';

const skipsHooksRefusal = () =>
  'This commit skips the git hooks, which run the gates the review approval assumes. ' +
  'Fix what the hooks report instead.';

function unreviewedRefusal(worktree, trees, approveScript, why) {
  return (
    "This commit's staged tree has not been reviewed.\n\n" +
    `  worktree:  ${worktree}\n` +
    `  tree:      ${trees.staged}\n` +
    `  approved:  ${trees.approval?.tree ?? '(none)'}\n` +
    `  exempt:    no — ${why}\n\n` +
    'Run the code-review agent on that worktree, fix every blocking finding, then let it record ' +
    'approval of this exact tree — the worktree path and tree id are the ones above:\n\n' +
    `  node "${approveScript}" "<worktree>" ${trees.staged}\n\n` +
    'Then retry the commit.'
  );
}

function exemptionFor(repo, worktree, approval) {
  try {
    const config = decodeConfig(repo.config(worktree));
    if (config === null) {
      return { exempt: false, reason: 'the project has no committed .claude/review.json' };
    }
    return exemption({
      config,
      approval,
      sinceHead: repo.changes(worktree),
      sinceApproval: approval === null ? null : repo.changes(worktree, approval.tree),
    });
  } catch (error) {
    return { exempt: false, reason: `the exemptions could not be checked: ${reasonOf(error)}` };
  }
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
      notes.push(failedOpen(worktree, reasonOf(error)));
      continue;
    }
    if (trees === null) {
      notes.push(failedOpen(worktree, 'git reported no staged tree'));
      continue;
    }
    if (trees.staged === trees.approval?.tree && !trees.approval.blocking) continue;
    const verdict = exemptionFor(repo, worktree, trees.approval);
    if (verdict.exempt) {
      notes.push(`${worktree}: passed unreviewed as ${verdict.reason}`);
      continue;
    }
    blocks.push(unreviewedRefusal(worktree, trees, approveScript, verdict.reason));
  }
  return { blocks, notes };
}
