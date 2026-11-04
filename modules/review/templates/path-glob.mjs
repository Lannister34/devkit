const LITERAL = /[.+^${}()|[\]\\]/g;

function toRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(LITERAL, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

export function globMatcher(patterns) {
  const compiled = patterns.map((pattern) => ({
    whole: pattern.includes('/'),
    regex: toRegExp(pattern.replace(/^\//, '')),
  }));
  return (path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return compiled.some(({ whole, regex }) => regex.test(whole ? path : base));
  };
}
