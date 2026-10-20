#!/usr/bin/env node
// Instruments the inspected Telegram MCP plugin without changing its control flow.
// Recheck the source and anchors before supporting a future plugin release.
import { createHash } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_CACHE_VERSION = '0.0.7'
export const PACKAGE_VERSION = '0.0.1'
export const BASE_SOURCE_SHA256 = '49f4cf60bcd95870bd9320a9d6c92bfa23e2150bffe5e0655e3a37a55a4b8760'
export const DEFAULT_PLUGIN_ROOT = join(
  homedir(), '.claude/plugins/cache/claude-plugins-official/telegram', PLUGIN_CACHE_VERSION,
)

const lifecycleHelper = `// banana-portfolio-v2 lifecycle diagnostics v1 (no message or credential data)
const LIFECYCLE_LOG = join(homedir(), 'Library', 'Logs', 'banana-portfolio-v2', 'telegram-mcp-lifecycle.jsonl')
function lifecycleErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'NonError'
    const allowed = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
      'GrammyError', 'HttpError', 'FetchError', 'AbortError', 'AggregateError']
    return allowed.includes(error.name) ? error.name : 'OtherError'
  } catch { return 'Unknown' }
}
function lifecyclePollCategory(error: unknown, conflict: boolean): string {
  if (conflict) return 'telegram_conflict'
  try {
    // grammY HttpError keeps the transport error in .error. Inspect only one
    // wrapper level and only allowlisted codes; never serialize error objects.
    const values = [error]
    if (error && typeof error === 'object') {
      if ('error' in error) values.push(error.error)
      if ('cause' in error) values.push(error.cause)
    }
    for (const value of values) {
      const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined
      if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED') return 'network_connection'
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'network_dns'
    }
  } catch {}
  return 'other'
}
function lifecycleRecord(event: string, fields: Record<string, string | number> = {}): void {
  // These hooks run only at process lifecycle or polling failure boundaries.
  // Synchronous writes also preserve the exit record when process.exit() follows.
  try {
    const directory = join(homedir(), 'Library', 'Logs', 'banana-portfolio-v2')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) return
    chmodSync(directory, 0o700)
    const fd = openSync(LIFECYCLE_LOG, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
        pluginVersion: '0.0.7', event, ...fields }) + '\\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    // Diagnostics must never change the channel's behavior.
  }
}
lifecycleRecord('startup')
process.on('exit', code => lifecycleRecord('exit', { code }))
// end banana-portfolio-v2 lifecycle diagnostics v1

`

const changes = [
  [
    "import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync } from 'fs'",
    "import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync, openSync, fchmodSync, writeSync, closeSync, lstatSync, constants } from 'fs'",
  ],
  ["const STATE_DIR = process.env.TELEGRAM_STATE_DIR", lifecycleHelper + "const STATE_DIR = process.env.TELEGRAM_STATE_DIR"],
  [
    "process.on('unhandledRejection', err => {\n  process.stderr.write",
    "process.on('unhandledRejection', err => {\n  lifecycleRecord('unhandled_rejection', { errorName: lifecycleErrorName(err) })\n  process.stderr.write",
  ],
  [
    "process.on('uncaughtException', err => {\n  process.stderr.write",
    "process.on('uncaughtException', err => {\n  lifecycleRecord('uncaught_exception', { errorName: lifecycleErrorName(err) })\n  process.stderr.write",
  ],
  [
    "function shutdown(): void {\n  if (shuttingDown) return\n  shuttingDown = true",
    "function shutdown(reason: string): void {\n  if (shuttingDown) return\n  shuttingDown = true\n  lifecycleRecord('shutdown', { reason })",
  ],
  [
    "process.stdin.on('end', shutdown)\nprocess.stdin.on('close', shutdown)\nprocess.on('SIGTERM', shutdown)\nprocess.on('SIGINT', shutdown)\nprocess.on('SIGHUP', shutdown)",
    "process.stdin.on('end', () => shutdown('stdin_end'))\nprocess.stdin.on('close', () => shutdown('stdin_close'))\nprocess.on('SIGTERM', () => shutdown('SIGTERM'))\nprocess.on('SIGINT', () => shutdown('SIGINT'))\nprocess.on('SIGHUP', () => shutdown('SIGHUP'))",
  ],
  [
    "  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()",
    "  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown('orphan_watchdog')",
  ],
  [
    "      if (is409 && attempt >= 8) {\n        process.stderr.write(",
    "      if (is409 && attempt >= 8) {\n        lifecycleRecord('poll_terminal', { category: 'telegram_conflict', attempt, errorName: lifecycleErrorName(err) })\n        process.stderr.write(",
  ],
  [
    "      const delay = Math.min(1000 * attempt, 15000)\n      const detail = is409",
    "      const delay = Math.min(1000 * attempt, 15000)\n      lifecycleRecord('poll_retry', { category: lifecyclePollCategory(err, is409), attempt, errorName: lifecycleErrorName(err) })\n      const detail = is409",
  ],
]

