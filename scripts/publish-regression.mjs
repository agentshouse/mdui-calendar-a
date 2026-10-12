import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { command, parseOptions, parseCreationReceipt, safeDiagnostics, validateOrigin, publish } from './publish.mjs'

// All tests are local fixtures. Ignore user/system Git configuration and ensure
// every transport call goes through the mock runner below; never contact House.
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
// npm run executes only the fixture's local Node script. Explicitly disable all
// npm background/update/audit traffic, including on failure and missing-script paths.
process.env.npm_config_offline = 'true'
process.env.npm_config_update_notifier = 'false'
process.env.npm_config_audit = 'false'
process.env.npm_config_fund = 'false'
const build = "const f=require('node:fs');f.mkdirSync('dist',{recursive:true});for(const n of ['app.json','schema.yaml'])f.copyFileSync(n,'dist/'+n);f.writeFileSync('dist/index.html','fixture');"
function fixture(origin = 'https://dev.agents.house/app/a_fixture.git') {
  const cwd = mkdtempSync(join(tmpdir(), 'portable-publisher-test-'))
  const git = args => command('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
  git(['-c', 'init.templateDir=', 'init', '-b', 'main'])
  git(['config', 'user.name', 'Publisher Test']); git(['config', 'user.email', 'publisher@example.invalid'])
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', '/dev/null'])
  writeFileSync(join(cwd, 'app.json'), '{}\n'); writeFileSync(join(cwd, 'schema.yaml'), 'schema: fixture\n')
  writeFileSync(join(cwd, '.gitignore'), 'dist/\n')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: { verify: 'node verify.cjs' } }))
  writeFileSync(join(cwd, 'verify.cjs'), build)
  git(['add', '.']); git(['commit', '-m', 'Fixture']); git(['remote', 'add', 'origin', origin])
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env })
    if (cmd === 'git' && args[0] === 'push') return ''
    if (cmd === 'git' && args[0] === 'ls-remote') return `${git(['rev-parse', 'HEAD'])}\trefs/heads/main\n`
    assert.ok(cmd === 'npm' || cmd === 'git', 'Only local Git and npm fixture commands are allowed')
    assert.ok(cmd !== 'git' || !args.some(arg => /^(fetch|clone|pull|remote-http|remote-https)$/.test(arg)), 'Unexpected transport')
    return command(cmd, args, opts)
  }
  return { cwd, git, calls, run, close: () => rmSync(cwd, { recursive: true, force: true }) }
}
function withFixture(fn, origin) { const f = fixture(origin); try { return fn(f) } finally { f.close() } }
const pushed = f => f.calls.filter(c => c.cmd === 'git' && c.args[0] === 'push')
const verified = f => f.calls.filter(c => c.cmd === 'npm')
const invoke = (f, run = f.run) => publish({ cwd: f.cwd, args: [], run })
const afterVerify = (f, action) => (cmd, args, opts) => { const result = f.run(cmd, args, opts); if (cmd === 'npm') action(); return result }

