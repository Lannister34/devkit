import { readSegments, SCOPE_CLOSE, SCOPE_OPEN } from './shell-lexer.mjs';
import { pathResolver } from './path-resolver.mjs';

const PREFIX_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  'time',
  'command',
  'exec',
  'env',
  'nohup',
  'builtin',
  'and',
  'or',
  'not',
]);
const HEAD_KINDS = new Map([
  ['cd', 'cd'],
  ['pushd', 'cd'],
  ['chdir', 'cd'],
  ['set-location', 'cd'],
  ['sl', 'cd'],
  ['push-location', 'cd'],
  ['popd', 'pop'],
  ['pop-location', 'pop'],
  ['export', 'export'],
  ['git', 'git'],
  ['git.exe', 'git'],
  [SCOPE_OPEN, 'push-scope'],
  [SCOPE_CLOSE, 'pop-scope'],
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INDEX_OVERRIDE = /^(?:\$env:)?(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)(?:=|$)/i;
const HOOKS_OVERRIDE = /^(?:\$env:)?GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM|_PARAMETERS)?(?:=|$)/i;
const ENV_OPTIONS_WITH_VALUE = new Set(['-C', '--chdir', '-u', '--unset', '-S', '--split-string']);
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
]);
const COMMIT_LONG_OPTIONS = [
  '--all',
  '--patch',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--reset-author',
  '--short',
  '--branch',
  '--porcelain',
  '--long',
  '--null',
  '--file',
  '--author',
  '--date',
  '--message',
  '--template',
  '--signoff',
  '--no-signoff',
  '--trailer',
  '--no-verify',
  '--verify',
  '--allow-empty',
  '--allow-empty-message',
  '--cleanup',
  '--edit',
  '--no-edit',
  '--amend',
  '--no-post-rewrite',
  '--include',
  '--only',
  '--untracked-files',
  '--verbose',
  '--quiet',
  '--dry-run',
  '--status',
  '--no-status',
  '--gpg-sign',
  '--no-gpg-sign',
  '--pathspec-from-file',
  '--pathspec-file-nul',
  '--interactive',
  '--ahead-behind',
  '--no-ahead-behind',
];
const COMMIT_LONG_WITH_VALUE = new Set([
  '--message',
  '--file',
  '--reuse-message',
  '--reedit-message',
  '--template',
  '--author',
  '--date',
  '--cleanup',
  '--fixup',
  '--squash',
  '--trailer',
  '--pathspec-from-file',
]);
const COMMIT_LONG_STAGING = new Set([
  '--all',
  '--include',
  '--only',
  '--patch',
  '--interactive',
  '--pathspec-from-file',
]);
const COMMIT_SHORT_STAGING = new Set(['a', 'i', 'o', 'p']);
const COMMIT_SHORT_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_SHORT_ATTACHED_VALUE = new Set(['u', 'S']);

function resolveLong(flag) {
  if (COMMIT_LONG_OPTIONS.includes(flag)) return flag;
  const matches = COMMIT_LONG_OPTIONS.filter((option) => option.startsWith(flag));
  return matches.length === 1 ? matches[0] : flag;
}

function longCommitOption(arg, shape) {
  const eq = arg.indexOf('=');
  const flag = resolveLong(eq === -1 ? arg : arg.slice(0, eq));
  if (flag === '--dry-run') shape.dryRun = true;
  if (flag === '--no-verify') shape.skipsHooks = true;
  if (COMMIT_LONG_STAGING.has(flag)) shape.stages ??= flag;
  return eq === -1 && COMMIT_LONG_WITH_VALUE.has(flag) ? 1 : 0;
}

function shortCommitOptions(arg, shape) {
  for (let j = 1; j < arg.length; j++) {
    if (COMMIT_SHORT_STAGING.has(arg[j])) shape.stages ??= `-${arg[j]}`;
    if (arg[j] === 'n') shape.skipsHooks = true;
    if (COMMIT_SHORT_WITH_VALUE.has(arg[j])) return j === arg.length - 1 ? 1 : 0;
    if (COMMIT_SHORT_ATTACHED_VALUE.has(arg[j])) return 0;
  }
  return 0;
}

function commitShape(args) {
  const shape = { stages: null, skipsHooks: false, dryRun: false };
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === '--') {
      if (k + 1 < args.length) shape.stages ??= 'a pathspec';
      break;
    }
    if (arg.startsWith('--')) k += longCommitOption(arg, shape);
    else if (arg.startsWith('-') && arg.length > 1) k += shortCommitOptions(arg, shape);
    else shape.stages ??= 'a pathspec';
  }
  return shape;
}

