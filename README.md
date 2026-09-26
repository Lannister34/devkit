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
| `core` | always | gates, comment whitelist, module-seam and surface rules, edge and failure-path rules, test rules |
| `design` | always | design-before-code workflow, ADR scaffold and template |
| `git` | `.git` | line-ending normalisation, conventional-commit message hook |
| `review` | `.git` | code-review agent that blocks on the project's rules + a commit gate bound to each worktree's staged tree |

`git` and `review` are gated on the target being a repository root, so a folder that merely *contains*
projects gets the rules without hooks that could never fire.

**`toolchain`** — configures a specific stack, so it needs the stack to exist:

| module | detects on | what it installs |
|---|---|---|
| `ts` | `tsconfig.json`, `*.ts`, `typescript` dep | `@devkit/tsconfig` + `@devkit/biome-config` + `@devkit/checks` as pinned dependencies, TS-specific rules, the gates for core's checkable rules, biome/comments/typecheck pre-commit hooks |
| `nest` | `@nestjs/core` dep AND `*.module.ts` usage | NestJS skeleton, role suffixes, layer direction, composition-root and worker conventions |

For a brand-new project: install `foundation`, plan the app using the design tooling you just got,
then re-run for the toolchain once the stack is real.

## The review gate

`review` is the answer to "I want to coordinate, not validate every step":

1. A `PreToolUse` hook reads every command the `Bash` and `PowerShell` tools are about to run the way
   that shell would: quoted text and heredoc or here-string bodies are data, so a message or a note
   that mentions `git commit` is not one.
2. For each `git commit` it finds, it resolves the worktree the commit targets — the tool's `cwd`,
   then any `cd` before it, then each `-C` — and compares that worktree's `git write-tree` with the
   approval recorded in that worktree's own git directory (`git rev-parse --git-path
   devkit-review-state`: one per worktree, never tracked, nothing to ignore).
3. No match → the commit is blocked with the exact command that records approval. Three shapes are
   blocked outright: a target the hook cannot read (`-C "$DIR"`, `GIT_DIR=`, `--git-dir`) cannot be
   judged; a commit that stages files itself (`-a`, `-i`, `-o`, `-p`, pathspecs) writes a tree
   nobody reviewed; a commit that skips hooks (`--no-verify`, `core.hooksPath`) skips the gates the
   approval assumes.
4. The agent reviews that worktree's staged diff against the project's rules and its own axes, and
   runs `.claude/hooks/approve-review.mjs` **only** when nothing is blocking. A rule broken by a line
   the diff adds blocks; one on an untouched line is reported as debt.

Approval is bound to one worktree's exact staged tree, so staging more after a review does not slip
through, and reviewing one worktree does not approve its sibling. The hook is registered as
`node "$CLAUDE_PROJECT_DIR/.claude/hooks/require-review.mjs"`, so it loads from the project whatever
directory the command runs in. Claude Code runs command hooks through Git Bash on Windows; a Windows
install without Git Bash runs them through PowerShell, where that path does not expand and the hook
never fires. It needs git 2.31 or later for `--path-format=absolute`. It fails open when git or the
payload misbehaves — a broken gate must never wedge a repo. It is a backstop for the agent's own
commits, not a sandbox: it sees one command at a time, starting from the working directory the tool
reports, so a commit hidden in `bash -c`, `eval`, a script, or a rebase is not one it sees.

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
  ranges the project already satisfies are kept silently, not flagged. `ownedArrays` maps a dotted
  array path to a marker: an element there that carries the marker is devkit's, and one the template
  no longer ships is replaced rather than kept beside its successor — the plan names each replaced
  element. A project entry that shares a group with devkit's survives: the group is pruned, not
  dropped. Keep your own entries free of the marker.
- `extend-json` — wire an existing config to inherit a devkit base. Raises a decision carrying the
  computed flag-level delta; `compareWith` and `compareKey` say what to diff against.
- `section` — marker-delimited block, replaced in place on re-run. `markerStyle` is `html`
  (default) or `hash`. `header` seeds a fresh file and supports `{{project}}`. `guardKeys` lists
  top-level keys that must not already exist outside the markers — this is what stops a second
  `commit-msg:` from being appended to a YAML file that already has one.

Templates are copied verbatim, so a module's output stays diffable against its source.

**Rules and gates.** A rule a tool can check ships with that check, in the toolchain module of each
stack it applies to; `ts`'s own section names which of core's rules it gates and how. A rule no tool
can check is left to the review agent, on the terms "The review gate" states. Templates obey the
rules their install brings: a shipped script carrying a comment is a violation the project did not
write, so a script template's why lives in this file.

## Versioning

`ts` installs thin `extends` stubs and pins the real configs, and the checks package, as git
dependencies:

```json
"@devkit/tsconfig": "github:Lannister34/devkit#v0.1.2&path:/packages/tsconfig",
"@devkit/biome-config": "github:Lannister34/devkit#v0.2.0&path:/packages/biome-config",
"@devkit/checks": "github:Lannister34/devkit#v0.2.0&path:/packages/checks"
```

`@devkit/checks` carries the gates Biome has no rule for. `devkit-comments` reads every tracked
TypeScript and JavaScript file with the TypeScript parser's own comment ranges — so a regex, a
template string, or JSX text that looks like a comment is not one — and every tracked CSS file with
a string-aware lexer, and fails any comment core does not allow. On code that already breaks the
rule it gates against `.devkit/comments-baseline.json`: a file above its count fails, and so does a
file below it until the baseline is lowered, so no slack accumulates for a new comment to hide in.

So a rule change is a tag plus a pin bump, and it reaches every project that consumes it — the
propagation a copied template never gives you. Installed modules are recorded in the target's
`.claude/toolkit.json`, which makes re-running an *upgrade* rather than a duplicate install.

**Never pin a tag that does not exist yet.** An unpublished pin breaks `pnpm install` in every
project that installs the module, and it fails at install time rather than anywhere useful.

`packages/tsconfig/base.json` is deliberately **orthogonal to module system** — it carries strictness
only, and each project sets its own `module` / `moduleResolution`. A base that fixes both is unusable
in half the projects that want the strictness.

## Status

`npm test` is the claim. It covers the review gate's command reader for both shells, every refusal
and targeting form, its git adapter against a real repository with a linked worktree, and its
entrypoints against a real repository; the comment gate and its baseline, end to end; the
`ignored-targets` decision; and the upgrade of devkit-owned hook entries. It needs Node, git, and the
`typescript` devDependency. The Biome rule names are checked by hand against the pinned schema
whenever the pin moves, since the suite carries no Biome.

Verified once by hand against a real project: install → `pnpm install` → `tsc` inherits the strict
base with local overrides intact → `biome` resolves the shared config; detection across
project/container/monorepo shapes; decisions and their resolutions; `--var` substitution and
persistence; the commit-convention and line-ending checks against real repository state.

Known gap: installing `ts` into a codebase that has never been formatted will rewrite most files on
the first `biome format` run, and nothing warns about the blast radius yet.
