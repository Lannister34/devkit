import path from 'node:path';

const STATE_NAME = 'devkit-review-state';
const SCOPE_OPEN = '(';
const SCOPE_CLOSE = ')';

export const SHELL_BY_TOOL = new Map([
  ['Bash', 'bash'],
  ['PowerShell', 'powershell'],
]);

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
const DYNAMIC = /[$`]/;
const LINE_BREAK = /^\r?\n/;
const HERE_STRING_START = /@['"][ \t]*\r?\n/y;
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

function wordCollector(out) {
  let words = [];
  let word = null;
  let dropNext = false;
  return {
    add(text) {
      word = (word ?? '') + text;
    },
    endWord() {
      if (word !== null && !dropNext) words.push(word);
      else if (word !== null) dropNext = false;
      word = null;
    },
    endSegment() {
      this.endWord();
      if (words.length > 0) out.push(words);
      words = [];
      dropNext = false;
    },
    atWordStart() {
      return word === null;
    },
    redirect(needsTarget) {
      if (word !== null && /^[\d*]*$/.test(word)) word = null;
      this.endWord();
      dropNext = needsTarget;
    },
  };
}

function lineEnd(src, from) {
  const end = src.indexOf('\n', from);
  return end === -1 ? src.length : end;
}

function scan(src, from, closer, out, rules) {
  const s = { src, i: from, c: '', depth: 0, out, heredocs: [], words: wordCollector(out) };
  while (s.i < src.length) {
    s.c = src[s.i];
    if (s.c === closer && s.depth === 0) {
      s.words.endSegment();
      return s.i + 1;
    }
    const rule = rules.find(([matches]) => matches(s));
    if (rule) rule[1](s);
    else {
      s.words.add(s.c);
      s.i++;
    }
  }
  s.words.endSegment();
  return s.i;
}

function endWord(s) {
  s.words.endWord();
  s.i++;
}

function nesting(s) {
  if (s.c === '(') s.depth++;
  if (s.c === ')') s.depth = Math.max(0, s.depth - 1);
}

function separator(s) {
  s.words.endSegment();
  nesting(s);
  s.i++;
}

function subshell(s) {
  s.words.endSegment();
  if (s.c === '(') s.out.push([SCOPE_OPEN]);
  nesting(s);
  if (s.c === ')') s.out.push([SCOPE_CLOSE]);
  s.i++;
}

function doubleSeparator(s) {
  s.words.endSegment();
  s.i += 2;
}

function blockComment(s) {
  const end = s.src.indexOf('#>', s.i + 2);
  s.i = end === -1 ? s.src.length : end + 2;
}

function lineComment(s) {
  s.i = lineEnd(s.src, s.i);
}

function continuation(s) {
  s.i += s.src[s.i + 1] === '\r' ? 3 : 2;
}

function escaped(s) {
  s.words.add(s.src[s.i + 1] ?? '');
  s.i += 2;
}

function quoted(reader) {
  return (s) => {
    const text = reader(s.src, s.i + 1, s.out);
    s.words.add(text.value);
    s.i = text.end;
  };
}

function scoped(out, inner) {
  out.push([SCOPE_OPEN]);
  const end = inner();
  out.push([SCOPE_CLOSE]);
  return end;
}

function substitution(offset, closer, rules, scopes) {
  return (s) => {
    const inner = () => scan(s.src, s.i + offset, closer, s.out, rules());
    s.i = scopes ? scoped(s.out, inner) : inner();
    s.words.add('$()');
  };
}

function ansiCQuoted(s) {
  let value = '';
  let i = s.i + 2;
  while (i < s.src.length && s.src[i] !== "'") {
    value += s.src[i] === '\\' ? (s.src[i + 1] ?? '') : s.src[i];
    i += s.src[i] === '\\' ? 2 : 1;
  }
  s.words.add(value);
  s.i = i + 1;
}

function redirection(s) {
  let i = s.i + 1;
  if ('<>|'.includes(s.src[i] ?? ' ')) i++;
  const toDescriptor = /^&(\d+|-)/.exec(s.src.slice(i));
  s.words.redirect(toDescriptor === null);
  s.i = i + (toDescriptor?.[0].length ?? (s.src[i] === '&' ? 1 : 0));
}

function heredocStart(s) {
  s.words.endWord();
  let i = s.i + 2;
  const strip = s.src[i] === '-';
  if (strip) i++;
  while (s.src[i] === ' ' || s.src[i] === '\t') i++;
  let delimiter = '';
  for (; i < s.src.length && !/[\s;&|()<>]/.test(s.src[i]); i++) {
    if (!`'"\\`.includes(s.src[i])) delimiter += s.src[i];
  }
  s.heredocs.push({ delimiter, strip });
  s.i = i;
}

