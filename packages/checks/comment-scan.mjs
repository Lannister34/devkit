import ts from 'typescript';

export const GATED_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/;

const SCRIPT_KINDS = {
  tsx: ts.ScriptKind.TSX,
  jsx: ts.ScriptKind.JSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
};

const directive = (body) => new RegExp(`^(?:\\/\\/|\\/\\*\\*?)[ \\t]*${body}[^\\n]*$`);

const SCRIPT_ALLOWED = [
  /^\/\/ TODO: \S/,
  directive('@ts-expect-error(?::|[ \\t])[ \\t]*[^\\s*]'),
  /^\/\/\s*@ts-check\s*$/,
  /^\/\/\/\s*<reference (?:path|types|lib|no-default-lib)=/,
  directive('biome-ignore(?:-all|-start|-end)?[ \\t]+[^\\s*]'),
  directive('(?:eslint-(?:disable|enable)|prettier-ignore|(?:c8|v8|istanbul) ignore)\\b'),
  directive('@(?:vitest|jest)-environment[ \\t]+[^\\s*]'),
  directive('@jsx(?:ImportSource|Runtime|Frag)?[ \\t]+[^\\s*]'),
  /^\/\*\s*[#@]__PURE__\s*\*\/$/,
  /^\/\*\s*@vite-ignore\s*\*\/$/,
  /^\/\*\s*webpack[A-Z]\w*:[^\n]*\*\/$/,
];
const JS_TYPE_ANNOTATION = /^\/\*\*\s*@(?:type|satisfies)\s*\{[^\n]*\}\s*\*\/$/;
const STYLE_ALLOWED = [
  /^\/\* TODO: \S[^\n]*\*\/$/,
  /^\/\*[ \t]*(?:biome-ignore(?:-all|-start|-end)?|stylelint-(?:disable|enable)(?:-line|-next-line)?)(?=[ \t:]|\*\/)[^\n]*\*\/$/,
];
const UNQUOTED_URL = /url\([ \t]*[^"'\s)]/iy;

function scriptComments(fileName, text) {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
  const kind = SCRIPT_KINDS[extension] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const leaves = [];
  const jsxTextStarts = new Set();
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextStarts.add(node.pos);
      return;
    }
    const children = node.getChildren(source).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) leaves.push(node);
    for (const child of children) visit(child);
  };
  visit(source);
  const found = new Map();
  const collect = (pos, end) => {
    found.set(pos, text.slice(pos, end));
  };
  for (const leaf of leaves) {
    ts.forEachLeadingCommentRange(text, leaf.pos, collect);
    if (!jsxTextStarts.has(leaf.end)) ts.forEachTrailingCommentRange(text, leaf.end, collect);
  }
  return [...found].map(([pos, body]) => ({ pos, body }));
}

function stringEnd(text, from) {
  let i = from + 1;
  while (i < text.length && text[i] !== text[from] && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function urlEnd(text, from) {
  const close = text.indexOf(')', from);
  return close === -1 ? text.length : close + 1;
}

function startsUnquotedUrl(text, i) {
  if (i > 0 && /\w/.test(text[i - 1])) return false;
  UNQUOTED_URL.lastIndex = i;
  return UNQUOTED_URL.test(text);
}

function styleComments(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"' || text[i] === "'") i = stringEnd(text, i);
    else if (startsUnquotedUrl(text, i)) i = urlEnd(text, i + 4);
    else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push({ pos: i, body: text.slice(i, stop) });
      i = stop;
    } else i++;
  }
  return found;
}

function allowed(fileName, body) {
  if (fileName.endsWith('.css')) return STYLE_ALLOWED.some((pattern) => pattern.test(body));
  if (SCRIPT_ALLOWED.some((pattern) => pattern.test(body))) return true;
  return /\.[cm]?jsx?$/.test(fileName) && JS_TYPE_ANNOTATION.test(body);
}

export function disallowedComments(fileName, text) {
  const comments = fileName.endsWith('.css') ? styleComments(text) : scriptComments(fileName, text);
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return comments
    .filter(({ body }) => !allowed(fileName, body))
    .sort((a, b) => a.pos - b.pos)
    .map(({ pos, body }) => ({
      line: lineStarts.findLastIndex((start) => start <= pos) + 1,
      body,
    }));
}
