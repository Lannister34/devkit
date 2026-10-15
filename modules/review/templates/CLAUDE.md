## Review

Work is reviewed before it is reported as done, not after. Stage the slice, run the `code-review`
agent over it — naming the worktree when it is not the current directory — address blocking
findings, then hand back. Commit exactly what was reviewed: no `-a`, pathspecs, or `--no-verify` on
the commit. The commit gate is a backstop for when this gets forgotten — reaching it means the loop
was skipped.

A pull request is a handoff too, and it hands over every commit on the branch — including ones
written before the rules, by another tool, or by someone else, which no commit gate ever saw. Before
opening one, run the `code-review` agent over the whole branch, naming its base, and fix what it
blocks on.

A pull request's description is for its reader: a short statement of what the change does and why,
then a short pass over the files, functions, and entities it changes or introduces, with the purpose
of each. It carries no verification results, review notes, or lists of things to look at; the author
reports those in the conversation, where an item inside the task gets done before the PR and one
outside it is the owner's call: now, later, or never.
