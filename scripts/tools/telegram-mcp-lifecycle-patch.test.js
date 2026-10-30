import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BASE_SOURCE_SHA256,
  DEFAULT_PLUGIN_ROOT,
  LIFECYCLE_CHANGES,
  inspectPlugin,
  instrumentSource,
  instrumentSourceFromKnownHash,
  reconstructReviewedSource,
  run,
} from './telegram-mcp-lifecycle-patch.mjs'

const hash = source => createHash('sha256').update(source).digest('hex')
const syntheticSource = [
  "import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync } from 'fs'",
  'const STATE_DIR = process.env.TELEGRAM_STATE_DIR',
  '// Telegram allows exactly one getUpdates consumer per token.',
  "process.on('unhandledRejection', err => {\n  process.stderr.write",
  "process.on('uncaughtException', err => {\n  process.stderr.write",
  'function shutdown(): void {\n  if (shuttingDown) return\n  shuttingDown = true',
  "process.stdin.on('end', shutdown)\nprocess.stdin.on('close', shutdown)\nprocess.on('SIGTERM', shutdown)\nprocess.on('SIGINT', shutdown)\nprocess.on('SIGHUP', shutdown)",
  '  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()',
  '      if (is409 && attempt >= 8) {\n        process.stderr.write(',
  '      const delay = Math.min(1000 * attempt, 15000)\n      const detail = is409',
].join('\n\n')

async function installedSource(t) {
  try {
    const source = await readFile(join(DEFAULT_PLUGIN_ROOT, 'server.ts'), 'utf8')
    const baseline = reconstructReviewedSource(source)
    assert.equal(hash(baseline), BASE_SOURCE_SHA256)
    return baseline
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('Telegram plugin cache is not installed')
      return null
    }
    throw error
  }
}

async function fixture(t, source) {
  const parent = await mkdtemp(join(tmpdir(), 'telegram-lifecycle-patch-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, '0.0.7')
  await mkdir(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'claude-channel-telegram', version: '0.0.1' }))
  await writeFile(join(root, 'server.ts'), source)
  return root
}

test('patch covers lifecycle boundaries and is idempotent without the plugin cache', () => {
  const patched = instrumentSource(syntheticSource, hash(syntheticSource))
  assert.match(patched, /lifecycleRecord\('startup'\)/)
  assert.match(patched, /process\.on\('exit', code => lifecycleRecord\('exit', \{ code \}\)\)/)
  for (const reason of ['stdin_end', 'stdin_close', 'SIGTERM', 'SIGINT', 'SIGHUP', 'orphan_watchdog']) {
    assert.ok(patched.includes(`shutdown('${reason}')`), reason)
  }
  for (const event of ['unhandled_rejection', 'uncaught_exception', 'poll_retry', 'poll_terminal']) {
    assert.ok(patched.includes(`lifecycleRecord('${event}'`), event)
  }
  assert.match(patched, /fchmodSync\(fd, 0o600\)/)
  assert.match(patched, /chmodSync\(directory, 0o700\)/)
  assert.doesNotMatch(patched.slice(0, patched.indexOf('const STATE_DIR')), /chat_id|message\.text|TOKEN|stack|error\.message/)
  assert.equal(instrumentSourceFromKnownHash(patched, hash(syntheticSource)), patched)
})

