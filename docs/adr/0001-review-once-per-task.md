# ADR-0001: Review once per task, re-review only defects, and gate commits with small-fix and docs exemptions

**Status:** accepted · 2026-11-04

## Context

Up to 0.1.12 the `review` module ran the `code-review` agent before every hand-back, and its commit
gate refused any staged tree that was not the exact tree approved. In practice that cost far more
quota than it returned:

- Any edit after an approval voided it, so each small fix paid for a full new review.
- Each round reported new findings instead of all blockers at once; one UI slice in RAID took seven.
- The reviewer re-ran the project's full checks on every round: in RAID a full `pytest` run of up to
  eight minutes, about 130–160 thousand tokens per round.
- Docs-only commits went through the same full review as code.
- The rule text alone, not the gate, drove repeat runs: in Persikas, whose root is not a repository
  and where the gate never fires, the agent still ran the review at every hand-back, and again over
  the branch before each pull request.

The reviews still earned their place. They caught defects every automated gate missed: published
RFC 8032 test keys shipped as production signing keys, a reflected XSS on a loopback callback, and a
check that would have blocked the product's own agent forever. The owner's direction: one review
per finished task is the norm, two at most when the fixes were large; quota matters more than
per-commit ceremony.

The gate is a Claude Code `PreToolUse` hook that reads the agent's shell commands. It sees a local
`git commit`; it never sees a merge done on the forge.

## Alternatives

- **Remove the gate.** Cheapest, and the rule text alone would carry the budget. Rejected: the gate
  is the only thing that catches a skipped review, and skipped reviews are where the defects above
  would have shipped.
- **Keep the per-commit gate as it was.** Rejected: it is what turns every follow-up edit into a
  full review, and the round structure it implies is what produced seven-round slices.
- **Gate per slice.** Commits on work branches pass freely and the gate fires when a slice closes —
  at a merge into the default branch or an explicit "slice done" step. Rejected: merges happen on the
  forge, where the hook cannot see them, and an explicit marker does not fire in the one case a
  backstop exists for, the agent that forgot. Gating `git push` and `gh pr create` instead would
  need a second command reader for a larger surface and would leave unreviewed code in pushed
  history.

## Decision

1. The rule text sets a budget: one `code-review` run per task, when its implementation is
   finished; a second run only to verify the fixes for defects the first one found; no third — the
   slice is re-planned with the user. Changes after the review are covered by the project's checks.
   Branch review before a pull request runs only when the branch carries commits no task review saw.
2. The reviewer sorts each finding by kind. A **defect** is behaviour that is wrong, and only when
   the reviewer can state the input or state and the wrong outcome. A **cleanup** is a broken rule
   whose fix leaves behaviour as it is: naming, structure, logging, style, a missing test. A
   **note** blocks nothing. The first round reports every defect and cleanup at once, numbered
   with `file:line` and a fix instruction. The second round runs only after defects, verifies their
   fixes against the diff since the first round's tree, and finds defects only in an unfixed one, in
   what the fixes introduced, or in a finding marked `critical` with its exploitation scenario.
3. The reviewer takes the caller's check results — command and last lines of output — and runs only
   targeted reproductions of its own findings; a full check only when results are missing or look
   wrong.
4. The gate stays per commit, and passes, besides the exact approved tree:
   - a **small fix** over an approval: a diff against the approved tree that modifies in place only
     files of the reviewed diff, within `smallFix.maxLines` (150 by default) in
     `.claude/review.json`. That is how a review's cleanups, and later tweaks, land without another
     run. The reviewer records its tree in every round, marked `blocking` when it found a defect, and
     a blocking record passes no fix until the second round approves;
   - a **docs-only** commit, by `docs.include` and `docs.exclude` in the same file.

   Dependency manifests, lockfiles and registry config (`alwaysReview`), `CLAUDE.md`, and `.claude/`
   pass under neither, whatever the size.
5. The gate fails closed on everything new: a missing or invalid config, an unreadable approval, or
   a diff git cannot produce leaves no exemption. The config is read from `HEAD`, so loosening it
   needs a reviewed commit.

## Consequences

- A task costs one review, two when the first found defects, and no review re-runs the full test
  suite the caller already ran. Docs land without one.
- What triggers a second round is the risk of the finding, not the size of the fix: a one-line fix
  to a defect is verified, a large rename for a cleanup is not. Line count was considered as the
  trigger and rejected as a poor proxy for risk.
- The gate cannot read a finding's kind off a diff, so its limit no longer judges the fixes. It only
  stops an approval from covering the next task: up to `smallFix.maxLines` lines over an approved
  tree land unread, and a single line can hold a defect. This is the accepted risk; the limit bounds
  it per review, not per commit, because the diff is measured against the approved tree.
- Nothing proves that the cleanups listed were fixed, or that a fix sold as a cleanup leaves
  behaviour unchanged. The gate catches a forgotten review, not a careless fix.
- A cleanup that splits a file adds one, which the gate refuses as a small fix; it needs a review.
- The reviewer might file everything as a defect, which brings the extra rounds back. The prompt
  asks for the input and the wrong outcome before a finding counts as one.
- A second round may let a real but non-critical defect that the first round missed through as a
  non-blocking note.
- Trusting the caller's check output means a wrong report goes unnoticed unless it looks wrong. The
  reviewer still runs a full check when one is missing or inconsistent.
- If the budget proves too loose, the fallback is a config change — `smallFix.maxLines: 0` restores
  exact-tree approval for code — not a rewrite.
