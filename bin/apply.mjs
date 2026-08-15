#!/usr/bin/env node
// Deterministic module applier, driven by the init skill — never by a person. It chooses nothing and
// asks nothing: the skill decides which modules apply, carries every question to the user in chat,
// and passes their answers back as --resolve. The text renderer below exists for debugging only;
// --json is the real interface.
//
// Plan by default, write only with --apply. Every write strategy is non-destructive: a file that
// exists with different content is reported as a decision, never overwritten.
//
//   node bin/apply.mjs --target <dir> --detect
//   node bin/apply.mjs --target <dir> --modules core,design,review,ts [--project name] [--json]
//   node bin/apply.mjs --target <dir> --modules core,design,review,ts --apply

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEVKIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = join(DEVKIT_ROOT, 'modules');
const MANIFEST_PATH = '.claude/toolkit.json';
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.venv', 'venv',
  '__pycache__', 'coverage', '.pytest_cache', 'target', 'vendor',
]);

const MARKERS = {
  html: (m) => [`<!-- devkit:${m}:start -->`, `<!-- devkit:${m}:end -->`],
  hash: (m) => [`# devkit:${m}:start`, `# devkit:${m}:end`],
};

function parseArgs(argv) {
  const args = { target: process.cwd(), modules: [], apply: false, detect: false, json: false, project: '', resolutions: {}, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--detect') args.detect = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--target') args.target = resolve(argv[++i] ?? '.');
    else if (arg === '--project') args.project = argv[++i] ?? '';
    else if (arg === '--modules') args.modules = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--resolve') {
      const [path, action] = (argv[++i] ?? '').split('=');
      if (path && action) args.resolutions[path] = action;
    } else if (arg === '--var') {
      const raw = argv[++i] ?? '';
      const at = raw.indexOf('=');
      if (at > 0) args.vars[raw.slice(0, at)] = raw.slice(at + 1);
    }
  }
  if (!args.project) args.project = args.target.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  return args;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadModules() {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = readJson(join(MODULES_DIR, entry.name, 'module.json'));
      if (!manifest) throw new Error(`modules/${entry.name}/module.json is missing or invalid JSON`);
      return { ...manifest, dir: join(MODULES_DIR, entry.name) };
    });
}

function hasFileWithExtension(dir, ext, budget = { walked: 0 }) {
  if (budget.walked > 5000) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    budget.walked++;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // A nested git repo is a different project, not part of this one. Without this, a folder that
      // merely *contains* several products detects as every stack any of them uses.
      if (existsSync(join(dir, entry.name, '.git'))) continue;
      if (hasFileWithExtension(join(dir, entry.name), ext, budget)) return true;
    } else if (entry.name.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

// Predicates: "file:<path>" | "glob:**/*.<ext>" | "json:<file>#<dotted.key>"
function testPredicate(target, predicate) {
  const [kind, ...rest] = predicate.split(':');
  const value = rest.join(':');
  if (kind === 'file') return existsSync(join(target, value));
  if (kind === 'glob') {
    const match = /^\*\*\/\*(\.[A-Za-z0-9]+)$/.exec(value);
    if (!match?.[1]) return existsSync(join(target, value));
    return hasFileWithExtension(target, match[1]);
  }
  if (kind === 'json') {
    const [file, path] = value.split('#');
    if (!file || !path) return false;
    const doc = readJson(join(target, file));
    if (!doc) return false;
    return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc) !== undefined;
  }
  return false;
}

function detects(target, module) {
  const rule = module.detect ?? {};
  if (rule.always) return true;
  if (Array.isArray(rule.anyOf)) return rule.anyOf.some((p) => testPredicate(target, p));
  return false;
}

function findConflicts(target, module) {
  return (module.conflicts ?? []).filter((path) => existsSync(join(target, path)));
}

function resolveOrder(names, all) {
  const byName = new Map(all.map((m) => [m.name, m]));
  const ordered = [];
  const seen = new Set();
  const visiting = new Set();
  const visit = (name, trail) => {
    if (seen.has(name)) return;
    if (visiting.has(name)) throw new Error(`circular requires: ${[...trail, name].join(' -> ')}`);
    const module = byName.get(name);
    if (!module) throw new Error(`unknown module "${name}"`);
    visiting.add(name);
    for (const dep of module.requires ?? []) visit(dep, [...trail, name]);
    visiting.delete(name);
    seen.add(name);
    ordered.push(module);
  };
  for (const name of names) visit(name, []);
  return ordered;
}

