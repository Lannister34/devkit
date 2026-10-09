## Doing the work

**Scope.** Do what was asked — not less, not more. Finish the tedious parts. An unrequested refactor
of adjacent code is a separate slice; something worth fixing outside the scope gets mentioned, not
done.

**Verification.** A change is done when it has been run, not when it has been written. Before
reporting completion: lint, typecheck, and the tests covering what changed. Report the real output —
if something fails, say so and show it; if a step was skipped, name it. "Should work" is not a result.

**Gates.** A rule a tool can check is checked by one — a lint rule, the typecheck, a script the
check command runs — because a rule left to memory decays as fast as code is written. The gate is
tracked and runs in CI: a check that lives in one checkout exists in no other. Every tracked file
belongs to some gate — scripts, configs, and tests are source too — and source is text: one raw
control byte makes git treat a file as binary and hides every later diff of it from review. A gate
adopted over code that already breaks it starts from a recorded baseline that may only shrink.
Narrowing a gate — a rule switched off or down, a file excluded from it — is a recorded decision,
never a local edit. What no tool can check, review enforces.

**Secrets.** Never commit them, log them, or send them back: a secret enters through the config
module or a write-only field, and leaves only toward the service it authenticates. Whatever the app
writes at runtime lands where git ignores it — data written where git can see it is one
`git add -A` away from published.

## Comments

The only comment that may exist in code is a one-line `TODO:` — known-incomplete work, naming what
has to happen, in English: `// TODO:` wherever the language has line comments; no block or
doc-comment forms. Code is every tracked file a program reads as code — source, tests, scripts,
stylesheets, and configs written in a programming language; declarative data (JSON, YAML, TOML,
ignore and attribute files) is outside the rule. Everything else lives elsewhere: the what in names,
types, and structure; the why and the invariants in ADRs, docs, and tests. If code seems to need
explaining, rename it, split it, or move the fact to the document that owns it; a reader left with a
question raises it with the owner, and an explanatory comment appears only when the owner asks for
one. Removing a comment that states an invariant is a move, not a deletion: the invariant lands in a
named test or the owning document first. Tool directives that are lexically comments —
`@ts-expect-error` with its stated reason, suppressions like `biome-ignore` — are directives, not
comments, and follow their own rules.

## Documentation

Written documentation is in **{{docLanguage}}** — this file, `README`, ADRs, anything under `docs/`,
including headings and TODOs. Keep one fact in one place: link to the document that owns a subject
rather than restating it, because two copies of a fact become one stale copy. What an as-is
document claims about the code is a rule like any other — gated, or listed among the document's
known gaps — and a slice that breaks a stated claim updates the document in the same commit.

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

## Structure

- **The entrypoint wires; it declares nothing.** An entrypoint constructs the app's pieces, connects
  them, starts them, and handles boot failure — nothing else. It exports nothing, nothing imports it,
  and logic does not hide in it as inline callbacks: a handler body longer than a delegation is a
  declaration in disguise. A config object, interface, helper, or service class living in the
  entrypoint is a file that has not been created yet; a run-guard (`if __main__`, `process.argv`
  checks) is the file admitting it is two files. Scope: deployable apps — a single-file tool is its
  own entrypoint, and this rule begins once the program grows past one file.
- **A file is one role, and grab-bag names are not roles.** A file exports one thing a reader can
  name — a class, a component, a hook, a use case, the schemas of one format, or functions that
  compute one kind of thing — and holds nothing else but private glue only that thing uses; the
  filename states that thing. `utils`, `helpers`, `common`, `misc` state nothing — a declaration
  that only fits there is a declaration whose owner has not been found yet. Whatever can be tested
  on its own is its own file: a wire or storage format (schemas and the types inferred from them), a
  mapper or codec between shapes, a parser, a rule. So an I/O client never shares a file with the
  schemas of the protocol it speaks or the functions that build and decode its payloads, and a
  screen never declares a second component. A parser beside its own error type is still one role; a
  queue consumer beside an HTTP handler is two. This is file organization, not new abstraction:
  splitting a file moves declarations, it invents no seam.
- **Config is one module per app.** The environment is read in exactly one place per app, validated
  at startup — named keys with types; a passthrough bag is not validation — and injected everywhere
  else. A default restated at a call site is a value with N owners: rotating it means finding all N,
  and missing one is silent. Any `process.env` / `os.environ` read outside the config module is a
  bug, entrypoint included. Launchers and scripts are call sites too: every documented way to start
  the app takes its defaults from that module, resolves paths from its own location rather than the
  caller's, and runs only dependencies the lockfile pins. Same scope as the entrypoint rule: a
  single-file tool reading a variable is not an app.
- **Same-stack siblings share one skeleton.** Apps built on the same framework repeat one layout —
  same file names, same places, so a reader who knows one app knows them all. An app on a different
  stack follows that stack's idiom instead. Changing the skeleton is a recorded decision, not drift
  from the newest app.
