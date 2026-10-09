export function compare(found, baseline, { complete }) {
  const over = [];
  const stale = [];
  const checked = new Set();
  for (const [file, comments] of found) {
    checked.add(file);
    const allowed = baseline[file] ?? 0;
    if (comments.length > allowed) over.push({ file, comments, allowed });
    if (comments.length < allowed) stale.push({ file, count: comments.length, allowed });
  }
  if (complete) {
    for (const [file, allowed] of Object.entries(baseline)) {
      if (!checked.has(file) && allowed > 0) stale.push({ file, count: 0, allowed });
    }
  }
  return { over, stale };
}

export function lowered(found, baseline) {
  const entries = found.map(([file, comments]) => {
    const count = comments.length;
    return [file, baseline === null ? count : Math.min(count, baseline[file] ?? 0)];
  });
  return Object.fromEntries(
    entries.filter(([, count]) => count > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
