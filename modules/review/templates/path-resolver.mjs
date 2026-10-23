import path from 'node:path';

const DYNAMIC = /[$`]/;

export function isUncOrDevice(resolved, platform) {
  return platform === 'win32' && typeof resolved === 'string' && /^[\\/]{2}/.test(resolved);
}

export function pathResolver({ platform, shell, home }) {
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
    const resolved = qualified.test(value)
      ? paths.resolve(value)
      : from === null
        ? null
        : paths.resolve(from, value);
    return resolved !== null && isUncOrDevice(resolved, platform) ? null : resolved;
  };
}
