import { isUncOrDevice, pathResolver } from './path-resolver.mjs';

export const SHELL_BY_TOOL = new Map([
  ['Bash', () => 'bash'],
  ['PowerShell', () => 'powershell'],
  ['Monitor', () => 'bash'],
  ['mcp__terminal__run_in_terminal', (platform) => (platform === 'win32' ? 'powershell' : 'bash')],
]);
const OWN_DIRECTORY_TOOLS = new Set(['mcp__terminal__run_in_terminal']);

function startDirectory(payload, host, resolvePath) {
  if (!OWN_DIRECTORY_TOOLS.has(payload.tool_name)) {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : host.cwd;
    return isUncOrDevice(cwd, host.platform) ? host.cwd : cwd;
  }
  const { cwd, tab_id: tab } = payload.tool_input;
  return tab === undefined && typeof cwd === 'string' ? resolvePath(null, cwd) : null;
}

export function toolCommand(payload, host) {
  const shellFor = SHELL_BY_TOOL.get(payload?.tool_name);
  const input = payload?.tool_input;
  if (shellFor === undefined || typeof input?.command !== 'string') return null;
  const context = { shell: shellFor(host.platform), platform: host.platform, home: host.home };
  context.cwd = startDirectory(payload, host, pathResolver(context));
  return { command: input.command, context };
}
