function numstatLines(token) {
  const first = token.indexOf('\t');
  const second = token.indexOf('\t', first + 1);
  const added = token.slice(0, first);
  const deleted = token.slice(first + 1, second);
  const lines = added === '-' || deleted === '-' ? null : Number(added) + Number(deleted);
  return { path: token.slice(second + 1), lines: Number.isInteger(lines) ? lines : null };
}

export function diffEntries(output) {
  const byPath = new Map();
  const entry = (path) => {
    if (!byPath.has(path)) {
      byPath.set(path, { path, status: null, oldMode: null, newMode: null, lines: null });
    }
    return byPath.get(path);
  };
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;
    if (token.startsWith(':')) {
      const [oldMode, newMode, , , status] = token.slice(1).split(' ');
      Object.assign(entry(tokens[i + 1] ?? ''), { oldMode, newMode, status });
      i += 1;
    } else {
      const { path, lines } = numstatLines(token);
      entry(path).lines = lines;
    }
  }
  return [...byPath.values()];
}