test('strict optional name matches the documented kit without inventing a default', () => {
  assert.deepEqual(parseOptions([]), {})
  assert.deepEqual(parseOptions(['--name', 'A useful App']), { name: 'A useful App' })
  assert.deepEqual(parseOptions(['--name=Пример']), { name: 'Пример' })
  for (const args of [['--unknown', 'secret'], ['unexpected'], ['--name'], ['--name', 'one', '--name', 'two'], ['--name', ''], ['--name', ' '], ['--name', 'secret\nother'], ['--name', 'secret\0other']]) {
    assert.throws(() => parseOptions(args), error => !/secret/.test(error.message))
  }
})
test('portable URL validation has no fixed-host allowlist', () => {
  for (const host of ['dev.agents.house', 'agents.house', 'my-house.example', 'house2.example:8443', 'localhost', '127.0.0.1:4443', '[::1]:4443']) {
    assert.deepEqual(validateOrigin(`https://${host}/app/a_fixture.git`), { initial: false })
    assert.deepEqual(validateOrigin(`https://${host}/app/new.git`), { initial: true })
  }
  assert.deepEqual(validateOrigin('https://self-hosted.example/app/my-app_2.1.git'), { initial: false })
})
test('unsafe credentials, protocols, URL normalization, and unexpected paths are refused without echo', () => {
  for (const origin of [
    'https://password@dev.agents.house/app/a_fixture.git', 'https://user:password@dev.agents.house/app/a_fixture.git',
    'https://@dev.agents.house/app/a_fixture.git', 'https://dev.agents.house/app/a_fixture.git?token=password',
    'https://dev.agents.house/app/a_fixture.git#password', 'https://dev.agents.house/app/a_fixture.git?',
    'https://dev.agents.house/app/a_fixture.git#', 'https://dev.agents.house/app/%61_fixture.git',
    'http://dev.agents.house/app/a_fixture.git', 'ssh://dev.agents.house/app/a_fixture.git',
    'https://dev.agents.house/extra/app/a_fixture.git', 'https://dev.agents.house/app/../app/a_fixture.git',
    'https://dev.agents.house/app/a_fixture.git/', 'https://dev.agents.house/app/nested/a_fixture.git',
    'https://dev.agents.house\\app\\a_fixture.git', 'https://dev.agents.house/app/.git',
    'https://dev.agents.house:bad/app/a_fixture.git', 'https://dev.agents.house/app/a fixture.git',
    ' https://dev.agents.house/app/a_fixture.git', 'https://dev.agents.house/app/a_fixture.git\n',
  ]) assert.throws(() => validateOrigin(origin), error => !/password/.test(error.message), origin)
})
test('exact verify, atomic source SHA, parentless root dist, original source/index unchanged', () => withFixture(f => {
  const source = f.git(['rev-parse', 'HEAD']); const index = readFileSync(join(f.cwd, '.git/index'))
  const result = invoke(f)
  assert.equal(result.main, source); assert.equal(result.mainAdvertised, true)
  assert.deepEqual(pushed(f)[0].args, ['push', '--atomic', '--no-follow-tags', '--recurse-submodules=no', 'https://dev.agents.house/app/a_fixture.git', `${source}:refs/heads/main`, `+${result.release}:refs/heads/release`])
  assert.equal(pushed(f)[0].env.GIT_ALLOW_PROTOCOL, 'https')
  assert.equal(f.git(['rev-list', '--parents', '-n', '1', result.release]), result.release)
  assert.equal(f.git(['ls-tree', '-r', '--name-only', result.release]), 'app.json\nindex.html\nschema.yaml')
  assert.equal(f.git(['show', `${result.release}:app.json`]), f.git(['show', `${source}:app.json`]))
  assert.equal(f.git(['rev-parse', 'HEAD']), source); assert.ok(readFileSync(join(f.cwd, '.git/index')).equals(index))
  assert.equal(f.git(['rev-parse', 'refs/heads/release']), result.release)
  assert.deepEqual(verified(f).map(call => call.args), [['run', 'verify']])
  const staging = f.calls.find(call => call.args.includes('--work-tree=.'))
  assert.notEqual(staging.env.GIT_INDEX_FILE, join(f.cwd, '.git/index'))
  assert.equal(existsSync(staging.env.GIT_INDEX_FILE), false)
  assert.equal(existsSync(join(f.cwd, '.git/template-publish.lock')), false)
  assert.match(result.admission, /Not verified/)
}))
test('new.git accepts existing history, does not probe, guess identity, name, or rewrite origin', () => withFixture(f => {
  writeFileSync(join(f.cwd, 'history.txt'), 'second source commit'); f.git(['add', '.']); f.git(['commit', '-m', 'Existing history'])
  const result = invoke(f)
  assert.equal(f.git(['rev-list', '--count', result.main]), '2')
  assert.equal(result.initialOrigin, true); assert.equal(result.mainAdvertised, false)
  assert.equal(f.calls.some(c => c.args[0] === 'ls-remote'), false)
  assert.equal(f.calls.some(c => c.args.includes('-o')), false)
  assert.equal(f.git(['remote', 'get-url', 'origin']), 'https://dev.agents.house/app/new.git')
  assert.equal(result.creationReceipt.status, 'missing')
  assert.match(result.next, /actual created App remote/)
}, 'https://dev.agents.house/app/new.git'))
test('dirty source blocks before verify/push and never resets or stashes', () => withFixture(f => {
  writeFileSync(join(f.cwd, 'untracked.txt'), 'keep')
  assert.throws(() => invoke(f), /Commit or remove source changes/)
  assert.equal(pushed(f).length, 0); assert.equal(verified(f).length, 0)
  assert.equal(readFileSync(join(f.cwd, 'untracked.txt'), 'utf8'), 'keep')
  assert.equal(f.calls.some(c => ['reset', 'stash'].includes(c.args[0])), false)
}))
test('staged source changes block without modifying the index', () => withFixture(f => {
  writeFileSync(join(f.cwd, 'app.json'), '{"staged":true}'); f.git(['add', 'app.json'])
  const index = readFileSync(join(f.cwd, '.git/index'))
  assert.throws(() => invoke(f), /Commit or remove source changes/)
  assert.ok(readFileSync(join(f.cwd, '.git/index')).equals(index)); assert.equal(pushed(f).length, 0)
}))
test('non-main and detached source are refused before verification', () => withFixture(f => {
  f.git(['switch', '-c', 'other']); assert.throws(() => invoke(f), /requires the main branch/)
  f.git(['switch', '--detach']); assert.throws(() => invoke(f), /before push/)
  assert.equal(verified(f).length, 0); assert.equal(pushed(f).length, 0)
}))
test('running outside the repository root is refused', () => withFixture(f => {
  const cwd = join(f.cwd, 'subdir'); mkdirSync(cwd)
  assert.throws(() => publish({ cwd, args: [], run: f.run }), /repository root/)
  assert.equal(pushed(f).length, 0)
}))
test('multiple push destinations rejected', () => withFixture(f => {
  f.git(['remote', 'set-url', '--add', '--push', 'origin', 'https://dev.agents.house/app/a_first.git'])
  f.git(['remote', 'set-url', '--add', '--push', 'origin', 'https://dev.agents.house/app/a_second.git'])
  assert.throws(() => invoke(f), /Exactly one/); assert.equal(pushed(f).length, 0)
}))
test('verify failure never falls back to build or pushes', () => withFixture(f => {
  writeFileSync(join(f.cwd, 'verify.cjs'), 'process.exit(7)'); f.git(['add', '.']); f.git(['commit', '-m', 'Fail verify'])
  assert.throws(() => invoke(f), /npm run verify failed \(exit 7\)/)
  assert.deepEqual(verified(f).map(call => call.args), [['run', 'verify']]); assert.equal(pushed(f).length, 0)
}))
test('missing verify script produces useful diagnostic instead of build fallback', () => withFixture(f => {
  writeFileSync(join(f.cwd, 'package.json'), '{"scripts":{"build":"node verify.cjs"}}'); f.git(['add', '.']); f.git(['commit', '-m', 'No verify'])
  assert.throws(() => invoke(f), /must define the exact verify script/)
  assert.equal(pushed(f).length, 0)
}))
test('dist metadata mismatch blocks push', () => withFixture(f => {
  assert.throws(() => invoke(f, afterVerify(f, () => writeFileSync(join(f.cwd, 'dist/app.json'), 'wrong'))), /Built app.json differs/)
  assert.equal(pushed(f).length, 0)
}))
test('missing dist metadata produces precise safe failure', () => withFixture(f => {
  assert.throws(() => invoke(f, afterVerify(f, () => rmSync(join(f.cwd, 'dist/schema.yaml')))), /Built schema.yaml is missing/)
  assert.equal(pushed(f).length, 0)
}))
test('source mutation during verify is preserved and blocks push', () => withFixture(f => {
  assert.throws(() => invoke(f, afterVerify(f, () => writeFileSync(join(f.cwd, 'app.json'), 'changed'))), /before push/)
  assert.equal(pushed(f).length, 0); assert.equal(readFileSync(join(f.cwd, 'app.json'), 'utf8'), 'changed')
}))
test('HEAD change during verify blocks exact-source publication', () => withFixture(f => {
  assert.throws(() => invoke(f, afterVerify(f, () => f.git(['commit', '--allow-empty', '-m', 'Concurrent commit']))), /Source HEAD changed/)
  assert.equal(pushed(f).length, 0)
}))
test('branch change during verify blocks publication even at the same source', () => withFixture(f => {
  assert.throws(() => invoke(f, afterVerify(f, () => f.git(['switch', '-c', 'other']))), /Branch changed/)
  assert.equal(pushed(f).length, 0)
}))
test('credential-bearing origin mutations cannot leak through assertions', () => withFixture(f => {
  const run = afterVerify(f, () => f.git(['remote', 'set-url', 'origin', 'https://password@dev.agents.house/app/a_fixture.git']))
  assert.throws(() => invoke(f, run), error => /before push/.test(error.message) && !error.message.includes('password'))
  assert.equal(pushed(f).length, 0)
}))
test('untrusted runner errors are secret-safe and retain the failed stage', () => withFixture(f => {
  const run = (cmd, args, opts) => { if (cmd === 'npm') throw new Error('https://password@host/ token=secret'); return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), error => /npm run verify step failed/.test(error.message) && !/password|secret/.test(error.message))
  assert.equal(pushed(f).length, 0)
}))
test('failed push is unconfirmed and cannot leak a runner error', () => withFixture(f => {
  const run = (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'push') throw new Error('https://password@host/ accepted maybe'); return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), error => /unconfirmed/.test(error.message) && !error.message.includes('password'))
  assert.equal(f.calls.some(c => c.args[0] === 'ls-remote'), false)
}))
test('failed new.git push never triggers a probe or retry', () => withFixture(f => {
  let attempts = 0
  const run = (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'push') { attempts++; throw new Error('timeout') } return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), /especially for new.git/)
  assert.equal(attempts, 1); assert.equal(f.calls.some(c => c.args[0] === 'ls-remote'), false)
}, 'https://dev.agents.house/app/new.git'))
test('accepted push then advertised-main mismatch is explicitly post-push uncertainty', () => withFixture(f => {
  const run = (cmd, args, opts) => cmd === 'git' && args[0] === 'ls-remote' ? 'wrong\trefs/heads/main\n' : f.run(cmd, args, opts)
  assert.throws(() => invoke(f, run), /was accepted.*Advertised main did not match/); assert.equal(pushed(f).length, 1)
}))
test('accepted push then advertisement error is not reported as push failure', () => withFixture(f => {
  const run = (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'ls-remote') throw new Error('credentials'); return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), error => /was accepted.*advertised main check/.test(error.message) && !/credentials/.test(error.message))
  assert.equal(pushed(f).length, 1)
}))
test('accepted push then local ref failure preserves publication uncertainty', () => withFixture(f => {
  const run = (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'update-ref') throw new Error('ref failure'); return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), /was accepted.*local release ref update/)
  assert.equal(pushed(f).length, 1)
}))
test('existing publisher lock is never deleted', () => withFixture(f => {
  const lock = join(f.cwd, '.git/template-publish.lock'); writeFileSync(lock, 'other process')
  assert.throws(() => invoke(f), /Publisher lock unavailable/)
  assert.equal(readFileSync(lock, 'utf8'), 'other process'); assert.equal(pushed(f).length, 0)
}))
test('publisher lock and temporary release index are cleaned after failure', () => withFixture(f => {
  const run = (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'commit-tree') throw new Error('failed'); return f.run(cmd, args, opts) }
  assert.throws(() => invoke(f, run), /isolated release preparation/)
  assert.equal(existsSync(join(f.cwd, '.git/template-publish.lock')), false)
  const staging = f.calls.find(call => call.args.includes('--work-tree=.'))
  assert.equal(existsSync(staging.env.GIT_INDEX_FILE), false); assert.equal(pushed(f).length, 0)
}))
test('missing author identity fails early with repository-local fix advice', () => withFixture(f => {
  f.git(['config', '--unset', 'user.name']); f.git(['config', '--unset', 'user.email']); f.git(['config', 'user.useConfigOnly', 'true'])
  assert.throws(() => invoke(f), /repository-local user.name and user.email/)
  assert.equal(verified(f).length, 0); assert.equal(pushed(f).length, 0)
}))
test('symlink metadata is refused without pushing', () => withFixture(f => {
  const run = afterVerify(f, () => { rmSync(join(f.cwd, 'dist/app.json')); symlinkSync('../app.json', join(f.cwd, 'dist/app.json')) })
  assert.throws(() => invoke(f, run), /regular file, not a symlink/); assert.equal(pushed(f).length, 0)
}))
test('assume-unchanged source entries cannot conceal uncommitted metadata', () => withFixture(f => {
  f.git(['update-index', '--assume-unchanged', 'app.json']); writeFileSync(join(f.cwd, 'app.json'), '{"hidden":true}')
  assert.throws(() => invoke(f), /assume-unchanged or skip-worktree/); assert.equal(pushed(f).length, 0)
}))
test('skip-worktree source entries cannot conceal uncommitted metadata', () => withFixture(f => {
  f.git(['update-index', '--skip-worktree', 'app.json']); writeFileSync(join(f.cwd, 'app.json'), '{"hidden":true}')
  assert.throws(() => invoke(f), /assume-unchanged or skip-worktree/); assert.equal(pushed(f).length, 0)
}))
test('inherited alternate index is refused without changing it', () => withFixture(f => {
  const alternate = join(f.cwd, '.git/alternate'); writeFileSync(alternate, 'keep')
  process.env.GIT_INDEX_FILE = alternate
  try { assert.throws(() => invoke(f), /Unset GIT_INDEX_FILE/) } finally { Reflect.deleteProperty(process.env, 'GIT_INDEX_FILE') }
  assert.equal(readFileSync(alternate, 'utf8'), 'keep'); assert.equal(pushed(f).length, 0)
}))
test('command diagnostics hide URL secrets and expose actionable known errors', () => {
  assert.throws(() => command(process.execPath, ['-e', "console.error('Author identity unknown https://password@host/?token=secret');process.exit(1)"], { stage: 'Identity check' }), error =>
    /Identity check failed.*repository-local user.name/.test(error.message) && !/password|secret/.test(error.message))
  assert.throws(() => command(process.execPath, ['-e', "console.log('token=secret');console.error('HTTP 502 password');process.exit(2)"], { stage: 'Atomic push' }), error =>
    /exit 2.*temporary HTTP 5xx/.test(error.message) && !/password|secret/.test(error.message))
})
test('safe known compiler/auth/atomic/rejection errors are not collapsed into a generic failure', () => {
  const hints = safeDiagnostics('error TS2322: secret\nfatal: Authentication failed for https://password@host/\nfatal: remote does not support --atomic push\nrejected non-fast-forward\nremote rejected (pre-receive hook declined)')
  assert.ok(hints.some(hint => hint.includes('TS2322')))
  assert.ok(hints.some(hint => hint.includes('authentication')))
  assert.ok(hints.some(hint => hint.includes('atomic')))
  assert.ok(hints.some(hint => hint.includes('non-fast-forward')))
  assert.ok(hints.some(hint => hint.includes('admission')))
  assert.equal(hints.some(hint => /password|secret/.test(hint)), false)
})
test('command timeout remains distinguishable and does not leak output', () => {
  assert.throws(() => command(process.execPath, ['-e', "console.error('secret');setTimeout(()=>{},2000)"], { timeout: 10, stage: 'Test timeout' }), error => /timed out/.test(error.message) && !/secret/.test(error.message))
})
test('missing executable gets a useful safe error', () => {
  assert.throws(() => command('/no/such/publisher-executable', []), /executable not found/)
})
test('release clean filters cannot change committed metadata unnoticed', () => withFixture(f => {
  const run = (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('--work-tree=.')) {
      mkdirSync(join(f.cwd, '.git/info'), { recursive: true })
      writeFileSync(join(f.cwd, '.git/info/attributes'), 'app.json filter=mutate\n')
      f.git(['config', 'filter.mutate.clean', 'sed s/{/changed{/'])
    }
    return f.run(cmd, args, opts)
  }
  assert.throws(() => invoke(f, run), /Release-tree app.json differs/)
  assert.equal(pushed(f).length, 0)
}))
test('raw alias origin is refused even when Git rewrites it to a valid House URL', () => withFixture(f => {
  f.git(['config', 'url.https://dev.agents.house/app/.insteadOf', 'alias:'])
  f.git(['remote', 'set-url', 'origin', 'alias:a_fixture.git'])
  assert.throws(() => invoke(f), /Origin must be an HTTPS/); assert.equal(pushed(f).length, 0)
}))
test('HTTPS origin rewrite is refused before push', () => withFixture(f => {
  f.git(['config', 'url.http://alternate.example/other/.insteadOf', 'https://dev.agents.house/app/'])
  assert.throws(() => invoke(f), /Origin URL rewriting is configured/); assert.equal(pushed(f).length, 0)
}))
test('explicit push URL is allowed when raw/effective target is identical', () => withFixture(f => {
  f.git(['remote', 'set-url', '--push', 'origin', 'https://dev.agents.house/app/a_push_target.git'])
  const result = invoke(f)
  assert.equal(result.pushAccepted, true)
  assert.ok(pushed(f)[0].args.includes('https://dev.agents.house/app/a_push_target.git'))
}))
test('inherited tag and submodule push settings are explicitly disabled', () => withFixture(f => {
  f.git(['config', 'push.followTags', 'true']); f.git(['config', 'push.recurseSubmodules', 'on-demand'])
  invoke(f)
  assert.ok(pushed(f)[0].args.includes('--no-follow-tags'))
  assert.ok(pushed(f)[0].args.includes('--recurse-submodules=no'))
  assert.equal(pushed(f)[0].args.filter(arg => arg.includes(':refs/heads/')).length, 2)
}))
test('symbolic release ref cannot overwrite source main', () => withFixture(f => {
  const source = f.git(['rev-parse', 'HEAD'])
  f.git(['symbolic-ref', 'refs/heads/release', 'refs/heads/main'])
  const result = invoke(f)
  assert.equal(f.git(['rev-parse', 'HEAD']), source)
  assert.equal(f.git(['rev-parse', 'refs/heads/main']), source)
  assert.equal(f.git(['rev-parse', 'refs/heads/release']), result.release)
  assert.equal(readFileSync(join(f.cwd, '.git/refs/heads/release'), 'utf8').trim(), result.release)
}))
test('release checked out in another worktree is refused before verify and push', () => withFixture(f => {
  const worktree = mkdtempSync(join(tmpdir(), 'publisher-release-worktree-'))
  try {
    f.git(['worktree', 'add', '-b', 'release', worktree])
    assert.throws(() => invoke(f), /release branch is checked out in a worktree/)
    assert.equal(verified(f).length, 0); assert.equal(pushed(f).length, 0)
    f.git(['worktree', 'remove', worktree])
  } finally { rmSync(worktree, { recursive: true, force: true }) }
}))
test('raw origin whitespace is rejected rather than silently normalized', () => withFixture(f => {
  f.git(['config', 'remote.origin.url', ' https://dev.agents.house/app/a_fixture.git '])
  assert.throws(() => invoke(f), /Origin must be an HTTPS/); assert.equal(pushed(f).length, 0)
}))
test('source checks disable object replacement and override submodule-ignore config', () => withFixture(f => {
  invoke(f)
  for (const call of f.calls) assert.equal(call.env.GIT_NO_REPLACE_OBJECTS, '1')
  for (const call of f.calls.filter(call => call.args[0] === 'status')) assert.ok(call.args.includes('--ignore-submodules=none'))
}))
test('nested repository in dist cannot become a gitlink release', () => withFixture(f => {
  const run = afterVerify(f, () => {
    const cwd = join(f.cwd, 'dist/nested'); mkdirSync(cwd)
    const git = args => command('git', args, { cwd })
    git(['-c', 'init.templateDir=', 'init', '-b', 'main'])
    git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
    writeFileSync(join(cwd, 'index.html'), 'nested')
    git(['add', '.']); git(['commit', '-m', 'Nested fixture'])
  })
  assert.throws(() => invoke(f, run), /nested Git repository or submodule/)
  assert.equal(pushed(f).length, 0)
}))
test('named creation forwards exactly the official name push option', () => withFixture(f => {
  const result = publish({ cwd: f.cwd, args: ['--name', 'A useful App'], run: f.run })
  assert.deepEqual(pushed(f)[0].args, ['push', '--atomic', '--no-follow-tags', '--recurse-submodules=no', '-o', 'name=A useful App', 'https://dev.agents.house/app/new.git', `${result.main}:refs/heads/main`, `+${result.release}:refs/heads/release`])
  assert.equal(f.calls.some(c => c.args[0] === 'ls-remote'), false)
}, 'https://dev.agents.house/app/new.git'))
test('receipt retains only exact printed App and canonical Git URLs', () => {
  const receipt = parseCreationReceipt('remote: App: https://dev.agents.house/app/a_created\nremote: Git: https://dev.agents.house/app/a_created.git\nTo https://dev.agents.house/app/new.git')
  assert.deepEqual(receipt, {
    status: 'reported', appURLs: ['https://dev.agents.house/app/a_created'], gitURLs: ['https://dev.agents.house/app/a_created.git'],
    appURL: 'https://dev.agents.house/app/a_created', gitURL: 'https://dev.agents.house/app/a_created.git',
  })
})
test('receipt parsing stays portable across hosts and deduplicates printed addresses', () => {
  const app = 'https://self-hosted.example:8443/app/a_created'; const git = `${app}.git`
  const receipt = parseCreationReceipt(`App: ${app}\nGit: ${git}\nGit again: ${git}`)
  assert.equal(receipt.status, 'reported'); assert.equal(receipt.gitURL, git); assert.equal(receipt.gitURLs.length, 1)
})
test('receipt never strips secrets or unexpected URL content into a safe-looking address', () => {
  const receipt = parseCreationReceipt([
    'https://password@dev.agents.house/app/a_created.git',
    'https://@dev.agents.house/app/a_created.git',
    'https://dev.agents.house/app/a_created.git?token=secret',
    'https://dev.agents.house/app/a_created#secret',
    'http://dev.agents.house/app/a_created.git',
    'https://dev.agents.house/app/%61_created.git',
    'https://dev.agents.house/app/new',
    'https://dev.agents.house/app/new.git',
    'https://dev.agents.house/other/a_created.git',
    "https://dev.agents.house/app/a_created'?token=secret",
    "https://dev.agents.house/app/a_created.git'?token=secret",
    'https://dev.agents.house/app/a_created)?token=secret',
    'https://dev.agents.house/app/a_created.git)?token=secret',
    'https://dev.agents.house/app/a_created"?token=secret',
    'https://dev.agents.house/app/a_created.git"?token=secret',
  ].join('\n'))
  assert.deepEqual(receipt, { status: 'missing', appURLs: [], gitURLs: [] })
})
test('receipt strips only balanced outer wrappers around complete URL tokens', () => {
  const receipt = parseCreationReceipt("App: 'https://dev.agents.house/app/a_created'\nGit: <https://dev.agents.house/app/a_created.git>")
  assert.equal(receipt.status, 'reported')
  const unsafe = parseCreationReceipt("App: 'https://dev.agents.house/app/a_created'?token=secret\nGit: <https://dev.agents.house/app/a_created.git>?token=secret")
  assert.equal(unsafe.status, 'missing')
})
test('incomplete and conflicting receipts retain evidence without guessing a counterpart', () => {
  const one = parseCreationReceipt('https://dev.agents.house/app/a_created.git')
  assert.equal(one.status, 'incomplete-or-ambiguous'); assert.equal(one.appURL, undefined); assert.equal(one.gitURL, undefined)
  assert.deepEqual(one.appURLs, []); assert.deepEqual(one.gitURLs, ['https://dev.agents.house/app/a_created.git'])
  const conflict = parseCreationReceipt('https://dev.agents.house/app/a_one\nhttps://dev.agents.house/app/a_two.git')
  assert.equal(conflict.status, 'incomplete-or-ambiguous'); assert.equal(conflict.gitURL, undefined)
})
test('command captures safe receipt evidence from both stdout and stderr', () => {
  let receipt
  command(process.execPath, ['-e', "console.log('App: https://dev.agents.house/app/a_created');console.error('Git: https://dev.agents.house/app/a_created.git');console.error('token=secret')"], { captureOutput: output => { receipt = parseCreationReceipt(output) } })
  assert.equal(receipt.status, 'reported'); assert.equal(JSON.stringify(receipt).includes('secret'), false)
})
test('creation returns server receipt and never mutates or probes new.git', () => withFixture(f => {
  const run = (cmd, args, opts) => {
    const result = f.run(cmd, args, opts)
    if (cmd === 'git' && args[0] === 'push') opts.captureOutput('remote: App: https://dev.agents.house/app/a_created\nremote: Git: https://dev.agents.house/app/a_created.git\ntoken=secret')
    return result
  }
  const result = invoke(f, run)
  assert.equal(result.creationReceipt.status, 'reported')
  assert.equal(result.creationReceipt.gitURL, 'https://dev.agents.house/app/a_created.git')
  assert.match(result.next, /set origin to that exact gitURL/)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(f.git(['remote', 'get-url', 'origin']), 'https://dev.agents.house/app/new.git')
  assert.equal(f.calls.some(call => call.args[0] === 'ls-remote'), false)
}, 'https://dev.agents.house/app/new.git'))
test('creation receipt is also parsed from runner stdout without callback support', () => withFixture(f => {
  const run = (cmd, args, opts) => {
    const result = f.run(cmd, args, opts)
    return cmd === 'git' && args[0] === 'push' ? 'https://dev.agents.house/app/a_created\nhttps://dev.agents.house/app/a_created.git' : result
  }
  assert.equal(invoke(f, run).creationReceipt.status, 'reported')
}, 'https://dev.agents.house/app/new.git'))
test('failed creation push preserves safe reported addresses without asserting success', () => withFixture(f => {
  const run = (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'push') {
      opts.captureOutput('https://dev.agents.house/app/a_created\nhttps://dev.agents.house/app/a_created.git\nhttps://password@host/app/a_secret.git')
      throw new Error('secret transport failure')
    }
    return f.run(cmd, args, opts)
  }
  assert.throws(() => invoke(f, run), error => /unconfirmed/.test(error.message) && /https:\/\/dev.agents.house\/app\/a_created.git/.test(error.message) && !/password|secret/.test(error.message))
  assert.equal(f.calls.some(call => call.args[0] === 'ls-remote'), false)
}, 'https://dev.agents.house/app/new.git'))
test('existing-App publication does not mistake push output for a creation receipt', () => withFixture(f => {
  const run = (cmd, args, opts) => {
    const result = f.run(cmd, args, opts)
    if (cmd === 'git' && args[0] === 'push') opts.captureOutput('https://dev.agents.house/app/a_other\nhttps://dev.agents.house/app/a_other.git')
    return result
  }
  assert.equal(invoke(f, run).creationReceipt, undefined)
}))
test('reported App identifiers ending in .git are paired without a guessed URL', () => {
  const receipt = parseCreationReceipt('https://dev.agents.house/app/a_created.git\nhttps://dev.agents.house/app/a_created.git.git')
  assert.equal(receipt.status, 'reported')
  assert.equal(receipt.appURL, 'https://dev.agents.house/app/a_created.git')
  assert.equal(receipt.gitURL, 'https://dev.agents.house/app/a_created.git.git')
})
test('failed capture cannot turn an unterminated URL prefix into a creation receipt', () => {
  let receipt
  assert.throws(() => command(process.execPath, ['-e', "console.log('https://dev.agents.house/app/a_created');process.stderr.write('https://dev.agents.house/app/a_created.git');process.exit(1)"], { captureOutput: output => { receipt = parseCreationReceipt(output) } }), /failed/)
  assert.equal(receipt.status, 'incomplete-or-ambiguous'); assert.deepEqual(receipt.gitURLs, [])
})
test('terminated capture drops incomplete URL tokens on each stream independently', () => {
  let receipt
  assert.throws(() => command(process.execPath, ['-e', "console.log('https://dev.agents.house/app/a_created');process.stderr.write('https://dev.agents.house/app/a_created.git');setTimeout(()=>{},2000)"], { timeout: 200, captureOutput: output => { receipt = parseCreationReceipt(output) } }), /timed out/)
  assert.notEqual(receipt.status, 'reported'); assert.deepEqual(receipt.gitURLs, [])
})

