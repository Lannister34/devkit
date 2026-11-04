import { globMatcher } from './path-glob.mjs';

export const CONFIG_PATH = '.claude/review.json';

const isGlobList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');

export function decodeConfig(text) {
  if (text === null) return null;
  const raw = JSON.parse(text);
  const maxLines = raw?.smallFix?.maxLines;
  if (!Number.isInteger(maxLines) || maxLines < 0) {
    throw new Error(`${CONFIG_PATH}: smallFix.maxLines must be a non-negative integer`);
  }
  for (const [name, value] of [
    ['docs.include', raw.docs?.include],
    ['docs.exclude', raw.docs?.exclude],
    ['alwaysReview', raw.alwaysReview],
  ]) {
    if (!isGlobList(value)) throw new Error(`${CONFIG_PATH}: ${name} must be a list of globs`);
  }
  const included = globMatcher(raw.docs.include);
  const excluded = globMatcher(raw.docs.exclude);
  return {
    maxLines,
    isDoc: (path) => included(path) && !excluded(path),
    alwaysReview: globMatcher(raw.alwaysReview),
  };
}
