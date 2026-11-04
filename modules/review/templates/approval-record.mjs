const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const isTree = (value) => typeof value === 'string' && TREE_ID.test(value);

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function encodeApproval(tree, files, blocking) {
  return `${JSON.stringify({ tree, files, blocking })}\n`;
}

export function decodeApproval(text) {
  const trimmed = text.trim();
  if (isTree(trimmed)) return { tree: trimmed, files: [], blocking: false };
  const record = parsed(trimmed);
  if (
    isTree(record?.tree) &&
    Array.isArray(record.files) &&
    record.files.every((file) => typeof file === 'string') &&
    typeof record.blocking === 'boolean'
  ) {
    return { tree: record.tree, files: record.files, blocking: record.blocking };
  }
  return null;
}
