import { globMatcher } from './path-glob.mjs';

const GATE_FILES = globMatcher(['.claude/**', 'CLAUDE.md']);
const REGULAR_FILE = new Set(['100644', '100755']);

const pass = (reason) => ({ exempt: true, reason });
const refuse = (reason) => ({ exempt: false, reason });

function docOnly(entry, config) {
  const mode = entry.status === 'D' ? entry.oldMode : entry.newMode;
  return (
    config.isDoc(entry.path) &&
    !GATE_FILES(entry.path) &&
    !config.alwaysReview(entry.path) &&
    REGULAR_FILE.has(mode)
  );
}

function smallFixBlocker(entry, config, reviewed) {
  if (GATE_FILES(entry.path) || config.alwaysReview(entry.path)) {
    return `${entry.path} always needs a review`;
  }
  if (entry.status !== 'M') return `${entry.path} is added, deleted, or changed in type`;
  if (entry.oldMode !== entry.newMode || !REGULAR_FILE.has(entry.newMode)) {
    return `${entry.path} changes its file mode`;
  }
  if (!reviewed.has(entry.path)) return `${entry.path} was not in the reviewed diff`;
  if (entry.lines === null) return `${entry.path} is binary`;
  return null;
}

function smallFix(config, approval, sinceApproval) {
  const reviewed = new Set(approval.files);
  let lines = 0;
  for (const entry of sinceApproval) {
    if (docOnly(entry, config)) continue;
    const blocker = smallFixBlocker(entry, config, reviewed);
    if (blocker) return refuse(`not a small fix over the approved tree: ${blocker}`);
    lines += entry.lines;
  }
  if (lines > config.maxLines) {
    return refuse(
      `not a small fix over the approved tree: ${lines} changed lines, ` +
        `over the limit of ${config.maxLines}`,
    );
  }
  return pass(`a small fix over the approved tree: ${lines} of ${config.maxLines} lines`);
}

export function exemption({ config, approval, sinceHead, sinceApproval }) {
  if (sinceHead.length > 0 && sinceHead.every((entry) => docOnly(entry, config))) {
    return pass('a docs-only commit');
  }
  if (approval === null || sinceApproval === null) {
    return refuse('no approval is recorded, so no small fix can be measured against one');
  }
  if (approval.blocking) {
    return refuse(
      'the review found defects, so their fixes pass only once a second round approves them',
    );
  }
  return smallFix(config, approval, sinceApproval);
}
