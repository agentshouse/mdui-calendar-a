import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { name: { type: 'string' } } });

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

if (git(['status', '--porcelain']) !== '') {
  console.error('npm run publish: commit or discard your changes first; nothing was pushed.');
  process.exit(1);
}

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });

const index = join(git(['rev-parse', '--absolute-git-dir']), 'release-index');
const env = { ...process.env, GIT_INDEX_FILE: index };
rmSync(index, { force: true });
git(['--work-tree=.', 'add', '--all', '--force', '.'], { cwd: 'dist', env });
const tree = git(['write-tree'], { env });
rmSync(index, { force: true });
const release = git(['commit-tree', tree, '-m', `Release of ${git(['rev-parse', 'HEAD'])}`]);

const pushed = spawnSync(
  'git',
  [
    'push',
    '--atomic',
    ...(values.name === undefined ? [] : ['-o', `name=${values.name}`]),
    'origin',
    'HEAD:refs/heads/main',
    `+${release}:refs/heads/release`,
  ],
  { stdio: 'inherit' },
);
process.exit(pushed.status ?? 1);