test('quote-parenthesis suffixes cannot hide credential-bearing URL tails', () => {
  for (const suffix of ["'?token=SECRET", "')?token=SECRET", ")?token=SECRET", "'>?token=SECRET", "'#SECRET", "')#SECRET"]) {
    for (const wrapper of ['', "'", '(', '<', '[', '{']) {
      const output = ['demo', 'demo.git'].map(id => `${wrapper}https://any-house.example/app/${id}${suffix}`).join('\n')
      assert.deepEqual(parseCreationReceipt(output), { status: 'missing', appURLs: [], gitURLs: [] })
    }
  }
})
test('balanced outer wrappers preserve exact portable receipt addresses', () => {
  for (const [left, right] of [["'", "'"], ['"', '"'], ['(', ')'], ['<', '>'], ['[', ']'], ['{', '}']]) {
    const app = 'https://[::1]:8443/app/demo.git'; const git = `${app}.git`
    const receipt = parseCreationReceipt(`${left}${app}${right}\n${left}${git}${right}`)
    assert.equal(receipt.status, 'reported'); assert.equal(receipt.appURL, app); assert.equal(receipt.gitURL, git)
    assert.equal(parseCreationReceipt(`${app}${right}\n${git}${right}`).status, 'missing')
  }
})
test('literal new.git App identifier is accepted only with its printed Git counterpart', () => {
  const app = 'https://any-house.example/app/new.git'; const git = `${app}.git`
  assert.equal(parseCreationReceipt(app).status, 'missing')
  assert.deepEqual(parseCreationReceipt(`${app}\n${git}`), {
    status: 'reported', appURLs: [app], gitURLs: [git], appURL: app, gitURL: git,
  })
})
test('output-limit failures drop unterminated URL tails from either stream', () => {
  for (const stream of ['stdout', 'stderr']) {
    let receipt
    // One synchronous write exceeds maxBuffer and leaves a syntactically valid
    // URL as the final token. That token is not trustworthy on a failed capture.
    const script = `require('node:fs').writeSync(${stream === 'stdout' ? 1 : 2}, 'https://any-house.example/app/demo\\n' + ' '.repeat(8192) + 'https://any-house.example/app/demo.git');setTimeout(()=>{},2000)`
    assert.throws(() => command(process.execPath, ['-e', script], {
      maxBuffer: 1024, timeout: 1000, captureOutput: output => { receipt = parseCreationReceipt(output) },
    }), /output exceeded the capture limit/)
    assert.notEqual(receipt.status, 'reported'); assert.deepEqual(receipt.gitURLs, [])
  }
})
test('timeouts discard final URL tokens independently on both streams', () => {
  for (const stream of ['stdout', 'stderr']) {
    let receipt
    const other = stream === 'stdout' ? 'stderr' : 'stdout'
    const script = `process.${other}.write('https://any-house.example/app/demo\\n');process.${stream}.write('https://any-house.example/app/demo.git');setTimeout(()=>{},2000)`
    assert.throws(() => command(process.execPath, ['-e', script], {
      timeout: 200, captureOutput: output => { receipt = parseCreationReceipt(output) },
    }), /timed out/)
    assert.equal(receipt.status, 'incomplete-or-ambiguous'); assert.deepEqual(receipt.gitURLs, [])
  }
})
test('failed commands retain terminated safe receipts but successful EOF completes a token', () => {
  for (const [ending, exitCode] of [['\n', 1], ['', 0]]) {
    let receipt
    const output = `https://any-house.example/app/demo\nhttps://any-house.example/app/demo.git${ending}`
    const run = () => command(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(output)});process.exit(${exitCode})`], {
      captureOutput: output => { receipt = parseCreationReceipt(output) },
    })
    if (exitCode) assert.throws(run, /exit 1/)
    else run()
    assert.equal(receipt.status, 'reported')
  }
})