function heredocBodies(s) {
  s.words.endSegment();
  let i = s.i + 1;
  for (const { delimiter, strip } of s.heredocs.splice(0)) {
    while (i < s.src.length) {
      const end = lineEnd(s.src, i);
      const line = s.src.slice(i, end).replace(/\r$/, '');
      i = end + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
    }
  }
  s.i = Math.min(i, s.src.length);
}

function bashSingle(src, from) {
  const end = src.indexOf("'", from);
  const stop = end === -1 ? src.length : end;
  return { value: src.slice(from, stop), end: stop + 1 };
}

function bashDoubleStep(src, i, out) {
  if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
    return { text: src[i + 1] === '\n' ? '' : src[i + 1], next: i + 2 };
  }
  if (src.startsWith('$(', i)) {
    return { text: '$()', next: scoped(out, () => scan(src, i + 2, ')', out, BASH_RULES)) };
  }
  if (src[i] === '`') {
    return { text: '$()', next: scoped(out, () => scan(src, i + 1, '`', out, BASH_RULES)) };
  }
  return { text: src[i], next: i + 1 };
}

function bashDouble(src, from, out) {
  let value = '';
  let i = from;
  while (i < src.length && src[i] !== '"') {
    const step = bashDoubleStep(src, i, out);
    value += step.text;
    i = step.next;
  }
  return { value, end: i + 1 };
}

function powerShellSingle(src, from) {
  let value = '';
  let i = from;
  while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) {
    value += src[i];
    i += src[i] === "'" ? 2 : 1;
  }
  return { value, end: i + 1 };
}

function powerShellDouble(src, from, out) {
  let value = '';
  let i = from;
  while (i < src.length && !(src[i] === '"' && src[i + 1] !== '"')) {
    if (src[i] === '`' || src[i] === '"') {
      value += src[i + 1] ?? '';
      i += 2;
    } else if (src.startsWith('$(', i)) {
      i = scan(src, i + 2, ')', out, POWERSHELL_RULES);
      value += '$()';
    } else {
      value += src[i];
      i++;
    }
  }
  return { value, end: i + 1 };
}

function startsHereString(s) {
  HERE_STRING_START.lastIndex = s.i;
  return HERE_STRING_START.test(s.src);
}

function hereString(s) {
  const end = s.src.indexOf(`\n${s.src[s.i + 1]}@`, s.i + 2);
  s.words.add('@here');
  s.i = end === -1 ? s.src.length : end + 3;
}

const blank = (s) => s.c === ' ' || s.c === '\t' || s.c === '\r';
const lineContinues = (marker) => (s) =>
  s.c === marker && LINE_BREAK.test(s.src.slice(s.i + 1, s.i + 3));

const BASH_RULES = [
  [(s) => s.c === '\n', heredocBodies],
  [blank, endWord],
  [(s) => s.c === '#' && s.words.atWordStart(), lineComment],
  [(s) => s.src.startsWith('<<', s.i) && !'<='.includes(s.src[s.i + 2] ?? ' '), heredocStart],
  [(s) => s.c === '<' || s.c === '>', redirection],
  [(s) => ';&|'.includes(s.c), separator],
  [(s) => s.c === '(' || s.c === ')', subshell],
  [lineContinues('\\'), continuation],
  [(s) => s.c === '\\', escaped],
  [(s) => s.src.startsWith("$'", s.i), ansiCQuoted],
  [(s) => s.c === "'", quoted(bashSingle)],
  [(s) => s.c === '"', quoted(bashDouble)],
  [(s) => s.src.startsWith('$(', s.i), substitution(2, ')', () => BASH_RULES, true)],
  [(s) => s.c === '`', substitution(1, '`', () => BASH_RULES, true)],
];

