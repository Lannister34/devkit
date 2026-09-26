import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findCommits, gitRepo, judge } from '../modules/review/templates/review-gate.mjs';

const TEMPLATES = fileURLToPath(new URL('../modules/review/templates/', import.meta.url));
const HOOK = join(TEMPLATES, 'require-review.mjs');
const APPROVE = join(TEMPLATES, 'approve-review.mjs');

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-gate-')));
after(() => rmSync(sandbox, { recursive: true, force: true }));
writeFileSync(join(sandbox, 'gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
process.env.XDG_CONFIG_HOME = sandbox;
process.env.GIT_CEILING_DIRECTORIES = dirname(sandbox);

const posix = { cwd: '/repo', shell: 'bash', platform: 'linux', home: '/home/me' };
const gitBash = {
  cwd: String.raw`D:\Neuro\app`,
  shell: 'bash',
  platform: 'win32',
  home: String.raw`C:\Users\me`,
};
const powershell = { ...gitBash, shell: 'powershell' };
const unfollowable = { unresolved: 'a directory the gate cannot follow' };
const unreadable = { unresolved: 'a -C path the gate cannot read' };

const readerCases = [
  ['plain commit', 'git commit -m "x"', posix, [{ dir: '/repo' }]],
  [
    'message from a heredoc that mentions other commits',
    `git commit -m "$(cat <<'EOF'
fix(api): a "quoted" word; git -C /other commit -a
EOF
)"`,
    posix,
    [{ dir: '/repo' }],
  ],
  [
    'heredoc body that mentions a commit',
    `cat > notes.md <<'EOF'
then run git commit -am wip
EOF`,
    posix,
    [],
  ],
  [
    'heredoc as the message file',
    `git commit -F - <<'EOF'
feat: x
git commit -a
EOF`,
    posix,
    [{ dir: '/repo' }],
  ],
  ['quoted mention', 'echo "remember to git commit"', posix, []],
  ['single-quoted mention', "echo 'git commit'", posix, []],
  ['ANSI-C quoted mention', "echo $'git commit'", posix, []],
  ['PR body mention', 'gh pr create --title t --body "Run git commit after review"', posix, []],
  ['search for the phrase', "rg 'git commit' docs", posix, []],
  ['shell comment', 'ls # then git commit', posix, []],
  ['line continuation', 'git \\\n  commit -m x', posix, [{ dir: '/repo' }]],
  [
    'escaped quotes inside the message',
    'git commit -m "say \\"git -C /x commit\\""',
    posix,
    [{ dir: '/repo' }],
  ],
  ['quotes glued into one word', `git commit -m 'it'"'"'s'`, posix, [{ dir: '/repo' }]],
  [
    'ANSI-C quoted message, then a second commit',
    "git commit -m $'it\\'s done' && git -C /x commit -m y",
    posix,
    [{ dir: '/repo' }, { dir: '/x' }],
  ],
  ['commit-tree is not commit', 'git commit-tree HEAD^{tree} -m x', posix, []],
  ['a dry run commits nothing', 'git commit --dry-run -a', posix, []],
  ['a dry run after a quoted apostrophe', `git commit -m "fix: don't" --dry-run`, posix, []],
  ['commit inside a command substitution', 'sha=$(git commit -m x)', posix, [{ dir: '/repo' }]],
  ['commit inside backticks', 'sha=`git commit -m x`', posix, [{ dir: '/repo' }]],
  ['commit as an if condition', 'if git commit -m x; then echo ok; fi', posix, [{ dir: '/repo' }]],
  ['commit timed', 'time git commit -m x', posix, [{ dir: '/repo' }]],
  [
    'two commits separated by a semicolon',
    'git commit -m x; git commit --amend --no-edit',
    posix,
    [{ dir: '/repo' }, { dir: '/repo' }],
  ],
  ['-C another worktree', 'git -C ../app_refactor commit -m x', posix, [{ dir: '/app_refactor' }]],
  ['stacked -C', 'git -C /a -C b commit -m x', posix, [{ dir: '/a/b' }]],
  ['stacked -C climbing out', 'git -C /a -C ../b commit -m x', posix, [{ dir: '/b' }]],
  ['-C the home directory', 'git -C ~/wt commit -m x', posix, [{ dir: '/home/me/wt' }]],
  ['cd earlier in the command', 'cd /wt && git add . && git commit -m x', posix, [{ dir: '/wt' }]],
  ['cd with semicolons', 'cd /wt; git add .; git commit -m x', posix, [{ dir: '/wt' }]],
  ['cd home', 'cd ~ && git commit -m x', posix, [{ dir: '/home/me' }]],
  ['bare cd goes home in bash', 'cd && git commit -m x', posix, [{ dir: '/home/me' }]],
  ['pushd', 'pushd /wt && git commit -m x', posix, [{ dir: '/wt' }]],
  ['popd leaves a directory the gate cannot follow', 'pushd /wt && popd && git commit -m x', posix, [unfollowable]],
  ['(cd into a subshell)', '(cd /wt && git commit -m x)', posix, [{ dir: '/wt' }]],
  ['cd then a subshell', 'cd /wt && (git commit -m x)', posix, [{ dir: '/wt' }]],
  [
    'a cd inside a subshell does not leak out',
    '(cd /x && git commit -m y) && git commit -m z',
    posix,
    [{ dir: '/x' }, { dir: '/repo' }],
  ],
  [
    'a cd inside a substitution does not leak out',
    'echo $(cd /x) && git commit -m z',
    posix,
    [{ dir: '/repo' }],
  ],
  ['cd - leaves a directory the gate cannot follow', 'cd - && git commit -m y', posix, [unfollowable]],
  ['cd the gate cannot follow', 'cd "$WT" && git commit -m x', posix, [unfollowable]],
  ['a home directory of another user', 'cd ~bob && git commit -m x', posix, [unfollowable]],
  [
    'Git Bash drive path on Windows',
    'git -C "/d/Neuro/app_refactor" commit -m x',
    gitBash,
    [{ dir: String.raw`D:\Neuro\app_refactor` }],
  ],
  [
    'Git Bash drive path with a space',
    'git -C "/d/Neuro/app with space" commit -m x',
    gitBash,
    [{ dir: String.raw`D:\Neuro\app with space` }],
  ],
  [
    'Git Bash cd to a drive path',
    'cd /d/Neuro/wt && git commit -m x',
    gitBash,
    [{ dir: String.raw`D:\Neuro\wt` }],
  ],
  [
    'Windows path with backslashes in double quotes',
    String.raw`git -C "D:\Neuro\wt" commit -m x`,
    gitBash,
    [{ dir: String.raw`D:\Neuro\wt` }],
  ],
  ['Git Bash path with no drive mapping', 'git -C /tmp/wt commit -m x', gitBash, [unreadable]],
  ['-C the gate cannot read', 'git -C "$WT" commit -m x', posix, [unreadable]],
  ['-C an unquoted variable', 'git -C $WT commit -m x', posix, [unreadable]],
  ['-C a substitution', 'git -C "$(pwd)/wt" commit -m x', posix, [unreadable]],
  ['-C with no path', 'git -C', posix, []],
  ['GIT_DIR on the command', 'GIT_DIR=/x/.git git commit -m x', posix, [{ unresolved: 'GIT_DIR' }]],
  ['GIT_DIR through env', 'env GIT_DIR=/x/.git git commit -m x', posix, [{ unresolved: 'GIT_DIR' }]],
  ['GIT_WORK_TREE on the command', 'GIT_WORK_TREE=/x git commit -m x', posix, [{ unresolved: 'GIT_WORK_TREE' }]],
  [
    'GIT_INDEX_FILE exported earlier',
    'export GIT_INDEX_FILE=/tmp/i && git commit -m x',
    posix,
    [{ unresolved: 'GIT_INDEX_FILE' }],
  ],
  [
    'an unexported assignment never reaches git',
    'GIT_DIR=/x/.git; git commit -m x',
    posix,
    [{ dir: '/repo' }],
  ],
  ['--git-dir option', 'git --git-dir=/x/.git commit -m x', posix, [{ unresolved: '--git-dir' }]],
  ['--work-tree option', 'git --work-tree /x commit -m x', posix, [{ unresolved: '--work-tree' }]],
  ['-am stages at commit time', 'git commit -am "x"', posix, [{ dir: '/repo', stages: '-a' }]],
  ['--all stages at commit time', 'git commit --all -m x', posix, [{ dir: '/repo', stages: '--all' }]],
  ['-i stages at commit time', 'git commit -i src/a.ts -m x', posix, [{ dir: '/repo', stages: '-i' }]],
  ['-o stages at commit time', 'git commit -o src/a.ts -m x', posix, [{ dir: '/repo', stages: '-o' }]],
  ['-p stages at commit time', 'git commit -p -m x', posix, [{ dir: '/repo', stages: '-p' }]],
  ['--interactive stages at commit time', 'git commit --interactive', posix, [{ dir: '/repo', stages: '--interactive' }]],
  [
    '--pathspec-from-file stages at commit time',
    'git commit --pathspec-from-file=list.txt -m x',
    posix,
    [{ dir: '/repo', stages: '--pathspec-from-file' }],
  ],
  [
    'pathspec stages at commit time',
    'git commit src/a.ts -m x',
    posix,
    [{ dir: '/repo', stages: 'a pathspec' }],
  ],
  [
    'pathspec after the double dash',
    'git commit -m x -- src/a.ts',
    posix,
    [{ dir: '/repo', stages: 'a pathspec' }],
  ],
  ['a bare double dash is no pathspec', 'git commit -m x --', posix, [{ dir: '/repo' }]],
  [
    'option values and redirections are not pathspecs',
    'git commit -m wip --author "A <a@b>" 2>&1 >/dev/null',
    posix,
    [{ dir: '/repo' }],
  ],
  ['a redirected log is not a pathspec', 'git commit -m x 2>err.log', posix, [{ dir: '/repo' }]],
  ['a message that looks like a flag', 'git commit -m -n', posix, [{ dir: '/repo' }]],
  [
    'a message attached to its flag',
    'git commit -mam src/a.ts',
    posix,
    [{ dir: '/repo', stages: 'a pathspec' }],
  ],
  ['--no-verify', 'git commit --no-verify -m x', posix, [{ dir: '/repo', skipsHooks: true }]],
  ['-n alone', 'git commit -n -m x', posix, [{ dir: '/repo', skipsHooks: true }]],
  ['-n in a flag cluster', 'git commit -nm x', posix, [{ dir: '/repo', skipsHooks: true }]],
  ['-n as the message text', 'git commit -mn', posix, [{ dir: '/repo' }]],
  [
    'hooks path switched off',
    'git -c core.hooksPath=/dev/null commit -m x',
    posix,
    [{ dir: '/repo', skipsHooks: true }],
  ],
  [
    'hooks path moved elsewhere',
    'git -c core.hooksPath=.husky commit -m x',
    posix,
    [{ dir: '/repo', skipsHooks: true }],
  ],
  ['git -c takes a value', 'git -c user.name=x commit -m y', posix, [{ dir: '/repo' }]],
  ['git --no-pager takes none', 'git --no-pager commit -m y', posix, [{ dir: '/repo' }]],
  [
    'two commits in one command',
    'git -C /a commit -m x && git -C /b commit -m y',
    posix,
    [{ dir: '/a' }, { dir: '/b' }],
  ],
  [
    'PowerShell here-string body',
    `git commit -m @'
feat: x
git commit -a
'@
git -C D:\\wt commit -m y`,
    powershell,
    [{ dir: String.raw`D:\Neuro\app` }, { dir: String.raw`D:\wt` }],
  ],
  ['PowerShell quoted mention', "Write-Output 'git commit'", powershell, []],
  ['PowerShell double-quoted mention', 'Write-Host "git commit"', powershell, []],
  ['PowerShell line comment', '# git commit -m x', powershell, []],
  ['PowerShell block comment', '<# git commit #> Get-ChildItem', powershell, []],
  ['PowerShell unterminated block comment', 'git status <# git commit', powershell, []],
  ['PowerShell dry run', 'git commit --dry-run', powershell, []],
  [
    'PowerShell line continuation',
    'git `\r\n  commit -m x 2>&1 | Out-Null',
    powershell,
    [{ dir: String.raw`D:\Neuro\app` }],
  ],
  ['PowerShell git.exe', 'git.exe commit -m x', powershell, [{ dir: String.raw`D:\Neuro\app` }]],
  ['PowerShell call operator on a bare name', '& git commit -m x', powershell, [{ dir: String.raw`D:\Neuro\app` }]],
  [
    'PowerShell call operator on a quoted path',
    String.raw`& "C:\Program Files\Git\cmd\git.exe" commit -m x`,
    powershell,
    [{ dir: String.raw`D:\Neuro\app` }],
  ],
  [
    'PowerShell Set-Location with a parameter name',
    String.raw`Set-Location -Path D:\Neuro\wt; git commit -m x`,
    powershell,
    [{ dir: String.raw`D:\Neuro\wt` }],
  ],
  [
    'PowerShell cd with a trailing backslash',
    String.raw`cd D:\wt\; git commit -m x`,
    powershell,
    [{ dir: String.raw`D:\wt` }],
  ],
  [
    'PowerShell cd to a single-quoted path with a space',
    String.raw`cd 'D:\My Dir'; git commit -m x`,
    powershell,
    [{ dir: String.raw`D:\My Dir` }],
  ],
  ['PowerShell bare cd is ambiguous', 'cd; git commit -m x', powershell, [unfollowable]],
  ['PowerShell Push-Location', String.raw`Push-Location D:\wt; git commit -m x`, powershell, [{ dir: String.raw`D:\wt` }]],
  ['PowerShell pushd', String.raw`pushd D:\wt; git commit -m x`, powershell, [{ dir: String.raw`D:\wt` }]],
  ['PowerShell Pop-Location', 'Pop-Location; git commit -m x', powershell, [unfollowable]],
  [
    'PowerShell environment override',
    "$env:GIT_DIR = 'D:\\x\\.git'; git commit -m x",
    powershell,
    [{ unresolved: 'GIT_DIR' }],
  ],
  [
    'PowerShell -C a variable',
    'git -C $wt commit -m x',
    powershell,
    [unreadable],
  ],
  [
    'PowerShell parentheses do not scope the location',
    String.raw`(cd D:\wt); git commit -m x`,
    powershell,
    [{ dir: String.raw`D:\wt` }],
  ],
  [
    'PowerShell subexpressions do not scope the location',
    String.raw`$(cd D:\wt); git commit -m x`,
    powershell,
    [{ dir: String.raw`D:\wt` }],
  ],
  [
    'PowerShell GIT_CONFIG_GLOBAL can move the hooks',
    "$env:GIT_CONFIG_GLOBAL = 'D:\\x'; git commit -m x",
    powershell,
    [{ dir: String.raw`D:\Neuro\app`, skipsHooks: true }],
  ],
  ['an abbreviated --no-verify', 'git commit --no-veri -m x', posix, [{ dir: '/repo', skipsHooks: true }]],
  ['an abbreviated --verify keeps the hooks', 'git commit --verif -m x', posix, [{ dir: '/repo' }]],
  ['an abbreviated --patch', 'git commit --patc -m x', posix, [{ dir: '/repo', stages: '--patch' }]],
  [
    'an abbreviated --pathspec-from-file',
    'git commit --pathspec-from-fi=list.txt -m x',
    posix,
    [{ dir: '/repo', stages: '--pathspec-from-file' }],
  ],
  ['an abbreviated --message takes its value', 'git commit --mess "text"', posix, [{ dir: '/repo' }]],
  [
    '--config-env can move the hooks',
    'git --config-env=core.hooksPath=HP commit -m x',
    posix,
    [{ dir: '/repo', skipsHooks: true }],
  ],
  [
    'GIT_CONFIG_* can move the hooks',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    posix,
    [{ dir: '/repo', skipsHooks: true }],
  ],
  [
    'GIT_CONFIG_GLOBAL exported earlier',
    'export GIT_CONFIG_GLOBAL=/x; git commit -m x',
    posix,
    [{ dir: '/repo', skipsHooks: true }],
  ],
  [
    'GIT_CONFIG_GLOBAL exported inside a subshell stays there',
    '(export GIT_CONFIG_GLOBAL=/x); git commit -m x',
    posix,
    [{ dir: '/repo' }],
  ],
  ['env -C changes the directory', 'env -C /wt git commit -m x', posix, [{ dir: '/wt' }]],
  ['env --chdir changes the directory', 'env --chdir=/wt git commit -m x', posix, [{ dir: '/wt' }]],
  ['env -C the gate cannot follow', 'env -C "$WT" git commit -m x', posix, [unfollowable]],
  ['env -u drops one variable, not the commit', 'env -u PAGER git commit -m x', posix, [{ dir: '/repo' }]],
  ['env by its path', '/usr/bin/env git commit -m x', posix, [{ dir: '/repo' }]],
  ['arithmetic is not a heredoc', '(( a <<= 2 ))\ngit commit -m x', posix, [{ dir: '/repo' }]],
];

for (const [name, command, context, expected] of readerCases) {
  test(`reads: ${name}`, () => assert.deepEqual(findCommits(command, context), expected));
}

test('judge passes an approved tree, blocks an unapproved one, and fails open on git errors', () => {
  const trees = {
    '/ok': { staged: 't1', approved: 't1' },
    '/new': { staged: 't2', approved: 't1' },
  };
  const repo = { trees: (dir) => trees[dir] ?? null };
  assert.deepEqual(judge([{ dir: '/ok' }], repo, 'approve.mjs'), []);
  assert.deepEqual(judge([{ dir: '/broken' }], repo, 'approve.mjs'), []);
  const [reason] = judge([{ dir: '/new' }], repo, 'approve.mjs');
  assert.match(reason, /node "approve\.mjs" "\/new"/);
});

test('judge blocks what it cannot judge without asking git', () => {
  const repo = {
    trees: () => {
      throw new Error('git must not be asked');
    },
  };
  const commits = [
    { unresolved: 'GIT_DIR' },
    { dir: '/a', stages: '-a' },
    { dir: '/a', skipsHooks: true },
  ];
  const reasons = judge(commits, repo, 'approve.mjs');
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /git -C <literal path> commit/);
  assert.match(reasons[1], /Stage with `git add`/);
  assert.match(reasons[2], /Fix what the hooks report/);
});

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function repository(name) {
  const dir = join(sandbox, name);
  execFileSync('git', ['init', '-q', dir]);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  return dir;
}

function stage(dir, name) {
  writeFileSync(join(dir, name), `${name}\n`);
  git(dir, 'add', name);
}

test('approval state lives in each worktree git dir, so one worktree never approves another', () => {
  const main = repository('main');
  const linked = join(sandbox, 'linked');
  git(main, 'worktree', 'add', '-q', linked);
  stage(linked, 'a.txt');
  const repo = gitRepo({ exec: execFileSync, read: readFileSync, write: writeFileSync });

  repo.approve(main);
  assert.equal(repo.trees(main).approved, repo.trees(main).staged);
  assert.notEqual(repo.trees(linked).approved, repo.trees(linked).staged);

  repo.approve(linked);
  assert.equal(repo.trees(linked).approved, repo.trees(linked).staged);
  stage(main, 'b.txt');
  assert.notEqual(repo.trees(main).approved, repo.trees(main).staged);
  assert.equal(git(main, 'status', '--porcelain', '--ignored').includes('review-state'), false);
  assert.equal(git(linked, 'status', '--porcelain', '--ignored').includes('review-state'), false);
});

const hook = (payload) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

test('the hook entrypoint fails open on what it cannot read, blocks an unreviewed tree, and honours the approval entrypoint', () => {
  const dir = repository('hooked');
  stage(dir, 'a.txt');
  assert.equal(hook('{not json').status, 0);
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: dir }).status, 0);
  assert.equal(hook(bash('git commit --dry-run', dir)).status, 0);
  assert.equal(hook(bash('git commit -m x', sandbox)).status, 0);

  const blocked = hook(bash('git commit -m x', dir));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /has not been reviewed/);
  assert.match(blocked.stderr, /approve-review\.mjs/);
  const staged = hook(bash('git commit -am x', dir));
  assert.equal(staged.status, 2);
  assert.match(staged.stderr, /stages files itself/);

  const refused = spawnSync(process.execPath, [APPROVE, sandbox], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Approval not recorded/);
  const approved = spawnSync(process.execPath, [APPROVE, dir], { encoding: 'utf8' });
  assert.equal(approved.status, 0);
  assert.match(approved.stdout, /^Approved [0-9a-f]{40} for /);
  assert.equal(hook(bash('git commit -m x', dir)).status, 0);
  const viaPowerShell = { tool_name: 'PowerShell', tool_input: { command: `git -C "${dir}" commit -m x` }, cwd: sandbox };
  assert.equal(hook(viaPowerShell).status, 0);

  stage(dir, 'b.txt');
  assert.equal(hook(bash('git commit -m x', dir)).status, 2);
  assert.equal(hook(viaPowerShell).status, 2);
});
