export const SCOPE_OPEN = '(';
export const SCOPE_CLOSE = ')';

const LINE_BREAK = /^\r?\n/;
const HERE_STRING_START = /@['"][ \t]*\r?\n/y;

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

export function readSegments(command, shell) {
  const segments = [];
  scan(command, 0, null, segments, SHELL_RULES.get(shell) ?? BASH_RULES);
  return segments;
}