const POWERSHELL_RULES = [
  [startsHereString, hereString],
  [(s) => '\n;|{}()'.includes(s.c), separator],
  [(s) => s.src.startsWith('&&', s.i), doubleSeparator],
  [(s) => s.c === '&' || blank(s), endWord],
  [(s) => s.src.startsWith('<#', s.i), blockComment],
  [(s) => s.c === '#' && s.words.atWordStart(), lineComment],
  [(s) => s.c === '>', redirection],
  [lineContinues('`'), continuation],
  [(s) => s.c === '`', escaped],
  [(s) => s.c === "'", quoted(powerShellSingle)],
  [(s) => s.c === '"', quoted(powerShellDouble)],
  [(s) => s.src.startsWith('$(', s.i), substitution(2, ')', () => POWERSHELL_RULES, false)],
];

const SHELL_RULES = new Map([
  ['bash', BASH_RULES],
  ['powershell', POWERSHELL_RULES],
]);

function pathResolver({ platform, shell, home }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const qualified = platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2})/ : /^\//;
  const translatesDrives = platform === 'win32' && shell === 'bash';
  const native = (raw) => {
    if (/^~[^\\/]/.test(raw)) return null;
    const value = raw.startsWith('~') ? home + raw.slice(1) : raw;
    if (!translatesDrives || !value.startsWith('/')) return value;
    const drive = /^\/([A-Za-z])(\/|$)/.exec(value);
    return drive ? `${drive[1].toUpperCase()}:\\${value.slice(3)}` : null;
  };
  return (from, raw) => {
    const value = DYNAMIC.test(raw) ? null : native(raw);
    if (value === null || (platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(value))) return null;
    if (qualified.test(value)) return paths.resolve(value);
    return from === null ? null : paths.resolve(from, value);
  };
}

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
  const segments = [];
  scan(command, 0, null, segments, SHELL_RULES.get(context.shell) ?? BASH_RULES);
  for (const words of segments) {
    const head = commandHead(words);
    HEAD_EFFECTS[head.kind]?.(state, head, context, resolvePath);
  }
  return state.commits;
}

export function gitRepo({ exec, read, write }) {
  const git = (dir, args) =>
    exec('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  const statePath = (dir) =>
    git(dir, ['rev-parse', '--path-format=absolute', '--git-path', STATE_NAME]);
  const approved = (state) => {
    try {
      return read(state, 'utf8').trim();
    } catch {
      return '';
    }
  };
  return {
    trees(dir) {
      try {
        const staged = git(dir, ['write-tree']);
        return staged ? { staged, approved: approved(statePath(dir)) } : null;
      } catch {
        return null;
      }
    },
    approve(dir) {
      const staged = git(dir, ['write-tree']);
      write(statePath(dir), `${staged}\n`, 'utf8');
      return staged;
    },
  };
}

const REFUSALS = [
  [
    (commit) => commit.unresolved,
    (commit) =>
      `Cannot tell which worktree this commit targets (${commit.unresolved}). ` +
      'Retry it as `git -C <literal path> commit`.',
  ],
  [
    (commit) => commit.stages,
    (commit) =>
      `This commit stages files itself (${commit.stages}), so it would write a tree nobody ` +
      'reviewed. Stage with `git add`, review, then commit without it.',
  ],
  [
    (commit) => commit.skipsHooks,
    () =>
      'This commit skips the git hooks, which run the gates the review approval assumes. ' +
      'Fix what the hooks report instead.',
  ],
];

export function judge(commits, repo, approveScript) {
  return commits.flatMap((commit) => {
    const refusal = REFUSALS.find(([applies]) => applies(commit));
    if (refusal) return [refusal[1](commit)];
    const trees = repo.trees(commit.dir);
    if (trees === null || trees.staged === trees.approved) return [];
    return [
      `The staged tree in ${commit.dir} has not been reviewed.\n\n` +
        'Run the code-review agent on that worktree, fix every blocking finding, and let it ' +
        `record approval:\n  node "${approveScript}" "${commit.dir}"\nThen retry the commit.\n\n` +
        `Staged tree: ${trees.staged}\nLast approved: ${trees.approved || '(none)'}`,
    ];
  });
}
