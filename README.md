# devkit

Portable engineering rules, quality gates, and a code-review agent that installs itself into any
project — new or existing — via a Claude Code skill.

The problem it solves: rules copy-pasted between projects drift, and a GitHub template repo only ever
helps the *next* greenfield project. Here the rules are modules with a version, so improving one
project's rules improves all of them.

## Install

Clone it and add it as a Claude Code plugin. The repo root **is** the plugin, so `skills/`, `bin/`,
and `modules/` all ship together.

```bash
git clone git@github.com:Lannister34/devkit.git
```

Then in any project:

> let's configure devkit for this project

The `init` skill detects the stack, picks modules, shows a plan, and writes nothing until approved.

## The two phases

Modules declare a `phase`, because rules and toolchains have different prerequisites.

**`foundation`** — language-agnostic, installable into an empty repository:

| module | detects on | what it installs |
|---|---|---|
| `core` | always | comment whitelist, module-seam and extraction-trigger rules, failure-path rules, commit conventions |
| `design` | always | design-before-code workflow, ADR scaffold and template |
| `git` | `.git` | line-ending normalisation, conventional-commit message hook |
| `review` | `.git` | five-axis code-review agent + a pre-commit gate that triggers it |

`git` and `review` are gated on the target being a repository root, so a folder that merely *contains*
projects gets the rules without hooks that could never fire.

**`toolchain`** — configures a specific stack, so it needs the stack to exist:

| module | detects on | what it installs |
|---|---|---|
| `ts` | `tsconfig.json`, `*.ts`, `typescript` dep | `@devkit/tsconfig` + `@devkit/biome-config` as pinned dependencies, TS-specific rules, biome/typecheck pre-commit hooks |

For a brand-new project: install `foundation`, plan the app using the design tooling you just got,
then re-run for the toolchain once the stack is real.

## The review gate

`review` is the answer to "I want to coordinate, not validate every step":

1. A `PreToolUse` hook intercepts `git commit`.
2. It compares `git write-tree` against `.claude/.review-state`.
3. No match → the commit is blocked with an instruction to run the `code-review` agent.
4. The agent reviews `git diff --cached` across five axes and records approval **only** when nothing
   is blocking.

Approval is bound to the exact staged tree, so reviewing once and then staging more does not slip
through. The hook fails open on any unexpected condition — a broken gate must never wedge a repo.

## Internals

You are not meant to run this. The `init` skill drives it and carries every question into chat —
these commands are here for debugging devkit itself.

```bash
node bin/apply.mjs --detect --target /path/to/project
node bin/apply.mjs --target /path/to/project --modules core,design,review,ts
node bin/apply.mjs --target /path/to/project --modules core,design,review,ts --apply
```

Plans by default. Exit `3` means something needs an answer. Nothing is ever overwritten silently.

## Decisions, not dead ends

When an existing file disagrees with a module, the applier does not just refuse — it computes the
delta and offers named options:

```
DECISION  tsconfig.json — tsconfig.json does not inherit ./tsconfig.base.json
          options: extend | keep  (--resolve tsconfig.json=<option>)
```

The `--json` output carries the evidence behind it: `wouldNewlyApply` (settings that start taking
effect), `theirsWins` (both set it, theirs takes precedence), `strictOnlyInTheirs` (where the project
is ahead of the standard). That is what turns "these files differ" into a choice someone can make.

| option | effect |
|---|---|
| `extend` | add `extends` to the existing config; local overrides still win |
| `chain` | inherit alongside an `extends` that is already there — devkit's base goes first, so theirs still wins |
| `keep` | leave the file untouched |
| `override` | replace it with the standard |

```bash
node bin/apply.mjs --target . --modules ts --resolve tsconfig.json=extend --apply
```

Answers are recorded in `.claude/toolkit.json` and honoured on later runs, so a second pass resumes
rather than re-asking. Pass `--resolve` again to change one.

A true **conflict** — a competing tool already configured, a guarded key already present, invalid
JSON — has no flag. It is a migration for a human to decide on, and the installer stops there.

## Writing a module

`modules/<name>/module.json`:

```json
{
  "name": "python",
  "phase": "toolchain",
  "requires": ["core"],
  "detect": { "anyOf": ["file:pyproject.toml", "glob:**/*.py"] },
  "conflicts": [".flake8"],
  "dependencies": { "devDependencies": {}, "scripts": {} },
  "files": [
    { "from": "templates/CLAUDE.md", "to": "CLAUDE.md", "strategy": "section", "marker": "python" }
  ]
}
```

**Detect predicates:** `file:<path>` · `glob:**/*.<ext>` · `json:<file>#<dotted.key>`

**Strategies:**

- `create` — write if absent; identical content is `unchanged`; different content raises a decision
  (`keep` / `override`).
- `merge-json` — deep merge; arrays union by value; a scalar that disagrees is a conflict. Dependency
  ranges the project already satisfies are kept silently, not flagged.
- `extend-json` — wire an existing config to inherit a devkit base. Raises a decision carrying the
  computed flag-level delta; `compareWith` and `compareKey` say what to diff against.
- `section` — marker-delimited block, replaced in place on re-run. `markerStyle` is `html`
  (default) or `hash`. `header` seeds a fresh file and supports `{{project}}`. `guardKeys` lists
  top-level keys that must not already exist outside the markers — this is what stops a second
  `commit-msg:` from being appended to a YAML file that already has one.

Templates are copied verbatim, so a module's output stays diffable against its source.

## Versioning

`ts` installs thin `extends` stubs and pins the real config as git dependencies:

```json
"@devkit/tsconfig": "github:Lannister34/devkit#v0.1.1&path:/packages/tsconfig",
"@devkit/biome-config": "github:Lannister34/devkit#v0.1.1&path:/packages/biome-config"
```

So a rule change is a tag plus a pin bump, and it reaches every project that consumes it — the
propagation a copied template never gives you. Installed modules are recorded in the target's
`.claude/toolkit.json`, which makes re-running an *upgrade* rather than a duplicate install.

**Never pin a tag that does not exist yet.** An unpublished pin breaks `pnpm install` in every
project that installs the module, and it fails at install time rather than anywhere useful.

`packages/tsconfig/base.json` is deliberately **orthogonal to module system** — it carries strictness
only, and each project sets its own `module` / `moduleResolution`. A base that fixes both is unusable
in half the projects that want the strictness.

## Status

Verified end to end against a real project: install → `pnpm install` → `tsc` inherits the strict base
with local overrides intact → `biome` resolves the shared config and flags `noExplicitAny` and
`noNonNullAssertion`.

Also verified: detection across project/container/monorepo shapes, planning, apply, idempotent
re-apply, decisions and their `keep`/`override`/`extend`/`chain`/`merge` resolutions, `--var`
substitution and persistence, commit-convention and line-ending checks against real repository
state, and the review gate across its cases (blocked, approved, tree-changed, non-commit command,
malformed payload).

Known gap: installing `ts` into a codebase that has never been formatted will rewrite most files on
the first `biome format` run, and nothing warns about the blast radius yet.