- **Modules are entered through their surface.** Imports cross a package boundary — or a
  feature-module boundary inside an app — only through its public entry point. Deep imports into
  internals and `export *` over another module's files dissolve the boundary. A surface is curated:
  a barrel that re-exports every internal file is not a surface but the absence of one — a module
  hides more than it exposes. Direction is one-way and acyclic: shared libs never import from apps,
  sibling modules follow one recorded direction, and a lib that needs an app's type is a type that
  belongs in the lib. An interface another program consumes — an HTTP API, a CLI, a file format — is
  a surface too: one document lists what its consumers rely on, a test replays their calls, and it
  changes additively or by a recorded decision.
- **Spike code never migrates into `apps/`.** A spike proves a hypothesis and is discarded; what
  survives is knowledge, recorded in a `FINDINGS.md` beside the spike. Graduating a spike is an
  explicit act: implement the finding into the skeleton, from scratch — the finding may be the code
  itself, and then it is rebuilt in place with its tests, not moved. Launch mechanics that were
  convenient for the spike are part of what gets discarded.

## Layering

Decision logic must be callable without touching the network, disk, clock, or environment. Push I/O
to the edges and keep the middle pure. If exercising one branch needs a live database, the branch is
in the wrong place — that is the test telling you where the seam belongs.

The edges are where the outside gets in, and each one decides three things:

- **The shape, and whose fault a bad one is.** Input is parsed by its owner's schema — a request by
  the transport contract, a stored record by a schema the storage owns — and a cast is not a parse.
  Only a request that fails its contract is the caller's fault; a stored record or the system's own
  output failing its schema is a server fault, logged. Stored data is read leniently: unknown fields
  pass through, and one bad record is logged and skipped, never fatal to the list, so tightening a
  contract never makes stored data unreadable. A value the system generates — an id, a key, a file
  name — passes the predicate that reads it back: one predicate, used on both sides. Errors map to
  responses by type, in one place per app, never by message text.
- **Data stays data.** Request, file, or model data reaches a shell, script, query, or pattern only
  as a bound parameter — argv, environment, placeholders. An escaping helper is not a defence: the
  next quote character it does not know is the injection.
- **Trust is enforced, not assumed.** "Only this machine" or "only our client" is checked in code on
  every request, and anything that forwards to the service is part of its boundary; a bind address
  or a CORS policy is not authorization. Expanding untrusted input — templates, recursion,
  decompression — has explicit depth and size limits.

## Fault tolerance

Handling an error where it happens is the easy half. This is about what the *system* does when a
part of it stops.

Every boundary that can fail — network, storage, queue, subprocess, external API — has an explicit
error path. No silently swallowed errors, no unhandled rejections. Retries are bounded, idempotent,
and time out; a stream's timeout measures silence, not total length.

For anything crossing a process boundary or persisting state, answer four questions before writing
it:

- **If this dies mid-operation, what is left behind?** Partial writes, orphaned jobs, held locks,
  half-finished uploads. Something has to reclaim them — name what. A record that points outside
  the process — a PID, a lock, a temp path — proves it still names what was created before anything
  acts on it; a failed check drops the record, never the thing.
- **If this runs twice, what breaks?** If the answer is "nothing", say why: an idempotency key, a
  conditional update, a unique constraint. "It won't run twice" is not an answer.
- **If the data changed since it was read, what happens?** A write computed from an earlier read —
  a form, a cached snapshot, a reply that took minutes — carries a precondition checked inside the
  write's critical section, and the read that feeds a write happens there too, strictly: unreadable
  refuses the write, never reads as empty. A record a client can address has a persisted, stable id;
  its position is at most a precondition. Everything that can refuse runs before the first
  destructive step.
- **If a dependency is down for an hour, what happens?** Apply backpressure, degrade, or fail fast —
  pick one deliberately. Unbounded buffering is not a choice, it is a leak.

Data has an owner at every instant. The window where a record is written but not yet claimed, or
claimed but not yet durable, is where data goes missing — make it explicit and short. Work in flight
has an owner too: an operation started for a caller stops when the caller goes — a closed
connection, an unmounted view — and passes that cancellation down to whatever it waits on. State
kept for an entity is keyed by that entity's id, so it ends with the entity instead of leaking into
the next one.

## Tests

A slice that adds behaviour adds its tests in the same commit. Tests are deterministic: no wall
clock, no network, no dependence on execution order. Assert on observable behaviour, not internals —
a test that breaks when you rename a private method is a maintenance tax, not a check.

An assumption about something outside the process — how a protocol signals completion and errors,
which parameters a provider accepts, how the platform encodes text, folds case in file names, or
orders strings — is pinned by a boundary test when the code relying on it is written, not after it
breaks. Fixtures include the hostile case: a malformed record, a name at its length limit, text
outside ASCII.

## Bugs

A fix that only makes the symptom go away is half the work. Name the root cause and the class it
belongs to, because the class decides what happens next:

- **The toolchain should have caught it** — missing lint rule, loose type, unvalidated boundary.
  Tighten the toolchain, same commit.
- **An uncovered case** — add the test that would have failed, same commit.
- **A wrong assumption about something external** — pin it with a test at that boundary whose name
  states what surprised you.
- **Ordering, concurrency, or lifecycle** — fix the immediate break, then *propose* the design change.
- **Architecture** — the seam is in the wrong place. Fix the break, propose the redesign, do not
  start it.

The last two are proposals, not work. A bug report is not authorization to refactor.
