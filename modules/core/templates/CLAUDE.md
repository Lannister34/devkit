## Doing the work

**Scope.** Do what was asked — not less, not more. Finish the tedious parts. An unrequested refactor
of adjacent code is a separate slice; something worth fixing outside the scope gets mentioned, not
done.

**Verification.** A change is done when it has been run, not when it has been written. Before
reporting completion: lint, typecheck, and the tests covering what changed. Report the real output —
if something fails, say so and show it; if a step was skipped, name it. "Should work" is not a result.

**Secrets.** Never commit them. All configuration comes from validated environment variables.

## Comments

The only comment that may exist in code is `TODO:` — known-incomplete work, naming what has to
happen, in English. Everything else lives elsewhere: the what in names, types, and structure; the
why and the invariants in ADRs, docs, and tests. If code seems to need explaining, rename it, split
it, or move the fact to the document that owns it; a reader left with a question raises it with the
owner, and an explanatory comment appears only when the owner asks for one. Tool directives that
are lexically comments — `@ts-expect-error` with its stated reason, suppressions like
`biome-ignore` — are directives, not comments, and follow their own rules.

## Documentation

Written documentation is in **{{docLanguage}}** — this file, `README`, ADRs, anything under `docs/`,
including headings and TODOs. Keep one fact in one place: link to the document that owns a subject
rather than restating it, because two copies of a fact become one stale copy.

Not in scope: identifiers and domain vocabulary, which follow the codebase they live in — do not
rename or translate them as a side effect of touching something else. Code comments are governed by
the Comments rule: English, whatever the documentation language.

## Module seams

- **Narrow interface, substantial implementation.** A module earns its place by hiding more than it
  exposes. A wrapper that forwards its arguments and adds nothing is not a seam — inline it.
- **Depend on the narrow port, not the concrete implementation.** Consumers declare the slice of
  behaviour they need; adapters satisfy it. This is what keeps test doubles typed and swaps cheap.
- **Extract on trigger, not on feeling.** Split a unit the moment any of these arrives:
  - a second consumer of the same logic,
  - a multi-step operation that must succeed or fail atomically,
  - conditional state transitions living inline in a caller,
  - a query or transformation whose correctness is not obvious on sight.

  Until a trigger fires, leave it inline. Premature splitting produces shallow fragments that are
  harder to follow than the code they replaced.

## Layering

Decision logic must be callable without touching the network, disk, clock, or environment. Push I/O
to the edges and keep the middle pure. If exercising one branch needs a live database, the branch is
in the wrong place — that is the test telling you where the seam belongs.

## Fault tolerance

Handling an error where it happens is the easy half. This is about what the *system* does when a
part of it stops.

Every boundary that can fail — network, storage, queue, subprocess, external API — has an explicit
error path. No silently swallowed errors, no unhandled rejections. Retries are bounded, idempotent,
and time out.

For anything crossing a process boundary or persisting state, answer three questions before writing
it:

- **If this dies mid-operation, what is left behind?** Partial writes, orphaned jobs, held locks,
  half-finished uploads. Something has to reclaim them — name what.
- **If this runs twice, what breaks?** If the answer is "nothing", say why: an idempotency key, a
  conditional update, a unique constraint. "It won't run twice" is not an answer.
- **If a dependency is down for an hour, what happens?** Apply backpressure, degrade, or fail fast —
  pick one deliberately. Unbounded buffering is not a choice, it is a leak.

Data has an owner at every instant. The window where a record is written but not yet claimed, or
claimed but not yet durable, is where data goes missing — make it explicit and short.

## Tests

A slice that adds behaviour adds its tests in the same commit. Tests are deterministic: no wall
clock, no network, no dependence on execution order. Assert on observable behaviour, not internals —
a test that breaks when you rename a private method is a maintenance tax, not a check.

## Bugs

A fix that only makes the symptom go away is half the work. Name the root cause and the class it
belongs to, because the class decides what happens next:

- **The toolchain should have caught it** — missing lint rule, loose type, unvalidated boundary.
  Tighten the toolchain, same commit.
- **An uncovered case** — add the test that would have failed, same commit.
- **A wrong assumption about something external** — pin it with a test at that boundary and leave a
  comment saying what surprised you.
- **Ordering, concurrency, or lifecycle** — fix the immediate break, then *propose* the design change.
- **Architecture** — the seam is in the wrong place. Fix the break, propose the redesign, do not
  start it.

The last two are proposals, not work. A bug report is not authorization to refactor.