const GIT_OPTION_EFFECTS = {
  '-C': (call, value, resolvePath) => {
    call.dir = value === undefined ? null : resolvePath(call.dir, value);
    call.unreadable = call.dir === null ? 'a -C path the gate cannot read' : null;
  },
  '-c': (call, value) => {
    if (/^core\.hookspath=/i.test(value ?? '')) call.hooksPath = true;
  },
  '--config-env': (call, value) => {
    if (/^core\.hookspath=/i.test(value ?? '')) call.hooksPath = true;
  },
  '--git-dir': (call) => {
    call.redirected = '--git-dir';
  },
  '--work-tree': (call) => {
    call.redirected = '--work-tree';
  },
};

function readGitOptions(words, call, resolvePath) {
  let i = 0;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const eq = words[i].indexOf('=');
    const inline = words[i].startsWith('--') && eq > 0;
    const flag = inline ? words[i].slice(0, eq) : words[i];
    let value = inline ? words[i].slice(eq + 1) : undefined;
    if (!inline && GIT_OPTIONS_WITH_VALUE.has(flag)) value = words[++i];
    GIT_OPTION_EFFECTS[flag]?.(call, value, resolvePath);
  }
  return i;
}

function commitRecord(call, shape) {
  const unresolved = call.redirected ?? call.unreadable;
  if (unresolved) return { unresolved };
  const commit = { dir: call.dir };
  if (shape.stages) commit.stages = shape.stages;
  if (shape.skipsHooks || call.hooksPath) commit.skipsHooks = true;
  return commit;
}

function gitCommit(words, base, resolvePath) {
  const call = {
    dir: base,
    unreadable: base === null ? 'a directory the gate cannot follow' : null,
    redirected: null,
    hooksPath: false,
  };
  const i = readGitOptions(words, call, resolvePath);
  if (words[i] !== 'commit') return null;
  const shape = commitShape(words.slice(i + 1));
  return shape.dryRun ? null : commitRecord(call, shape);
}

const baseName = (word) => word.toLowerCase().split(/[\\/]/).pop();

function envOptions(words, from, head) {
  let i = from;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    if (words[i] === '--') return i + 1;
    const eq = words[i].indexOf('=');
    const flag = eq === -1 ? words[i] : words[i].slice(0, eq);
    let value = eq === -1 ? undefined : words[i].slice(eq + 1);
    if (eq === -1 && ENV_OPTIONS_WITH_VALUE.has(flag)) value = words[++i];
    if (flag === '-C' || flag === '--chdir') head.chdir = value ?? null;
  }
  return i;
}

function commandHead(words) {
  const head = { assigned: null, configured: false, chdir: undefined };
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ASSIGNMENT.test(word)) {
      head.assigned ??= INDEX_OVERRIDE.exec(word)?.[1] ?? null;
      head.configured ||= HOOKS_OVERRIDE.test(word);
      i++;
    } else if (baseName(word) === 'env') i = envOptions(words, i + 1, head);
    else if (PREFIX_WORDS.has(baseName(word))) i++;
    else break;
  }
  const name = baseName(words[i] ?? '');
  head.kind = name.startsWith('$env:') ? 'export' : HEAD_KINDS.get(name);
  head.args = words.slice(i + 1);
  head.words = words.slice(i);
  return head;
}

function commitBase(state, chdir, resolvePath) {
  if (chdir === undefined) return state.base;
  return chdir === null ? null : resolvePath(state.base, chdir);
}

const HEAD_EFFECTS = {
  export: (state, { words }) => {
    state.override ??= words.map((word) => INDEX_OVERRIDE.exec(word)?.[1]).find(Boolean) ?? null;
    state.hooksEnv ||= words.some((word) => HOOKS_OVERRIDE.test(word));
  },
  cd: (state, { args }, context, resolvePath) => {
    const target = args.find((word) => word === '-' || !word.startsWith('-'));
    if (target === undefined) state.base = context.shell === 'bash' ? context.home : null;
    else state.base = target === '-' ? null : resolvePath(state.base, target);
  },
  pop: (state) => {
    state.base = null;
  },
  'push-scope': (state) => {
    state.scopes.push({ base: state.base, override: state.override, hooksEnv: state.hooksEnv });
  },
  'pop-scope': (state) => {
    const scope = state.scopes.pop();
    if (scope) Object.assign(state, scope);
  },
  git: (state, head, _context, resolvePath) => {
    const commit = gitCommit(head.args, commitBase(state, head.chdir, resolvePath), resolvePath);
    if (commit === null) return;
    const override = head.assigned ?? state.override;
    if (override) state.commits.push({ unresolved: override });
    else if (commit.dir !== undefined && (head.configured || state.hooksEnv)) {
      state.commits.push({ ...commit, skipsHooks: true });
    } else state.commits.push(commit);
  },
};

export function findCommits(command, context) {
  const resolvePath = pathResolver(context);
  const state = { base: context.cwd, override: null, hooksEnv: false, scopes: [], commits: [] };
  for (const words of readSegments(command, context.shell)) {
    const head = commandHead(words);
    HEAD_EFFECTS[head.kind]?.(state, head, context, resolvePath);
  }
  return state.commits;
}
