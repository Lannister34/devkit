---
name: init
description: Configure devkit's engineering rules, quality gates, and code-review agent for a project. Use when the user asks to set up, install, configure, or upgrade devkit or "the toolkit" in a new or existing project.
---

# devkit init

`${CLAUDE_PLUGIN_ROOT}` is the devkit root (the clone directory, if that variable is unset).
`bin/apply.mjs` there is the only thing that writes files. Never hand-write a config a module owns.

## Interaction contract

Everything the user sees or decides happens **in this chat**. They never run a command, never read
raw tool output, and never need to know `apply.mjs` exists.

- Run the applier yourself, always with `--json`. Its text output is for debugging, not for showing.
- Translate every plan, decision, and result into prose. A pasted CLI dump is not a report.
- Ask conversationally, with a recommendation and the reasoning behind it. Never tell the user to
  pass a flag — take their answer in chat and turn it into `--resolve` yourself.
- The only commands that belong in front of the user are ones genuinely theirs to run: installing
  dependencies, activating git hooks. Everything else you run.

## 1. Pick the target

The target is the **project root** — the directory that is its own repository and owns its
`package.json` / `pyproject.toml` / `go.mod`. That is often the session's working directory, but not
always: a session opened in a folder that merely *contains* projects must target the specific one the
user means.

Before anything else, check whether the working directory holds sibling repositories:

```
ls -d */.git
```

If it does, it is a container, not a project. Say which projects you found and ask which one to
configure — never silently pick, and never configure the container itself unless the user asks for
that specifically. Everything below runs against the directory you settled on; `.` below means that
directory, not necessarily the session root.

## 2. Read the ground truth

Detect before deciding anything. Do not infer the stack from the conversation:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/apply.mjs" --detect --target .
```

Also read `.claude/toolkit.json`. If it exists, this is an **upgrade**, not an install: those modules
are already present, and the job is to report what changed between the recorded version and the
current one.

## 3. Decide which phase applies

Modules come in two phases with different prerequisites.

**foundation** — `core`, `design` (any directory), plus `git` and `review` (only where the target is
a git repository root). Language-agnostic, no stack assumptions, safe to install into an empty repo.
These govern *how the app gets planned*, so they land before the planning does.

A directory that merely *contains* several projects is not a project. If detection reports only
`core` and `design`, that is usually what it found — say so rather than installing hooks that can
never run.

**toolchain** — `ts`, and its future siblings. Configures a specific stack, so it can only be
installed once that stack exists.

- **Existing project, stack detected** → foundation + every detected toolchain module. One pass.
- **Existing project, nothing detected** → foundation only. Report which toolchain modules exist and
  what would trigger them.
- **New project with a plan or spec in the repo** → read it. If it names the stack, treat as the case
  above. If it doesn't, foundation only.
- **New project, nothing there** → foundation only, then say plainly: plan the app first, re-run this
  skill afterwards for the toolchain. Do **not** interview the user about a stack they have not
  chosen yet.

Ask only when detection is genuinely *ambiguous* — two stacks present with no obvious primary, or a
plan that contradicts what is on disk. Emptiness is not ambiguity; it is an answer.

## 4. Never install rules for a language that isn't there

A module installs only when its `detect` predicate fires, or the user explicitly asks for it. A
Python-only repo does not get TypeScript rules. If a module looks like it should apply but detection
disagrees, say so and let the user decide — never override the predicate silently.

## 5. Plan, resolve, apply — iteratively

`apply.mjs` plans by default and writes nothing without `--apply`. Plan first, in JSON:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/apply.mjs" --target . --modules core,git,design,review,ts --json
```

The plan separates three outcomes, and they are handled differently.

**changes** — additive and safe. Report them grouped; no question needed.

**decisions** — an existing file disagrees with a module, and the applier has already computed *why*.
Each carries `options` and a `detail` payload. This is the part that needs you: do not flatten it to
"there is a conflict". Read the detail, judge it against this project, and put a recommendation in
front of the user.

- `wouldNewlyApply` — settings that start taking effect if they inherit. These are the consequential
  ones. Say what is likely to break: switching on `noUnusedLocals` in a codebase that never had it
  will surface real errors, and the user should hear that before choosing.
- `theirsWins` — both sides set it, theirs takes precedence. Usually harmless; raise it only when
  their value is *weaker* than the standard.
- `strictOnlyInTheirs` — the project is ahead of the standard here. Say so, and consider whether it
  belongs upstream in devkit rather than being flagged downward.

Then ask, offering exactly the `options` the applier listed — typically `extend` (inherit the
standard, keep local overrides), `chain` (inherit alongside an existing base), `keep` (leave as-is),
`override` (replace with the standard). Never invent an option that was not offered.

**conflicts** — not resolvable by a flag: a competing tool already configured, a guarded key already
present, invalid JSON. Describe the migration and stop. Do not work around it.

### How to frame the options

Every option is a course of action **in the user's project**. Never make them reason about devkit's
architecture — "drop the module", "make it configurable upstream", "leave the files inert" are
devkit's problems, not theirs. Two families cover almost everything.

**A rule that contradicts the repo.** The repo already does something devkit would change — a commit
convention, a lint stance, a layout. Offer:

- **keep** — the repo's convention wins; devkit's contradicting section is not installed.
- **override** — devkit's rule wins; the repo adopts it, and say what that costs.
- **merge** — reconcile the two. This is real work, so name the reconciled rule concretely. For a
  commit convention that means proposing the actual pattern and passing it through:
  `--var commitPattern=<regex> --var commitConvention=<one-line description>`.

Never install two contradictory rules and call that a resolution. Two CLAUDE.md sections that
disagree are worse than neither — the file stops being trusted.

**Work too large for this session** — a migration, a mass fix. Offer **stop** (record the scope,
change nothing today), **plan** (a written breakdown, saved as an ADR or ticket), or **do it now**
(only when the user is clear about the size).

Either way, carry the numbers. "417 errors, roughly 230 mechanical and 180 real type errors" is a
decision. "There is a conflict" is not.

Once the user has answered in chat, translate their words into flags and run it yourself:

```
node ... --modules ... --resolve tsconfig.json=extend --resolve biome.json=keep --apply
```

Resolutions persist in `.claude/toolkit.json`, so later runs resume instead of re-asking. Passing
`--resolve` again with a new value changes a previous answer — which is how "actually, let's leave
that one alone" gets handled.

**Work incrementally.** Land what is undisputed first, then take decisions one at a time, verifying
after each. A run that installs eight files and leaves one open question is a better outcome than one
that stalls on everything.

## 6. Finish the install

`apply.mjs` writes files; it does not run package managers. Report which of these are outstanding and
run them if the user agrees:

- Install dependencies, if `ts` was installed — its dev dependencies were merged into `package.json`.
- `lefthook install` — nothing in `lefthook.yml` runs until this happens.
- Restart the session if `review` was newly installed, so the hook in `.claude/settings.json` loads.

Then verify rather than assume: lint and typecheck should actually run clean.

## Out of scope

This skill does not write project rules by hand, invent module content, or edit files a module owns.
If a project needs something no module covers, that is a new devkit module — propose it, do not
special-case it here.