test('generated helper writes private JSONL with redacted names and wrapped retry categories', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'telegram-lifecycle-runtime-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const directory = join(parent, 'Library', 'Logs', 'banana-portfolio-v2')
  const logPath = join(directory, 'telegram-mcp-lifecycle.jsonl')
  await mkdir(directory, { recursive: true })
  await chmod(directory, 0o777)
  await writeFile(logPath, '')
  await chmod(logPath, 0o666)
  const patched = instrumentSource(syntheticSource, hash(syntheticSource))
  const marker = patched.indexOf('// banana-portfolio-v2 lifecycle diagnostics v1')
  const helper = patched.slice(patched.indexOf('\n', marker) + 1,
    patched.indexOf('// end banana-portfolio-v2 lifecycle diagnostics v1'))
  const scriptPath = join(parent, 'runtime.ts')
  await writeFile(scriptPath, `
    import { mkdirSync, chmodSync, lstatSync, openSync, fchmodSync, writeSync, closeSync, constants } from 'node:fs'
    import { join } from 'node:path'
    const homedir = () => ${JSON.stringify(parent)}
    ${helper}
    const secret = 'TOKEN-SECRET message-text chat-123'
    const customError = Object.assign(new Error(secret), { name: secret })
    lifecycleRecord('redacted', { errorName: lifecycleErrorName(customError) })
    lifecycleRecord('wrapped', { category: lifecyclePollCategory({ error: Object.assign(new Error(secret), { code: 'ECONNRESET' }) }, false) })
    lifecycleRecord('caused', { category: lifecyclePollCategory({ cause: { code: 'EAI_AGAIN' } }, false) })
    lifecycleRecord('deep', { category: lifecyclePollCategory({ error: { cause: { code: 'ETIMEDOUT' } } }, false) })
    lifecycleRecord('conflict', { category: lifecyclePollCategory({}, true) })
    process.exit(7)
  `)
  const run = spawnSync('bun', [scriptPath], { encoding: 'utf8' })
  assert.equal(run.status, 7, run.stderr)
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines.map(line => line.event), ['startup', 'redacted', 'wrapped', 'caused', 'deep', 'conflict', 'exit'])
  assert.equal(lines[1].errorName, 'OtherError')
  assert.equal(lines[2].category, 'network_connection')
  assert.equal(lines[3].category, 'network_dns')
  assert.equal(lines[4].category, 'other')
  assert.equal(lines[5].category, 'telegram_conflict')
  assert.equal(lines[6].code, 7)
  assert.doesNotMatch(await readFile(logPath, 'utf8'), /TOKEN-SECRET|message-text|chat-123/)
  assert.equal((await stat(logPath)).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
})

test('--check is read-only; --apply is idempotent and preserves original file mode', async t => {
  const source = await installedSource(t)
  if (!source) return
  const root = await fixture(t, source)
  const path = join(root, 'server.ts')
  const before = await stat(path)
  assert.equal((await inspectPlugin(root)).status, 'unpatched')
  assert.equal(await run('--check', root), 'unpatched')
  assert.equal(await readFile(path, 'utf8'), source)
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs)

  assert.equal(await run('--apply', root), 'applied')
  const patched = await readFile(path, 'utf8')
  assert.equal(patched, instrumentSource(source))
  assert.equal((await stat(path)).mode & 0o777, before.mode & 0o777)
  assert.equal(await run('--check', root), 'patched')
  assert.equal(await run('--apply', root), 'patched')
  assert.equal(await readFile(path, 'utf8'), patched)
})

test('unknown version, altered source, and partial or edited patch fail closed', async t => {
  const source = await installedSource(t)
  if (!source) return
  const root = await fixture(t, source)
  const path = join(root, 'server.ts')
  await writeFile(path, source.replace("process.on('SIGTERM', shutdown)", "process.on('SIGTERM', () => shutdown())"))
  await assert.rejects(run('--apply', root), /Unknown or partially modified plugin source/)
  assert.match(await readFile(path, 'utf8'), /process\.on\('SIGTERM', \(\) => shutdown\(\)\)/)

  const patched = instrumentSource(source)
  await writeFile(path, patched.replace("shutdown('SIGTERM')", "shutdown('signal')"))
  await assert.rejects(run('--check', root), /partially modified|modified lifecycle patch/)
  await writeFile(path, patched.replace("lifecycleRecord('startup')", "lifecycleRecord('other')"))
  await assert.rejects(run('--apply', root), /partially modified|modified lifecycle patch/)

  await writeFile(path, source)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'claude-channel-telegram', version: '0.0.2' }))
  await assert.rejects(run('--check', root), /Unknown Telegram plugin package version/)
  await assert.rejects(inspectPlugin(root.replace('0.0.7', '0.0.8')), /Unknown plugin cache version/)
})

test('source anchors must each occur exactly once', () => {
  const duplicate = syntheticSource + "\nconst STATE_DIR = process.env.TELEGRAM_STATE_DIR\n"
  assert.throws(() => instrumentSource(duplicate, hash(duplicate)), /Unexpected plugin source anchor/)
})

test('installed plugin is either the reviewed baseline or the exact patch', async t => {
  try {
    const inspection = await inspectPlugin(DEFAULT_PLUGIN_ROOT)
    assert.ok(['unpatched', 'patched'].includes(inspection.status))
  } catch (error) {
    if (error.code === 'ENOENT') t.skip('Telegram plugin cache is not installed')
    else throw error
  }
})