function deepMerge(base, incoming, path, conflicts) {
  if (Array.isArray(base) && Array.isArray(incoming)) {
    const merged = [...base];
    for (const item of incoming) {
      if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) merged.push(item);
    }
    return merged;
  }
  if (isPlainObject(base) && isPlainObject(incoming)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in base ? deepMerge(base[key], value, `${path}.${key}`, conflicts) : value;
    }
    return merged;
  }
  if (JSON.stringify(base) !== JSON.stringify(incoming)) {
    // A dependency range the project already satisfies is not a disagreement. Blocking an install
    // because the target is on ^5.7.2 and the module asks for ^5.7.0 is noise, not safety.
    if (DEPENDENCY_KEY.test(path) && typeof base === 'string' && typeof incoming === 'string' && satisfiesMinimum(base, incoming)) {
      return base;
    }
    conflicts.push({ path, existing: base, incoming });
    return base;
  }
  return base;
}

const DEPENDENCY_KEY = /\.(dependencies|devDependencies|peerDependencies|optionalDependencies)\.[^.]+$/;
const SEMVER = /^([\^~]?)(\d+)\.(\d+)\.(\d+)/;

// True when `existing` already covers everything `wanted` asks for, so keeping it is safe.
// Deliberately narrow: anything it cannot parse or reason about falls through to a conflict.
function satisfiesMinimum(existing, wanted) {
  const a = SEMVER.exec(existing.trim());
  const b = SEMVER.exec(wanted.trim());
  if (!a || !b) return false;
  const [, opA, majA, minA, patA] = a;
  const [, opB, majB, minB, patB] = b;
  if (majA !== majB) return false;
  if (opB === '^' && opA !== '^' && opA !== '') return false;
  if (opB === '~' && opA !== '~' && opA !== '') return false;
  if (opB === '' && opA !== '') return false;
  if (opB === '~' && Number(minA) !== Number(minB)) return false;
  const left = [Number(minA), Number(patA)];
  const right = [Number(minB), Number(patB)];
  return left[0] > right[0] || (left[0] === right[0] && left[1] >= right[1]);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sectionEdit(existing, body, marker, style) {
  const [open, close] = (MARKERS[style] ?? MARKERS.html)(marker);
  const block = `${open}\n${body.trimEnd()}\n${close}`;
  if (existing === null) return { content: `${block}\n`, action: 'create' };
  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  if (start !== -1 && end > start) {
    const replaced = existing.slice(0, start) + block + existing.slice(end + close.length);
    return { content: replaced, action: replaced === existing ? 'unchanged' : 'update-section' };
  }
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${existing}${separator}${block}\n`, action: 'add-section' };
}

// A conflict is only actionable if the user can see what actually differs. "file exists with
// different content" is not a decision they can make; a key-level delta is.
function jsonDelta(theirs, ours) {
  const theirKeys = new Set(Object.keys(theirs ?? {}));
  const ourKeys = new Set(Object.keys(ours ?? {}));
  return {
    missing: [...ourKeys].filter((k) => !theirKeys.has(k)).map((k) => ({ key: k, value: ours[k] })),
    extra: [...theirKeys].filter((k) => !ourKeys.has(k)).map((k) => ({ key: k, value: theirs[k] })),
    differing: [...ourKeys]
      .filter((k) => theirKeys.has(k) && JSON.stringify(theirs[k]) !== JSON.stringify(ours[k]))
      .map((k) => ({ key: k, theirs: theirs[k], ours: ours[k] })),
  };
}

function textDelta(theirs, ours) {
  const theirLines = new Set(theirs.split('\n').map((l) => l.trim()).filter(Boolean));
  const ourLines = ours.split('\n').map((l) => l.trim()).filter(Boolean);
  return { missingLines: ourLines.filter((l) => !theirLines.has(l)).slice(0, 20) };
}

// Forcing `eol=lf` onto a repo whose history is CRLF rewrites every text file the next time anything
// touches them — a several-hundred-file diff that looks like work and is not. Ask first.
// Non-Latin scripts, not "non-ASCII" — accented Latin would flag French and German documentation as
// foreign. Cyrillic, CJK, Greek, Arabic and Hebrew are unambiguous.
const NON_LATIN = /[Ѐ-ӿ一-鿿぀-ヿ؀-ۿ֐-׿Ͱ-Ͽ]/g;

function checkDocLanguage(target, module, check, key, vars) {
  if ((vars.docLanguage ?? 'English') !== 'English') return null;
  let files;
  try {
    files = execFileSync('git', ['-C', target, 'ls-files', '*.md'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
  const foreign = [];
  for (const file of files.slice(0, check.sample ?? 40)) {
    let text;
    try {
      text = readFileSync(join(target, file), 'utf8');
    } catch {
      continue;
    }
    const dense = text.replace(/\s/g, '');
    if (dense.length === 0) continue;
    const share = (text.match(NON_LATIN) ?? []).length / dense.length;
    if (share > (check.minShare ?? 0.05)) foreign.push({ file, share: Number(share.toFixed(2)) });
  }
  if (foreign.length === 0) return null;

  return {
    module: module.name,
    path: key,
    action: 'decision',
    reason: `${foreign.length} of ${files.length} documentation files are written in a non-Latin script; devkit's rules and templates are English`,
    options: ['translate', 'keep'],
    detail: {
      files: foreign.slice(0, 10),
      scope: 'Markdown documentation only — code comments and identifiers are not in scope.',
      note:
        'translate = adopt English; the existing docs are translated as a separate, explicitly confirmed step after install. ' +
        'keep = supply the project language via --var docLanguage=<name>. Note that devkit ships English sections and rewrites them on every upgrade, so a translated devkit section cannot survive — keeping another language means a mixed file.',
    },
  };
}

