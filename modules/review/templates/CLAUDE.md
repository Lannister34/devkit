## Review

A task is reviewed once, when its implementation is finished — not at each step, each hand-back, or
each follow-up the user asks for. Stage the slice and run the `code-review` agent over it, naming the
worktree when it is not the current directory, or the slice's files when the folder is not a git
repository. Pass it the checks you ran on the slice — each command and the last lines of its output
— so it does not run them again. Fix every defect and cleanup it reports, re-run the checks, and
commit: no `-a`, pathspecs, or `--no-verify` on the commit.

A second run happens only when the first found defects — behaviour that is wrong — and it verifies
their fixes: pass it the first run's findings and the tree it reviewed. Cleanups — rule fixes that
leave behaviour as it is — are fixed and committed without one. There is no third run: when the
second still finds defects, stop and re-plan the slice with the user. A small change after the
review is covered by the checks, not by another run.

The commit gate is the backstop for a skipped review, and reaching it means the loop was skipped. The
reviewer records the tree it read: approved when it found no defect, marked blocking otherwise. The
gate passes an approved tree; a change on top of an approved tree, within `smallFix.maxLines` in
`.claude/review.json`, to the files that review covered or named for its cleanups — its cleanups,
or a later tweak; and a commit that touches only the docs that file lists. Over a tree marked
blocking, no code change passes until a second run approves its fixes. Dependency manifests and
lockfiles, `CLAUDE.md`, `.mcp.json`, and any `.claude/` directory always need a review, however small
the change.

A pull request hands over every commit on the branch. Commits written by another tool or agent, by
someone else, or before these rules never passed a task review: before opening a pull request on a
branch that carries any, run the `code-review` agent over the whole branch, naming its base, and fix
its defects and cleanups. A branch whose every commit passed a task review needs no second look.

A pull request's description is for its reader: a short statement of what the change does and why,
then a short pass over the files, functions, and entities it changes or introduces, with the purpose
of each. It carries no verification results, review notes, or lists of things to look at; the author
reports those in the conversation, where an item inside the task gets done before the PR and one
outside it is the owner's call: now, later, or never.