test('channel-owner guard is inserted before the stale-poller takeover', () => {
  const patched = instrumentSource(syntheticSource, hash(syntheticSource))
  const guard = patched.indexOf('// banana-portfolio-v2 channel-owner guard v1')
  assert.ok(guard > patched.indexOf('// end banana-portfolio-v2 lifecycle diagnostics v1'))
  assert.ok(guard < patched.indexOf('// Telegram allows exactly one getUpdates consumer per token.'))
  assert.match(patched, /lifecycleRecord\('guard_exit', \{ reason: 'not_channels_session', depth: /)
})

test('an exact earlier lifecycle-only patch is recognized and upgraded in place', async t => {
  const v1 = instrumentSource(syntheticSource, hash(syntheticSource), LIFECYCLE_CHANGES)
  assert.equal(reconstructReviewedSource(v1, hash(syntheticSource)), syntheticSource)
  const upgraded = instrumentSourceFromKnownHash(v1, hash(syntheticSource))
  assert.equal(upgraded, instrumentSource(syntheticSource, hash(syntheticSource)))
  assert.throws(() => reconstructReviewedSource(v1.replace("shutdown('SIGTERM')", "shutdown('signal')"), hash(syntheticSource)),
    /partially modified|modified lifecycle patch/)
})

test('[실사고 재현] guard exits non-channel sessions without polling and lets the channel session through', async t => {
  const BUN = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim()
  if (!BUN) { t.skip('bun is not installed'); return }
  const parent = await mkdtemp(join(tmpdir(), 'telegram-guard-runtime-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const patched = instrumentSource(syntheticSource, hash(syntheticSource))
  const start = patched.indexOf('// banana-portfolio-v2 channel-owner guard v1')
  const guard = patched.slice(start, patched.indexOf('// end banana-portfolio-v2 channel-owner guard v1'))
  const scriptPath = join(parent, 'guard.ts')
  await writeFile(scriptPath, `
    import { execFileSync } from 'node:child_process'
    const lifecycleRecord = (event, fields) => console.log('LIFECYCLE ' + event + ' ' + JSON.stringify(fields))
    ${guard}
    console.log('POLLING')
  `)
  // A wrapper keeps bash alive as bun's parent so its argv is what the guard sees.
  const runUnder = (argv0, env = process.env) => spawnSync('/bin/bash', ['-c', `exec -a "${argv0}" /bin/bash -c '"$1" "$0"; exit $?' "${scriptPath}" "${BUN}"`], { encoding: 'utf8', env })

  const other = runUnder('claude --output-format stream-json')
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /LIFECYCLE guard_exit \{"reason":"not_channels_session","depth":\d+,"nearestClaudePid":\d+\}/)
  assert.doesNotMatch(other.stdout, /POLLING/)

  const wrapper = runUnder('/bin/bash -lc export X=1; claude --channels plugin:telegram@claude-plugins-official')
  assert.match(wrapper.stdout, /guard_exit/, 'a shell line mentioning the flag is not the channel session')

  const desktop = runUnder('/Users/x/Library/Application Support/Claude/MacOS/claude --channels plugin:telegram@x')
  assert.match(desktop.stdout, /guard_exit/, 'a Desktop path with spaces is not the launchd channel session')

  const fullPath = runUnder('/Users/x/.local/bin/claude --channels plugin:telegram@claude-plugins-official')
  assert.match(fullPath.stdout, /POLLING/)

  const marker = runUnder('/bin/bash -lc export PATH=x; export CLAUDE_TELEGRAM_SESSION=1; node cli.js')
  assert.match(marker.stdout, /POLLING/, 'the launchd wrapper marker is a second acceptance condition')

  const noPs = runUnder('claude --output-format stream-json', { ...process.env, PATH: '/nonexistent' })
  assert.match(noPs.stdout, /POLLING/, 'ps failure must fail open')

  const channel = runUnder('claude --channels plugin:telegram@claude-plugins-official --name x')
  assert.equal(channel.status, 0, channel.stderr)
  assert.match(channel.stdout, /POLLING/)
  assert.doesNotMatch(channel.stdout, /guard_exit/)
})
