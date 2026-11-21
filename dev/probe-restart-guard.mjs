/**
 * Probe for the guards that keep an upgrade and a restart from racing, the
 * failure that broke the 0.2.2-rc.5 automatic restart:
 *
 * `npm install --global` writes the dsh manifest and launcher long before it
 * finishes writing the dependency tree, so a restart that lands mid-install
 * boots a half-written install and dies on `ERR_MODULE_NOT_FOUND`. Measured on
 * the machine that hit it: launcher at T+0 s, dependencies still landing at
 * T+73 s, npm exit 0 at T+99 s.
 *
 * Parts:
 * 1. `restartRefusal` — the Host refuses a restart while an upgrade installs.
 * 2. `installComplete` — a dependency tree npm is still writing is rejected.
 * 3. `restartPlan` — a half-installed version reports `install-incomplete`
 *    instead of a launch command.
 * 4. the restart helper — retries with backoff, then gives up inside a budget.
 * 5. the panel — `runtimeInfo.upgrading` and the new locale messages exist.
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const host = await import('../index.js')
/** Call an export that this probe expects to exist; undefined when it does not. */
const call = (name, ...args) => (typeof host[name] === 'function' ? host[name](...args) : undefined)

const failures = []
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(name)
}

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-vm-guard-'))
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await settle(50)
  }
  return false
}