function sha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

export function instrumentSource(source, expectedHash = BASE_SOURCE_SHA256) {
  if (sha256(source) !== expectedHash) throw new Error('Unknown or modified plugin source; refusing to patch')
  let patched = source
  for (const [anchor, replacement] of changes) {
    if (patched.split(anchor).length !== 2) throw new Error(`Unexpected plugin source anchor: ${anchor.slice(0, 60)}`)
    patched = patched.replace(anchor, replacement)
  }
  return patched
}

export async function inspectPlugin(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  if (basename(resolve(pluginRoot)) !== PLUGIN_CACHE_VERSION) {
    throw new Error(`Unknown plugin cache version: ${pluginRoot}`)
  }
  const packageJson = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  if (packageJson.name !== 'claude-channel-telegram' || packageJson.version !== PACKAGE_VERSION) {
    throw new Error('Unknown Telegram plugin package version')
  }
  const sourcePath = join(pluginRoot, 'server.ts')
  if ((await lstat(sourcePath)).isSymbolicLink()) {
    throw new Error('Symlinked plugin source; refusing to patch')
  }
  const source = await readFile(sourcePath, 'utf8')
  const patched = instrumentSourceFromKnownHash(source)
  return { sourcePath, source, patched, status: source === patched ? 'patched' : 'unpatched' }
}

export function reconstructReviewedSource(source, expectedHash = BASE_SOURCE_SHA256) {
  if (sha256(source) === expectedHash) return source
  // Exact reconstruction rejects partial or locally edited instrumentation.
  let original = source
  for (const [anchor, replacement] of [...changes].reverse()) {
    if (original.split(replacement).length !== 2) {
      throw new Error('Unknown or partially modified plugin source; refusing to patch')
    }
    original = original.replace(replacement, anchor)
  }
  if (sha256(original) !== expectedHash || instrumentSource(original, expectedHash) !== source) {
    throw new Error('Unknown or modified lifecycle patch; refusing to patch')
  }
  return original
}

export function instrumentSourceFromKnownHash(source, expectedHash = BASE_SOURCE_SHA256) {
  const original = reconstructReviewedSource(source, expectedHash)
  return original === source ? instrumentSource(source, expectedHash) : source
}

export async function run(mode, pluginRoot = DEFAULT_PLUGIN_ROOT) {
  if (mode !== '--check' && mode !== '--apply') throw new Error('Usage: node scripts/tools/telegram-mcp-lifecycle-patch.mjs --check|--apply [--plugin-root PATH]')
  const inspection = await inspectPlugin(pluginRoot)
  if (mode === '--check') return inspection.status
  if (inspection.status === 'patched') return 'patched'
  const originalMode = (await lstat(inspection.sourcePath)).mode & 0o777
  const temporaryPath = join(dirname(inspection.sourcePath), `.server.ts.lifecycle-${process.pid}-${Date.now()}`)
  try {
    await writeFile(temporaryPath, inspection.patched, { flag: 'wx', mode: originalMode })
    if (await readFile(inspection.sourcePath, 'utf8') !== inspection.source) {
      throw new Error('Plugin source changed during patch; refusing to overwrite')
    }
    await rename(temporaryPath, inspection.sourcePath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  return 'applied'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const mode = args[0]
    const pluginRoot = args.length === 3 && args[1] === '--plugin-root' ? args[2] : undefined
    if (!mode || (args.length !== 1 && !pluginRoot)) throw new Error('Usage: --check|--apply [--plugin-root PATH]')
    const status = await run(mode, pluginRoot)
    process.stdout.write(`Telegram MCP lifecycle patch: ${status}\n`)
    if (mode === '--check' && status === 'unpatched') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`)
    process.exitCode = 2
  }
}
