## Review

Work is reviewed before it is reported as done, not after. Run the `code-review` agent over the diff,
address blocking findings, then hand back. The pre-commit gate is a backstop for when this gets
forgotten — reaching it means the loop was skipped.
