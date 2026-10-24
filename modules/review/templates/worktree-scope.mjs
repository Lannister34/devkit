import path from 'node:path';

function pathsFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalize(dir, platform) {
  const resolved = pathsFor(platform).resolve(dir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function resolveProjectWorktree(dir, roots, platform, { lstat }) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const paths = pathsFor(platform);
  const sep = paths.sep;
  const candidate = normalize(dir, platform);
  let best = null;
  for (const original of roots) {
    const norm = normalize(original, platform);
    if (candidate === norm || candidate.startsWith(norm + sep)) {
      if (best === null || norm.length > best.norm.length) best = { original, norm };
    }
  }
  if (best === null) return null;
  let current = paths.resolve(best.original);
  const below = paths.relative(current, paths.resolve(dir));
  for (const part of below.split(sep).filter(Boolean)) {
    current = paths.join(current, part);
    let entry;
    try {
      entry = lstat(current);
    } catch {
      return null;
    }
    if (entry.isSymbolicLink()) return null;
    let nested = true;
    try {
      lstat(paths.join(current, '.git'));
    } catch {
      nested = false;
    }
    if (nested) return null;
  }
  return best.original;
}