try {
  /* 1. restartRefusal ------------------------------------------------------- */
  check('a restart is allowed when nothing else runs', call('restartRefusal', {}) === null)
  const duringUpgrade = call('restartRefusal', { upgrading: { target: 'npm', version: '0.2.2-rc.5' } })
  check('a restart during an upgrade is refused', duringUpgrade?.ok === false && duringUpgrade?.error === 'upgrading', JSON.stringify(duringUpgrade) ?? 'undefined')
  check(
    'a restart during another restart is refused',
    call('restartRefusal', { restarting: { target: 'npm', version: '0.2.2-rc.5' } })?.error === 'busy',
  )
  check(
    'an in-flight upgrade outranks an in-flight restart',
    call('restartRefusal', { upgrading: { target: 'npm', version: '1.0.0' }, restarting: { target: 'npm', version: '1.0.0' } })?.error === 'upgrading',
  )

  // The route reaches the guard through restartVersion, not the pure helper.
  const refusedRestart = await call(
    'restartVersion',
    { appExit: () => {} },
    { target: 'npm', version: '9.9.9' },
    { upgrading: { target: 'npm', version: '9.9.9' } },
  )
  check(
    'the restart route refuses while an upgrade installs',
    refusedRestart?.ok === false && refusedRestart?.error === 'upgrading',
    JSON.stringify(refusedRestart) ?? 'undefined',
  )

  /* 2. installComplete ------------------------------------------------------ */
  /** Build a fake install: a manifest listing `dependencies`, plus their manifests. */
  const makeInstall = async (name, dependencies, present) => {
    const directory = path.join(scratch, name)
    await mkdir(path.join(directory, 'lib'), { recursive: true })
    await writeFile(path.join(directory, 'lib', 'bin.js'), '')
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5', dependencies }),
    )
    for (const dependency of present) {
      const target = path.join(directory, 'node_modules', ...dependency.split('/'))
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: dependency, version: '1.0.0' }))
    }
    return directory
  }
  const dependencies = { '@deepseek-ai/dsh-app-boot': '0.2.2-rc.5', 'js-yaml': '^4.3.2' }
  const complete = await makeInstall('complete', dependencies, Object.keys(dependencies))
  const partial = await makeInstall('partial', dependencies, ['js-yaml'])
  const unreadable = path.join(scratch, 'unreadable')
  await mkdir(unreadable, { recursive: true })

  check('a finished install is launchable', (await call('installComplete', complete)) === true)
  check(
    'an install still missing a dependency is not launchable',
    (await call('installComplete', partial)) === false,
    partial,
  )
  check('a directory without a manifest is not launchable', (await call('installComplete', unreadable)) === false)
  check('a null directory is not launchable', (await call('installComplete', null)) === false)

  /* 3. restartPlan ---------------------------------------------------------- */
  const launcherArgv = [
    process.execPath,
    path.join('C:', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'web',
  ]
  const planHost = { argv: launcherArgv, execPath: process.execPath, pid: 4242, cwd: scratch, profile: 'web', appArgs: [] }
  const scanFor = (directory) => async () => [{ version: '0.2.2-rc.5', directory }]

  const refused = await call('restartPlan', { target: 'npm', version: '0.2.2-rc.5' }, planHost, { scanGlobal: scanFor(partial) })
  check(
    'a restart onto a half-installed version is refused',
    refused?.ok === false && refused?.error === 'install-incomplete',
    JSON.stringify(refused) ?? 'undefined',
  )

  const planned = await call('restartPlan', { target: 'npm', version: '0.2.2-rc.5' }, planHost, { scanGlobal: scanFor(complete) })
  check(
    'a restart onto a finished install still plans a launch',
    planned?.ok === true && planned?.binPath === path.join(complete, 'lib', 'bin.js'),
    JSON.stringify(planned) ?? 'undefined',
  )

  /* 4. helper retry budget -------------------------------------------------- */
  const flakyScript = path.join(scratch, 'flaky.cjs')
  await writeFile(
    flakyScript,
    `
const fs = require('node:fs')
const countFile = process.argv[2]
const pidFile = process.argv[3]
const port = Number(process.argv[4])
let count = 0
try { count = Number(fs.readFileSync(countFile, 'utf8')) } catch {}
count += 1
fs.writeFileSync(countFile, String(count))
if (count < 3) process.exit(1)
require('node:http').createServer((request, response) => response.end('new')).listen(port, '127.0.0.1', () => {
  fs.writeFileSync(pidFile, String(process.pid))
})
`,
  )
  const counterFile = path.join(scratch, 'count.txt')
  const pidFile = path.join(scratch, 'new.pid')
  const retryLog = path.join(scratch, 'retry.log')
  const port = 35000 + Math.floor(Math.random() * 500)
  call('spawnRestartHelper', {
    pid: 999999,
    cwd: scratch,
    log: retryLog,
    command: [process.execPath, flakyScript, counterFile, pidFile, String(port)],
    backoffMs: [40, 40, 40, 40],
    budgetMs: 8000,
    probeMs: 800,
  })
  const retried = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      return (await response.text()) === 'new'
    } catch {
      return false
    }
  })
  check('the helper retries a failing launch until it runs', retried)
  const retryText = await readFile(retryLog, 'utf8').catch(() => '')
  check('the helper logged a third attempt', /launch attempt 3/.test(retryText), retryText.split('\n').slice(-3).join(' | '))
  const accepted = await waitFor(async () => /restart helper: running/.test(await readFile(retryLog, 'utf8').catch(() => '')), 5000)
  check('the helper recorded the new server as running', accepted)

  const doomedScript = path.join(scratch, 'doomed.cjs')
  await writeFile(doomedScript, 'process.exit(1)\n')
  const doomedLog = path.join(scratch, 'doomed.log')
  const startedAt = Date.now()
  call('spawnRestartHelper', {
    pid: 999999,
    cwd: scratch,
    log: doomedLog,
    command: [process.execPath, doomedScript],
    backoffMs: [30, 30],
    budgetMs: 150,
    probeMs: 400,
  })
  const gaveUp = await waitFor(async () => /giving up/.test(await readFile(doomedLog, 'utf8').catch(() => '')), 10000)
  check('the helper gives up once its budget is spent', gaveUp, `${Date.now() - startedAt} ms`)
  const doomedText = await readFile(doomedLog, 'utf8').catch(() => '')
  check('giving up leaves the last failure in the log', /giving up/.test(doomedText) && /exit 1/.test(doomedText))

  /* 5. panel wiring --------------------------------------------------------- */
  const runtime = call('runtimeInfo', {})
  check('runtimeInfo reports no upgrade while idle', runtime?.upgrading === null, JSON.stringify(runtime?.upgrading))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  check('runtimeInfo reports the plugin version the panel shows', runtime?.pluginVersion === manifest.version, String(runtime?.pluginVersion))
  check(
    'runtimeInfo keeps the boot facts it already reported',
    runtime?.pid === process.pid && runtime?.canRestart === false && 'version' in (runtime ?? {}),
  )
  const upgrading = call('upgradingSnapshot')
  check('upgradingSnapshot is null while idle', upgrading === null)

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const dictKeys = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    const end = start < 0 ? -1 : source.indexOf('\n    }', start)
    if (end < 0) return new Set()
    return new Set(
      [...source.slice(start, end).matchAll(/^\s*(?:'([^']+)'|([A-Za-z_][\w.]*))\s*:/gm)].map((match) => match[1] ?? match[2]),
    )
  }
  const zh = dictKeys('zh')
  const en = dictKeys('en')
  for (const key of ['restart.upgrading', 'restart.incomplete']) {
    check(`locale zh carries ${key}`, zh.has(key))
    check(`locale en carries ${key}`, en.has(key))
    check(`the panel uses ${key}`, source.includes(`t('${key}'`))
  }
} finally {
  const pidText = await readFile(path.join(scratch, 'new.pid'), 'utf8').catch(() => '')
  const pid = Number(pidText.trim())
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall restart guard checks passed')