function checkLineEndings(target, module, check, key, vars) {
  // Once the policy no longer forces LF the conflict is gone, so the question stops being asked —
  // same self-resolving behaviour as supplying a matching commit pattern.
  if (!/eol\s*=\s*lf/i.test(substitute(check.policy ?? '{{eolPolicy}}', vars))) return null;
  let listing;
  try {
    listing = execFileSync('git', ['-C', target, 'ls-files', '--eol'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  let crlf = 0;
  let lf = 0;
  for (const row of listing.split('\n')) {
    const match = /^i\/(\S+)/.exec(row);
    if (!match) continue;
    if (match[1] === 'crlf') crlf++;
    else if (match[1] === 'lf') lf++;
  }
  const tracked = crlf + lf;
  if (tracked === 0) return null;
  if (crlf / tracked < (check.maxCrlfShare ?? 0.2)) return null;

  return {
    module: module.name,
    path: key,
    action: 'decision',
    reason: `${crlf} of ${tracked} tracked text files are committed with CRLF; this module would enforce LF`,
    options: ['keep', 'override', 'merge'],
    detail: {
      trackedTextFiles: tracked,
      crlf,
      lf,
      blastRadius: `${crlf} files would be rewritten end-to-end the next time a formatter or checkout normalises them`,
      note: 'keep = no .gitattributes, repo line endings untouched. override = enforce LF, expect a one-time normalisation commit. merge = supply a softer policy via --var eolPolicy (e.g. "* text=auto" without forcing eol).',
    },
  };
}

function substitute(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

// A rule that contradicts what a repo already does is a decision about *the repo's convention*, not
// about devkit's plumbing — so it needs evidence. Sampling real commit subjects turns "these
// disagree" into "0 of 15 recent commits would pass", which is something a person can actually rule
// on. Same job as the tsconfig delta, different signal.
function planChecks(target, module, vars, resolutions) {
  const out = [];
  for (const check of module.checks ?? []) {
    const key = check.key ?? check.path;

    // Deliberately above the resolution skip: a bare `keep` would silence the question while leaving
    // the installed rule claiming English. Only naming the actual language settles this one.
    if (check.type === 'doc-language') {
      const decision = checkDocLanguage(target, module, check, key, vars);
      if (decision) out.push(decision);
      continue;
    }

    if (resolutions[key] === 'override' || resolutions[key] === 'keep') continue;

    if (check.type === 'line-endings') {
      const decision = checkLineEndings(target, module, check, key, vars);
      if (decision) out.push(decision);
      continue;
    }
    if (check.type !== 'commit-history') continue;

    let subjects;
    try {
      subjects = execFileSync('git', ['-C', target, 'log', '--format=%s', '-n', String(check.sample ?? 20)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      continue;
    }
    if (subjects.length === 0) continue;

    let pattern;
    try {
      pattern = new RegExp(substitute(check.pattern, vars));
    } catch {
      continue;
    }
    const failing = subjects.filter((subject) => !pattern.test(subject));
    const ratio = (subjects.length - failing.length) / subjects.length;
    if (ratio >= (check.minPassRatio ?? 0.5)) continue;

    out.push({
      module: module.name,
      path: key,
      action: 'decision',
      reason: `${subjects.length - failing.length} of ${subjects.length} recent commits match the pattern this module would enforce`,
      options: ['keep', 'override', 'merge'],
      detail: {
        pattern: pattern.source,
        sampled: subjects.length,
        passed: subjects.length - failing.length,
        failingExamples: failing.slice(0, 5),
        note: 'keep = the repo convention wins, module section is not installed. override = the module wins, the repo adopts it. merge = supply a pattern accepting both via --var.',
      },
    });
  }
  return out;
}

// Several modules can target one file in a single run (core and design both own CLAUDE.md sections).
// Planning therefore reads through an overlay of pending writes, not straight from disk — otherwise
// each module plans against the original file and the last write wins.
function readThrough(target, overlay, path) {
  if (overlay.has(path)) return overlay.get(path);
  const absolute = join(target, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

// Wiring an existing config to inherit devkit's base is a decision with consequences: flags the
// project never set start applying, and code that compiled before may stop. Compute the exact delta
// so the choice is informed, and never make it silently.
function planExtendJson(target, module, entry, existing, resolution) {
  const to = entry.to;
  const base = { module: module.name, path: to };
  if (existing === null) return { ...base, action: 'skip', reason: 'no existing config to wire' };

  let doc;
  try {
    doc = JSON.parse(existing);
  } catch {
    return { ...base, action: 'conflict', reason: `${to} is not valid JSON` };
  }

  const wanted = entry.extends;
  const current = doc.extends;
  if (current === wanted || (Array.isArray(current) && current.includes(wanted))) {
    return { ...base, action: 'unchanged' };
  }
  if (resolution === 'keep') return { ...base, action: 'kept', reason: 'resolved: leave as-is' };

  const chained = current === undefined ? wanted : [wanted, ...(Array.isArray(current) ? current : [current])];
  if (resolution === 'extend' || resolution === 'chain') {
    const { extends: _dropped, ...rest } = doc;
    return { ...base, action: 'wired', content: `${JSON.stringify({ extends: chained, ...rest }, null, 2)}\n` };
  }

  const standard = readJson(join(DEVKIT_ROOT, entry.compareWith ?? ''), {});
  const key = entry.compareKey ?? 'compilerOptions';
  const delta = jsonDelta(doc[key] ?? {}, standard[key] ?? {});
  return {
    ...base,
    action: 'decision',
    reason: current === undefined
      ? `${to} does not inherit ${wanted}`
      : `${to} already extends ${JSON.stringify(current)}`,
    options: current === undefined ? ['extend', 'keep'] : ['chain', 'keep'],
    detail: {
      wouldNewlyApply: delta.missing,
      theirsWins: delta.differing,
      strictOnlyInTheirs: delta.extra,
    },
  };
}

function planFile(target, overlay, module, entry, vars, resolutions) {
  const to = entry.to;
  // fromRoot reads straight out of packages/, so the vendored config and the publishable package
  // stay one file. Duplicating them into a module template is exactly the drift devkit exists to stop.
  const source = entry.fromRoot ? join(DEVKIT_ROOT, entry.fromRoot) : entry.from ? join(module.dir, entry.from) : null;
  const template = source ? substitute(readFileSync(source, 'utf8'), vars) : '';
  const existing = readThrough(target, overlay, to);
  // A module may own only part of a shared file, so its decision can be keyed separately from the
  // path — otherwise resolving lefthook.yml for `git` would also silence `ts`.
  const resolution = resolutions[entry.resolutionKey ?? to];

  if (entry.strategy === 'extend-json') return planExtendJson(target, module, entry, existing, resolution);

  if (entry.strategy === 'create') {
    // `keep` is checked before absence: when it resolves a convention decision, the answer is "do not
    // introduce this file at all", not merely "do not overwrite one that happens to exist".
    if (resolution === 'keep') return { module: module.name, path: to, action: 'kept', reason: 'resolved: not installed' };
    if (existing === null) return { module: module.name, path: to, action: 'create', content: template };
    if (existing.replace(/\r\n/g, '\n') === template.replace(/\r\n/g, '\n')) {
      return { module: module.name, path: to, action: 'unchanged' };
    }
    if (resolution === 'override') return { module: module.name, path: to, action: 'override', content: template };

    let detail;
    try {
      detail = jsonDelta(JSON.parse(existing), JSON.parse(template));
    } catch {
      detail = textDelta(existing, template);
    }
    return {
      module: module.name,
      path: to,
      action: 'decision',
      reason: 'file exists with different content',
      options: ['keep', 'override'],
      detail,
    };
  }

  if (entry.strategy === 'section') {
    if (resolution === 'keep') return { module: module.name, path: to, action: 'kept', reason: 'resolved: repo convention wins' };
    const fresh = existing === null;
    const marker = entry.marker ?? module.name;
    const style = entry.markerStyle ?? 'html';
    // Appending a marked block into a structured file can collide with a key that is already there
    // — a second top-level `commit-msg:` is a duplicate YAML key, not an addition. Guard keys turn
    // that into a conflict the user resolves, instead of a silently broken config.
    if (!fresh && !existing.includes(MARKERS[style](marker)[0]) && Array.isArray(entry.guardKeys)) {
      const clash = entry.guardKeys.find((key) =>
        new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(existing),
      );
      if (clash) {
        return { module: module.name, path: to, action: 'conflict', reason: `"${clash}" is already configured outside devkit's markers` };
      }
    }
    const header = fresh && entry.header ? substitute(entry.header, vars) : '';
    const result = sectionEdit(fresh && header ? header : existing, template, marker, style);
    return { module: module.name, path: to, action: fresh ? 'create' : result.action, content: result.content };
  }

  if (entry.strategy === 'merge-json') {
    const incoming = JSON.parse(template);
    if (existing === null) {
      return { module: module.name, path: to, action: 'create', content: `${JSON.stringify(incoming, null, 2)}\n` };
    }
    const base = JSON.parse(existing);
    const conflicts = [];
    const merged = deepMerge(base, incoming, to, conflicts);
    const content = `${JSON.stringify(merged, null, 2)}\n`;
    if (conflicts.length > 0) {
      return { module: module.name, path: to, action: 'conflict', reason: conflicts.map((c) => `${c.path}: has ${JSON.stringify(c.existing)}, wants ${JSON.stringify(c.incoming)}`).join('; ') };
    }
    return { module: module.name, path: to, action: content === existing ? 'unchanged' : 'merge', content };
  }

  throw new Error(`unknown strategy "${entry.strategy}" in module ${module.name}`);
}

function planDependencies(target, overlay, module) {
  if (!module.dependencies) return [];
  const raw = readThrough(target, overlay, 'package.json');
  if (raw === null) {
    return [{ module: module.name, path: 'package.json', action: 'skip', reason: 'no package.json — run your package manager init first' }];
  }
  let existing;
  try {
    existing = JSON.parse(raw);
  } catch {
    return [{ module: module.name, path: 'package.json', action: 'conflict', reason: 'package.json is not valid JSON' }];
  }
  const conflicts = [];
  const merged = deepMerge(existing, module.dependencies, 'package.json', conflicts);
  if (conflicts.length > 0) {
    return [{ module: module.name, path: 'package.json', action: 'conflict', reason: conflicts.map((c) => `${c.path}: has ${JSON.stringify(c.existing)}, wants ${JSON.stringify(c.incoming)}`).join('; ') }];
  }
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  return [{ module: module.name, path: 'package.json', action: content === raw ? 'unchanged' : 'merge', content }];
}

function write(target, action) {
  if (!action.content) return;
  const absolute = join(target, action.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, action.content, 'utf8');
}

function writeManifest(target, modules, version, resolutions, vars) {
  const absolute = join(target, MANIFEST_PATH);
  const previous = readJson(absolute, {});
  const installed = { ...(previous.installed ?? {}) };
  for (const module of modules) installed[module.name] = version;
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    `${JSON.stringify({ toolkit: 'devkit', version, installed, resolutions, vars, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = loadModules();
  const version = readJson(join(DEVKIT_ROOT, 'package.json'), {}).version ?? '0.0.0';

  if (args.detect) {
    const report = all.map((module) => ({
      name: module.name,
      phase: module.phase,
      description: module.description,
      detected: detects(args.target, module),
      conflicts: findConflicts(args.target, module),
    }));
    process.stdout.write(`${JSON.stringify({ target: args.target, version, modules: report }, null, 2)}\n`);
    return 0;
  }

  if (args.modules.length === 0) {
    process.stderr.write('nothing to do: pass --modules a,b,c or --detect\n');
    return 1;
  }

  const selected = resolveOrder(args.modules, all);
  // Recorded decisions carry across runs — that is what makes a second run resume rather than
  // re-ask everything the user already answered.
  const manifest = readJson(join(args.target, MANIFEST_PATH), {}) ?? {};
  const resolutions = { ...(manifest.resolutions ?? {}), ...args.resolutions };
  const chosenVars = { ...(manifest.vars ?? {}), ...args.vars };
  const actions = [];
  const blockers = [];
  const overlay = new Map();

  const record = (action) => {
    if (action.content !== undefined) overlay.set(action.path, action.content);
    actions.push(action);
  };

  for (const module of selected) {
    const vars = { project: args.project, ...(module.vars ?? {}), ...chosenVars };
    for (const path of findConflicts(args.target, module)) {
      blockers.push({ module: module.name, path, reason: 'conflicting tool already configured' });
    }
    for (const action of planChecks(args.target, module, vars, resolutions)) record(action);
    for (const action of planDependencies(args.target, overlay, module)) record(action);
    for (const entry of module.files ?? []) record(planFile(args.target, overlay, module, entry, vars, resolutions));
  }

  const conflicts = actions.filter((a) => a.action === 'conflict');
  const decisions = actions.filter((a) => a.action === 'decision');
  const inert = new Set(['unchanged', 'conflict', 'decision', 'skip', 'kept']);
  const changes = actions.filter((a) => !inert.has(a.action));

  if (args.apply) {
    for (const action of changes) write(args.target, action);
    writeManifest(args.target, selected, version, resolutions, chosenVars);
  }

  const summary = {
    target: args.target,
    version,
    applied: args.apply,
    modules: selected.map((m) => m.name),
    changes: changes.map(({ module, path, action }) => ({ module, path, action })),
    unchanged: actions.filter((a) => a.action === 'unchanged').map(({ module, path }) => ({ module, path })),
    kept: actions.filter((a) => a.action === 'kept').map(({ module, path, reason }) => ({ module, path, reason })),
    skipped: actions.filter((a) => a.action === 'skip').map(({ module, path, reason }) => ({ module, path, reason })),
    decisions: decisions.map(({ module, path, reason, options, detail }) => ({ module, path, reason, options, detail })),
    conflicts: [...conflicts.map(({ module, path, reason }) => ({ module, path, reason })), ...blockers],
    resolutions,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const label = args.apply ? 'applied' : 'plan (nothing written — pass --apply)';
    process.stdout.write(`devkit ${version} → ${relative(process.cwd(), args.target) || '.'} [${label}]\n\n`);
    for (const { module, path, action } of summary.changes) process.stdout.write(`  ${action.padEnd(15)} ${path}  (${module})\n`);
    for (const { path } of summary.unchanged) process.stdout.write(`  ${'unchanged'.padEnd(15)} ${path}\n`);
    for (const { path, reason } of summary.kept) process.stdout.write(`  ${'kept'.padEnd(15)} ${path} — ${reason}\n`);
    for (const { path, reason } of summary.skipped) process.stdout.write(`  ${'skipped'.padEnd(15)} ${path} — ${reason}\n`);
    for (const { path, reason } of summary.conflicts) process.stdout.write(`  ${'CONFLICT'.padEnd(15)} ${path} — ${reason}\n`);
    for (const { path, reason, options } of summary.decisions) {
      process.stdout.write(`  ${'DECISION'.padEnd(15)} ${path} — ${reason}\n${' '.repeat(17)}options: ${options.join(' | ')}\n`);
    }
    process.stdout.write('\n');
  }

  return summary.conflicts.length > 0 || summary.decisions.length > 0 ? 3 : 0;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
