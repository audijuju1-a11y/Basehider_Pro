#!/usr/bin/env node
'use strict'
/**
 * load-bench.js - reproducible, honest load-test harness for the BaseHider
 * Paper 1.21.4 plugin.
 *
 * What it does:
 *   1. Preflight: refuses to run if ports 25598/25599 or a paper-1.21.4 server
 *      are already in use (never kills foreign processes), and takes a lock so
 *      two load-bench runs cannot overlap.
 *   2. Prepares D:/Basehider/itest/server: copies dist/BaseHider-3.1.0.jar to
 *      plugins/BaseHider.jar, ensures plugins/PacketEvents.jar, rewrites
 *      server.properties (offline, flat, view-distance 4, simulation-distance 4,
 *      rcon 25598, server-port 25599, max-players N+10, spawn-protection 0).
 *   3. Generates the bhload datapack (gen-datapack.js) BEFORE server start.
 *   4. Starts Paper with -Xms1G -Xmx2G, waits for "Done (", waits for RCON,
 *      runs /function bhload:summon_items, verifies item entities exist.
 *   5. Starts load-bot.js worker(s), connects N bots staggered, waits for >=95%
 *      to reach spawn state (or times out), records join latency.
 *   6. Samples every 10s for 6 samples: /mspt, /basehider diag, /paper heap
 *      (+ /tps and jcmd GC.heap_info as extra evidence). Raw outputs are stored.
 *   7. Optional soak: every ~20s kill @e[type=minecraft:item] + re-summon the
 *      datapack item field, while continuing to sample.
 *   8. Clean shutdown: quit bots, /stop via RCON, wait, kill leftover child
 *      processes, ALWAYS verify ports 25598/25599 are freed, restore the
 *      original server.properties.
 *
 * Usage:
 *   node bench/load-bench.js --bots 10 --items 200 --label smoke10-200
 *   node bench/load-bench.js --bots 50 --items 1000 --label mid50-1000
 *   node bench/load-bench.js --bots 10 --items 200 --label soak10-200-120s --soak-seconds 120
 *
 * Optional flags (defaults in parentheses):
 *   --soak-seconds S (0)          --sample-count 6        --sample-interval-ms 10000
 *   --warmup-ms 5000              --join-timeout-ms 180000 --stagger-ms 75
 *   --workers auto                --xms 1G                --xmx 2G
 *   --server-port 25599           --rcon-port 25598       --rcon-password itest-rcon-pass
 *   --server-dir D:/Basehider/itest/server
 *   --churn-interval-ms 20000     --max-run-ms 1500000
 *
 * Results:  D:/Basehider/bench/load-<label>.json
 *           D:/Basehider/bench/load-server-<label>.log       (Paper stdout/stderr)
 *           D:/Basehider/bench/load-console-<label>.log      (harness progress log)
 * Exit codes: 0 ok, 1 run failed, 2 preflight abort (ports/foreign server/lock),
 *             3 hard timeout (watchdog cleanup attempted).
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { generateDatapack, FUNCTION_ID } = require('./gen-datapack.js')

const BENCH_DIR = __dirname
const ROOT = path.resolve(__dirname, '..')
// Isolated load-test server dir (owned by this harness). The integration
// harness keeps D:/Basehider/itest/server + 25598/25599; this harness never
// writes there.
const DEFAULT_SERVER_DIR = path.join(BENCH_DIR, 'load-server')
const PAPER_SOURCE_JAR = path.join(ROOT, 'itest', 'server', 'paper-1.21.4.jar')
const BOT_SCRIPT = path.join(BENCH_DIR, 'load-bot.js')
const RCON_LIB = path.join(ROOT, 'itest', 'bot', 'lib', 'rcon.js')
const NODE = process.execPath
const JAVA = 'C:/Users/audim_r0h5i/.jdks/jdk-21.0.13+9/bin/java.exe'
const JCMD = path.join(path.dirname(JAVA), 'jcmd.exe')
const PLUGIN_DIST_PREFERRED = path.join(ROOT, 'dist', 'BaseHider-3.2.0.jar') // final build, if delivered
const PLUGIN_DIST_FALLBACK = path.join(ROOT, 'dist', 'BaseHider-3.1.0.jar')
/**
 * Pick the plugin jar to test. The load-test evidence must say which build it
 * measured, so the chosen path + sha256 are recorded in the result JSON.
 * Policy: exact final BaseHider-3.2.0.jar if present (deployment candidate),
 * else BaseHider-3.1.0.jar (documented delivery build), else newest
 * BaseHider-*.jar in dist. "-dev" jars are only used as a last resort.
 */
function resolvePluginJar () {
  if (fs.existsSync(PLUGIN_DIST_PREFERRED)) return { path: PLUGIN_DIST_PREFERRED, policy: 'preferred-final-3.2.0' }
  if (fs.existsSync(PLUGIN_DIST_FALLBACK)) return { path: PLUGIN_DIST_FALLBACK, policy: 'fallback-3.1.0-delivery' }
  const distDir = path.join(ROOT, 'dist')
  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^BaseHider-.+\.jar$/i.test(name) && !/(sources|javadoc|original)/i.test(name))
    .map((name) => {
      const version = (name.match(/^BaseHider-([0-9][0-9A-Za-z.\-]*)\.jar$/) || [])[1] || '0'
      return { name, version }
    })
    .sort((a, b) => {
      const pa = a.version.split(/[.\-]/).map((x) => parseInt(x, 10) || 0)
      const pb = b.version.split(/[.\-]/).map((x) => parseInt(x, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })
  if (!candidates.length) throw new Error('no BaseHider-*.jar found in ' + distDir)
  const chosen = candidates[candidates.length - 1]
  return { path: path.join(distDir, chosen.name), policy: 'latest-available' }
}
const PACKETEVENTS_SOURCES = [
  path.join(DEFAULT_SERVER_DIR, 'plugins', 'PacketEvents.jar'),
  path.join(ROOT, 'itest', '.cache', 'PacketEvents.jar'),
  path.join(ROOT, 'itest', '.cache', 'PacketEvents-full.jar'),
  path.join(ROOT, 'itest', 'server', 'plugins', 'PacketEvents.jar')
]
const LOCK_PATH = path.join(BENCH_DIR, 'load-bench.lock')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()

function round (value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const m = Math.pow(10, digits)
  return Math.round(value * m) / m
}

function stripFormatting (text) {
  return String(text == null ? '' : text).replace(/§[0-9a-fklmnorx]/gi, '')
}

function quantile (sorted, q) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  return sorted[base]
}

function stats (values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1]),
    avg: round(sum / sorted.length)
  }
}

function sha256 (filePath) {
  try {
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(filePath))
    return hash.digest('hex')
  } catch (_) {
    return null
  }
}

// --------------------------------------------------------------------- CLI args
function parseArgs (argv) {
  const args = {
    bots: null,
    items: null,
    label: null,
    soakSeconds: 0,
    serverDir: DEFAULT_SERVER_DIR,
    serverPort: 25601,
    rconPort: 25600,
    rconPassword: 'itest-rcon-pass',
    serverHost: '127.0.0.1',
    staggerMs: 75,
    joinTimeoutMs: 180000,
    warmupMs: 5000,
    sampleCount: 6,
    sampleIntervalMs: 10000,
    churnIntervalMs: 20000,
    workers: 'auto',
    xms: '1G',
    xmx: '2G',
    maxRunMs: 25 * 60 * 1000,
    startupTimeoutMs: 300000,
    paperHeapProbe: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return argv[++i]
    }
    if (a === '--bots') args.bots = parseInt(next(), 10)
    else if (a === '--items') args.items = parseInt(next(), 10)
    else if (a === '--label') args.label = String(next())
    else if (a === '--soak-seconds') args.soakSeconds = parseInt(next(), 10)
    else if (a === '--server-dir') args.serverDir = path.resolve(next())
    else if (a === '--server-port') args.serverPort = parseInt(next(), 10)
    else if (a === '--rcon-port') args.rconPort = parseInt(next(), 10)
    else if (a === '--rcon-password') args.rconPassword = String(next())
    else if (a === '--stagger-ms') args.staggerMs = parseInt(next(), 10)
    else if (a === '--join-timeout-ms') args.joinTimeoutMs = parseInt(next(), 10)
    else if (a === '--warmup-ms') args.warmupMs = parseInt(next(), 10)
    else if (a === '--sample-count') args.sampleCount = parseInt(next(), 10)
    else if (a === '--sample-interval-ms') args.sampleIntervalMs = parseInt(next(), 10)
    else if (a === '--churn-interval-ms') args.churnIntervalMs = parseInt(next(), 10)
    else if (a === '--workers') args.workers = String(next())
    else if (a === '--xms') args.xms = String(next())
    else if (a === '--xmx') args.xmx = String(next())
    else if (a === '--max-run-ms') args.maxRunMs = parseInt(next(), 10)
    else if (a === '--startup-timeout-ms') args.startupTimeoutMs = parseInt(next(), 10)
    else if (a === '--paper-heap-probe') args.paperHeapProbe = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const argv = process.argv.slice(2)
const ARGS = parseArgs(argv)

if (ARGS.help) {
  console.log('See the header of bench/load-bench.js or bench/README-load-test.md for usage.')
  process.exit(0)
}

const USAGE_ERROR = []
if (!Number.isInteger(ARGS.bots) || ARGS.bots < 1) USAGE_ERROR.push('--bots must be a positive integer')
if (!Number.isInteger(ARGS.items) || ARGS.items < 0) USAGE_ERROR.push('--items must be a non-negative integer')
if (!ARGS.label) USAGE_ERROR.push('--label is required')
if (ARGS.label && !/^[A-Za-z0-9._-]+$/.test(ARGS.label)) USAGE_ERROR.push('--label may only contain letters, digits, dot, underscore, dash')
if (!Number.isInteger(ARGS.soakSeconds) || ARGS.soakSeconds < 0) USAGE_ERROR.push('--soak-seconds must be a non-negative integer')
if (ARGS.soakSeconds > 0 && (!ARGS.items || ARGS.items <= 0)) USAGE_ERROR.push('--soak-seconds requires --items > 0 (churn re-summons the datapack item field)')
if (ARGS.bots > 500) USAGE_ERROR.push('--bots > 500 is not supported by this harness')
if (USAGE_ERROR.length) {
  for (const e of USAGE_ERROR) console.error('ARG ERROR: ' + e)
  process.exit(2)
}

const LABEL = ARGS.label
const RESULT_PATH = path.join(BENCH_DIR, `load-${LABEL}.json`)
const SERVER_LOG_PATH = path.join(BENCH_DIR, `load-server-${LABEL}.log`)
const CONSOLE_LOG_PATH = path.join(BENCH_DIR, `load-console-${LABEL}.log`)
const ABORT_PATH = path.join(BENCH_DIR, `load-${LABEL}-aborted.json`)

function log (...parts) {
  const line = `[${new Date().toISOString()}] ` + parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')
  process.stdout.write(line + '\n')
  // synchronous append: the harness must never lose the tail of its evidence log
  try { fs.appendFileSync(CONSOLE_LOG_PATH, line + '\n', 'utf8') } catch (_) {}
}

// --------------------------------------------------------------------- global context / cleanup
const ACTIVE = {
  phase: 'init',
  serverChild: null,
  serverPid: null,
  rcon: null,
  workers: [],
  lockPath: null,
  serverPropertiesPath: null,
  serverPropertiesBefore: null,
  cleaned: false
}
let cleanupPromise = null

async function withTimeout (promise, timeoutMs, labelText) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms: ${labelText || 'operation'}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function runPowerShellJson (script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const attempt = (exe, args, fallback) => {
      execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          if (fallback) return attempt(fallback, args, null)
          return resolve({ ok: false, error: String(error.message || error), stderr: String(stderr || '') })
        }
        const text = String(stdout || '').trim()
        if (!text) return resolve({ ok: true, data: null })
        try {
          resolve({ ok: true, data: JSON.parse(text) })
        } catch (parseError) {
          resolve({ ok: true, data: null, raw: text, parseError: String(parseError.message) })
        }
      })
    }
    attempt('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 'pwsh.exe')
  })
}

async function portInUse (port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function findPortOwnerPids (port) {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      const pids = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5) continue
        const local = cols[1]
        const state = cols[3]
        if (state !== 'LISTENING') continue
        if (!local.endsWith(':' + port)) continue
        const pid = parseInt(cols[4], 10)
        if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid)
      }
      resolve(pids)
    })
  })
}

function findPaperProcesses () {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | Where-Object { $_.CommandLine -like '*paper-1.21.4.jar*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
  return runPowerShellJson(script, 20000)
}

function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

async function acquireLock () {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, 'utf8')
      let existing = null
      try { existing = JSON.parse(raw) } catch (_) {}
      if (existing && existing.pid && pidAlive(existing.pid)) {
        throw new Error(`another load-bench run is active (lock ${LOCK_PATH}, pid ${existing.pid}, started ${existing.startedAt})`)
      }
      fs.rmSync(LOCK_PATH, { force: true })
    }
  } catch (error) {
    if (error && /another load-bench run is active/.test(error.message)) throw error
    // unreadable/stale lock: overwrite below
  }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: nowIso(), label: LABEL }, null, 2), 'utf8')
  ACTIVE.lockPath = LOCK_PATH
}

function releaseLock () {
  try {
    if (ACTIVE.lockPath) fs.rmSync(ACTIVE.lockPath, { force: true })
  } catch (_) {}
  ACTIVE.lockPath = null
}

async function cleanup (reason) {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    if (ACTIVE.cleaned) return ACTIVE.cleanupResult
    ACTIVE.cleaned = true
    ACTIVE.phase = 'cleanup:' + (reason || '')
    const result = { reason: reason || 'normal', steps: [] }
    log('cleanup start (' + (reason || 'normal') + ')')

    // 1) quit bot workers first (so /stop is not slowed by 200 disconnects)
    const workers = ACTIVE.workers.slice()
    for (const worker of workers) {
      try {
        if (worker.child && worker.child.exitCode === null && worker.input) {
          worker.input.write(JSON.stringify({ cmd: 'quit' }) + '\n')
        }
      } catch (_) {}
    }
    for (const worker of workers) {
      const code = await waitForChildExit(worker.child, 8000)
      if (code === null) {
        try { worker.child.kill() } catch (_) {}
        const code2 = await waitForChildExit(worker.child, 5000)
        result.steps.push({ step: 'bot-worker', worker: worker.index, graceful: false, exitCode: code2 })
      } else {
        result.steps.push({ step: 'bot-worker', worker: worker.index, graceful: true, exitCode: code })
      }
    }
    ACTIVE.workers = []

    // 2) remove the test item field, then stop server via RCON
    if (ACTIVE.rcon) {
      try {
        const itemCleanup = await withTimeout(ACTIVE.rcon.cmd('kill @e[type=minecraft:item]'), 15000, 'rcon item cleanup')
        result.itemCleanupResponse = stripFormatting(itemCleanup).trim()
      } catch (error) {
        result.itemCleanupError = String(error && error.message ? error.message : error)
      }
      try {
        const response = await withTimeout(ACTIVE.rcon.cmd('stop'), 20000, 'rcon stop')
        result.rconStopResponse = stripFormatting(response).trim()
      } catch (error) {
        result.rconStopError = String(error && error.message ? error.message : error)
      }
      try { ACTIVE.rcon.close() } catch (_) {}
      ACTIVE.rcon = null
    }

    // 3) wait for the Paper child to exit
    if (ACTIVE.serverChild) {
      const exitCode = await waitForChildExit(ACTIVE.serverChild, 90000)
      if (exitCode === null) {
        result.steps.push({ step: 'paper-stop', graceful: false, note: 'killed after 90s' })
        try { ACTIVE.serverChild.kill() } catch (_) {}
        await waitForChildExit(ACTIVE.serverChild, 15000)
      } else {
        result.steps.push({ step: 'paper-stop', graceful: true, exitCode })
      }
    }

    // 4) ALWAYS free ports, but never kill a process we did not start
    const portDeadline = Date.now() + 30000
    const ports = [ARGS.serverPort, ARGS.rconPort]
    result.ports = {}
    while (Date.now() < portDeadline) {
      let anyBusy = false
      for (const port of ports) {
        if (await portInUse(port)) anyBusy = true
      }
      if (!anyBusy) break
      await sleep(500)
    }
    for (const port of ports) {
      const busy = await portInUse(port)
      const owners = busy ? await findPortOwnerPids(port) : []
      result.ports[port] = { free: !busy, ownerPids: owners }
      if (busy && owners.length && owners.includes(ACTIVE.serverPid)) {
        try { process.kill(ACTIVE.serverPid) } catch (_) {}
      }
    }
    result.portsAllFree = Object.values(result.ports).every((state) => state.free)

    // 5) restore the original server.properties (server has flushed its own copy on stop)
    if (ACTIVE.serverPropertiesPath && ACTIVE.serverPropertiesBefore != null) {
      try {
        fs.writeFileSync(ACTIVE.serverPropertiesPath, ACTIVE.serverPropertiesBefore, 'utf8')
        result.serverPropertiesRestored = true
      } catch (error) {
        result.serverPropertiesRestored = false
        result.serverPropertiesRestoreError = String(error && error.message ? error.message : error)
      }
    }

    releaseLock()
    ACTIVE.cleanupResult = result
    log('cleanup done: portsAllFree=' + result.portsAllFree)
    return result
  })()
  return cleanupPromise
}

function waitForChildExit (child, timeoutMs) {
  if (!child) return Promise.resolve(null)
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.once('exit', (code) => finish(code === null ? -1 : code))
  })
}

// hard watchdog: never leave a Paper server or 200 bots behind
const watchdogTimer = setTimeout(async () => {
  log('HARD TIMEOUT reached; attempting emergency cleanup')
  try { await cleanup('hard-timeout') } catch (error) { log('emergency cleanup error: ' + (error && error.message)) }
  process.exit(3)
}, Math.max(60000, ARGS.maxRunMs))
watchdogTimer.unref()

let signalAbort = false
async function onSignal (signal) {
  if (signalAbort) return
  signalAbort = true
  log('received ' + signal + '; attempting emergency cleanup')
  try { await cleanup('signal-' + signal) } catch (error) { log('signal cleanup error: ' + (error && error.message)) }
  process.exit(130)
}
process.on('SIGINT', () => { onSignal('SIGINT') })
process.on('SIGTERM', () => { onSignal('SIGTERM') })

// --------------------------------------------------------------------- RCON helpers
function loadRcon () {
  // rcon.js is CommonJS exporting { Rcon }
  return require(RCON_LIB)
}

async function connectRcon (timeoutMs = 90000) {
  const { Rcon } = loadRcon()
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    const rcon = new Rcon({ host: ARGS.serverHost, port: ARGS.rconPort, password: ARGS.rconPassword, timeoutMs: 60000 })
    try {
      await rcon.connect()
      ACTIVE.rcon = rcon
      return rcon
    } catch (error) {
      lastError = error
      try { rcon.close() } catch (_) {}
      await sleep(1000)
    }
  }
  throw new Error('could not connect to RCON: ' + (lastError && lastError.message))
}

async function rconCmd (command) {
  const startedAt = Date.now()
  const rcon = ACTIVE.rcon
  if (!rcon) return { ok: false, command, raw: '', error: 'rcon not connected', latencyMs: 0 }
  try {
    const response = await rcon.cmd(command)
    return { ok: true, command, raw: response == null ? '' : String(response), latencyMs: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, command, raw: '', error: String(error && error.message ? error.message : error), latencyMs: Date.now() - startedAt }
  }
}

// --------------------------------------------------------------------- parsers
function parseMspt (raw) {
  const clean = stripFormatting(raw)
  const groups = [...clean.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/g)]
  const windows = groups.slice(0, 3).map((match, index) => ({
    window: ['5s', '10s', '1m'][index] || `g${index}`,
    avg: Number(match[1]),
    min: Number(match[2]),
    max: Number(match[3])
  }))
  return {
    raw: clean.trim(),
    line: clean.split('\n').find((line) => /tick times/i.test(line)) || null,
    windows: windows.length ? windows : null
  }
}

function parseTps (raw) {
  const clean = stripFormatting(raw)
  const line = clean.split('\n').find((l) => /TPS/i.test(l)) || null
  let values = null
  if (line) {
    const colon = line.lastIndexOf(':')
    const payload = colon >= 0 ? line.slice(colon + 1) : line
    const numbers = (payload.match(/[0-9]+(?:\.[0-9]+)?/g) || []).map(Number)
    if (numbers.length >= 1) values = numbers.slice(0, 3)
  }
  return { raw: clean.trim(), line, values }
}

function parseDiag (raw) {
  const text = stripFormatting(raw)
  const get = (regex) => {
    const m = regex.exec(text)
    return m ? Number(m[1]) : null
  }
  return {
    raw: text.trim(),
    available: /BaseHider diag/.test(text),
    tickLastUs: get(/Security tick last\/avg\/max: (\d+)/),
    tickAvgUs: get(/Security tick last\/avg\/max: \d+ \/ (\d+)/),
    tickMaxUs: get(/Security tick last\/avg\/max: \d+ \/ \d+ \/ (\d+)/),
    p50Us: get(/p50\/p95\/p99: (\d+)/),
    p95Us: get(/p50\/p95\/p99: \d+\/(\d+)/),
    p99Us: get(/p50\/p95\/p99: \d+\/\d+\/(\d+)/),
    overruns: get(/overruns: (\d+)/),
    itemDecisionLastUs: get(/Engine time \(item\/block\) last: (\d+)\//),
    blockDecisionLastUs: get(/Engine time \(item\/block\) last: \d+\/(\d+)/),
    itemDecisionMaxUs: get(/Engine time \(item\/block\) last: \d+\/\d+ us max: (\d+)\//),
    blockDecisionMaxUs: get(/Engine time \(item\/block\) last: \d+\/\d+ us max: \d+\/(\d+)/),
    raycasts: get(/Raycasts: (\d+)/),
    raycastsDeferred: get(/deferred by budget: (\d+)/),
    budgetRemaining: get(/budget remaining: (\d+)\/(\d+)/),
    trackedItems: get(/Item engine: tracked=(\d+)/),
    revealedPairs: get(/tracked=\d+ revealedPairs=(\d+)/),
    dirtyQueue: get(/dirtyQueue=(\d+)/),
    viewerIndexChunks: get(/viewerIndexChunks=(\d+)/),
    itemChunks: get(/itemChunks=(\d+)/),
    itemEvals: get(/Item engine: .* evals=(\d+)/),
    blockEvals: get(/Block engine: .* evals=(\d+)/),
    discoveryQueue: get(/Discovery queue: (\d+)/),
    resyncPending: get(/resync pending: (\d+)/),
    occlusionRevision: get(/occlusion rev: (\d+)/),
    asyncSubmitted: get(/Async: submitted=(\d+)/),
    asyncRejected: get(/Async: submitted=\d+ rejected=(\d+)/),
    asyncQueueSize: get(/Async: submitted=\d+ rejected=\d+ queue=(\d+)/),
    asyncThreads: get(/threads=(\d+)/),
    errors: get(/Errors\/config warnings: (\d+)\/\d+/),
    configWarnings: get(/Errors\/config warnings: \d+\/(\d+)/),
    gatewayState: (/Gateway: state=([A-Z_]+)/.exec(text) || [])[1] || null,
    chunkSanitized: get(/chunkSanitized=(\d+)/),
    chunkFailClosed: get(/chunkFailClosed=(\d+)/),
    blockFaked: get(/blockFaked=(\d+)/),
    itemSpawnBlocked: get(/itemSpawnBlocked=(\d+)/),
    entityChosenCancelled: get(/entityChosenPacketsCancelled=(\d+)/),
    gatewayErrors: get(/packetDetectedOverflow=(\d+)/),
    packetDetectedBlocks: get(/packetDetectedBlocks=(\d+)/),
    indexWorlds: get(/Index: w=(\d+)/),
    indexBlocks: get(/w=\d+ blocks=(\d+)/),
    indexChunks: get(/w=\d+ blocks=\d+ chunks=(\d+)/)
  }
}

function parsePaperHeap (raw) {
  // NOTE: In Paper 1.21.4 `/paper heap` does NOT print used/max MB: it writes a
  // .hprof heap dump to disk (Sponge-derived "heap dump" command). Running it
  // every 10 s would produce multi-hundred-MB files and violently distort the
  // samples, so the harness deliberately does not invoke it. This parser is
  // retained for the opt-in --paper-heap-probe path and marks the command as
  // unavailable when it is skipped.
  const text = stripFormatting(raw).trim()
  const unknown = /unknown|incomplete command|not found|usage:/i.test(text)
  const usedMatch = /(?:used|heap used|memory used)[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(MB|MiB|M|GB|GiB|G|KB|K)\b/i.exec(text)
  const maxMatch = /(?:max(?:imum)?|committed)[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(MB|MiB|M|GB|GiB|G|KB|K)\b/i.exec(text)
  const toMB = (match) => {
    if (!match) return null
    const value = Number(match[1])
    const unit = match[2].toUpperCase()
    if (unit.startsWith('G')) return round(value * 1024)
    if (unit.startsWith('K')) return round(value / 1024)
    return round(value)
  }
  return {
    raw: text,
    invoked: true,
    available: !unknown && !/heap dump/i.test(text) && text.length > 0,
    usedMB: toMB(usedMatch),
    maxMB: toMB(maxMatch),
    note: /heap dump/i.test(text)
      ? 'paper heap wrote a .hprof heap dump instead of printing usage'
      : null
  }
}

/**
 * Parse `/spark health` (bundled with Paper) for TPS / CPU / used+max memory.
 * Example output lines (colour stripped):
 *   TPS: 20.0, MSPT: 1.2
 *   CPU usage: 12.3%
 *   Memory usage: 512MB / 2048MB (25.0%)
 */
function parseSparkHealth (raw) {
  const text = stripFormatting(raw).trim()
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const memLine = lines.find((line) => /memory/i.test(line)) || null
  let usedMB = null
  let maxMB = null
  if (memLine) {
    const converted = [...memLine.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(MB|MiB|M|GB|GiB|G|KB|K)\b/gi)].map((m) => {
      const value = Number(m[1])
      const unit = m[2].toUpperCase()
      if (unit.startsWith('G')) return value * 1024
      if (unit.startsWith('K')) return value / 1024
      return value
    })
    if (converted.length >= 2) {
      usedMB = round(converted[0], 1)
      maxMB = round(converted[1], 1)
    }
  }
  const cpuLine = lines.find((line) => /cpu/i.test(line)) || null
  const cpuMatch = cpuLine ? /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(cpuLine) : null
  return {
    raw: text,
    available: lines.some((line) => !/unknown|incomplete command/i.test(text)) && lines.length > 0,
    line: memLine,
    usedMB,
    maxMB,
    cpuPct: cpuMatch ? Number(cpuMatch[1]) : null
  }
}

function parseJvmHeapInfo (raw) {
  const text = stripFormatting(raw)
  const heap = /garbage-first heap\s+total\s+(\d+)K,\s+used\s+(\d+)K/.exec(text) ||
    /total\s+(\d+)K,\s+used\s+(\d+)K/.exec(text)
  const meta = /Metaspace\s+used\s+(\d+)K,\s+committed\s+(\d+)K/.exec(text)
  return {
    ok: !!heap,
    raw: text.trim(),
    heapTotalMB: heap ? round(Number(heap[1]) / 1024, 1) : null,
    heapUsedMB: heap ? round(Number(heap[2]) / 1024, 1) : null,
    metaspaceUsedMB: meta ? round(Number(meta[1]) / 1024, 1) : null
  }
}

// --------------------------------------------------------------------- CPU / process sampling
class CpuSampler {
  constructor () {
    this.prev = this.snapshot()
  }

  snapshot () {
    let idle = 0
    let total = 0
    for (const cpu of os.cpus()) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    return { idle, total }
  }

  sample () {
    const cur = this.snapshot()
    const idleDelta = cur.idle - this.prev.idle
    const totalDelta = cur.total - this.prev.total
    this.prev = cur
    if (totalDelta <= 0) return null
    return round(100 * (1 - idleDelta / totalDelta), 1)
  }
}

function getServerProcessStats (pid) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    'if ($p) { [pscustomobject]@{ id = $p.Id; cpu = $p.CPU; ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64 } | ConvertTo-Json -Compress } else { "null" }'
  return runPowerShellJson(script, 15000).then((result) => {
    if (!result.ok || !result.data) return { ok: false, raw: result.raw || result.error || null }
    const data = result.data
    return {
      ok: true,
      pid: data.id,
      cpuSeconds: round(data.cpu),
      workingSetMB: round(data.ws / (1024 * 1024), 1),
      privateMB: round(data.priv / (1024 * 1024), 1)
    }
  })
}

function getJvmHeap (pid) {
  return new Promise((resolve) => {
    execFile(JCMD, [String(pid), 'GC.heap_info'], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return resolve({ ok: false, error: String(error.message || error), stderr: String(stderr || '') })
      }
      resolve(parseJvmHeapInfo(stdout))
    })
  })
}

// --------------------------------------------------------------------- server dir preparation
function readPropertiesFile (filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const map = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    map.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return { text, map }
}

function writePropertiesFile (filePath, map) {
  const lines = ['# Minecraft server properties', '# Rewritten by D:/Basehider/bench/load-bench.js for the load test', '#']
  for (const key of [...map.keys()].sort()) lines.push(key + '=' + map.get(key))
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
}

async function prepareServerDir (props) {
  const serverDir = ARGS.serverDir
  let paperJar = path.join(serverDir, 'paper-1.21.4.jar')
  if (!fs.existsSync(paperJar)) {
    // First run in a fresh isolated dir: copy the Paper jar read-only from the
    // integration harness directory (we never modify the source).
    if (!fs.existsSync(PAPER_SOURCE_JAR)) throw new Error('paper jar not found: ' + paperJar + ' and no source jar at ' + PAPER_SOURCE_JAR)
    fs.mkdirSync(serverDir, { recursive: true })
    fs.copyFileSync(PAPER_SOURCE_JAR, paperJar)
  }
  if (!fs.existsSync(paperJar)) throw new Error('paper jar not found: ' + paperJar)
  // eula: this is a disposable local test server owned by the harness
  const eulaPath = path.join(serverDir, 'eula.txt')
  if (!fs.existsSync(eulaPath) || !/eula\s*=\s*true/i.test(fs.readFileSync(eulaPath, 'utf8'))) {
    fs.writeFileSync(eulaPath, 'eula=true\n', 'utf8')
  }
  const pluginSource = resolvePluginJar()
  if (!fs.existsSync(pluginSource.path)) throw new Error('dist plugin jar not found: ' + pluginSource.path)
  const pluginsDir = path.join(serverDir, 'plugins')
  fs.mkdirSync(pluginsDir, { recursive: true })

  // BaseHider: always a fresh copy from dist (never modify/replace dist itself)
  const baseHiderTarget = path.join(pluginsDir, 'BaseHider.jar')
  fs.copyFileSync(pluginSource.path, baseHiderTarget)
  const baseHider = {
    source: pluginSource.path,
    sourceName: path.basename(pluginSource.path),
    selectionPolicy: pluginSource.policy,
    target: baseHiderTarget,
    sourceSha256: sha256(pluginSource.path),
    targetSha256: sha256(baseHiderTarget),
    sizeBytes: fs.statSync(baseHiderTarget).size
  }

  // PacketEvents: required by BaseHider's block protection. Use existing jar or
  // the cached copy shipped with the itest harness.
  const packetEventsTarget = path.join(pluginsDir, 'PacketEvents.jar')
  let packetEvents = { target: packetEventsTarget, source: null, sizeBytes: null }
  if (fs.existsSync(packetEventsTarget)) {
    packetEvents.source = 'existing'
    packetEvents.sizeBytes = fs.statSync(packetEventsTarget).size
  } else {
    const source = PACKETEVENTS_SOURCES.find((candidate) => fs.existsSync(candidate))
    if (!source) throw new Error('PacketEvents.jar is missing from plugins/ and no cached copy was found in itest/.cache')
    fs.copyFileSync(source, packetEventsTarget)
    packetEvents = {
      target: packetEventsTarget,
      source,
      sizeBytes: fs.statSync(packetEventsTarget).size
    }
  }

  // Record the BaseHider config in effect (the plugin creates/uses this file).
  const baseHiderConfigPath = path.join(pluginsDir, 'BaseHider', 'config.yml')
  let baseHiderConfig = null
  if (fs.existsSync(baseHiderConfigPath)) {
    const configText = fs.readFileSync(baseHiderConfigPath, 'utf8')
    baseHiderConfig = {
      path: baseHiderConfigPath,
      sha256: sha256(baseHiderConfigPath),
      text: configText
    }
  }

  // server.properties rewrite (all values required by the load test)
  const propertiesPath = path.join(serverDir, 'server.properties')
  const before = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, 'utf8') : null
  const parsed = before != null ? readPropertiesFile(propertiesPath) : { map: new Map() }
  const map = parsed.map
  const set = (key, value) => map.set(key, String(value))
  set('online-mode', 'false')
  set('enforce-secure-profile', 'false')
  set('server-ip', ARGS.serverHost)
  set('server-port', ARGS.serverPort)
  set('level-name', 'world')
  set('level-seed', '123456789') // fixed seed: reproducible flat world for the item field
  if (!map.has('level-type')) set('level-type', 'minecraft:flat')
  if (!map.has('generator-settings')) {
    set('generator-settings', '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}')
  }
  set('view-distance', '4')
  set('simulation-distance', '4')
  set('spawn-protection', '0')
  set('difficulty', 'peaceful')
  set('allow-flight', 'true')
  set('allow-nether', 'false')
  set('allow-end', 'false')
  set('generate-structures', 'false')
  set('spawn-animals', 'false')
  set('spawn-monsters', 'false')
  set('spawn-npcs', 'false')
  set('pvp', 'false')
  set('enable-rcon', 'true')
  set('rcon.port', ARGS.rconPort)
  set('rcon.password', ARGS.rconPassword)
  const maxPlayers = Math.max(ARGS.bots + 10, Number(map.get('max-players')) || 0)
  set('max-players', maxPlayers)
  set('network-compression-threshold', '-1')
  set('rate-limit', '0')
  set('player-idle-timeout', '0')
  set('pause-when-empty-seconds', '-1')
  set('sync-chunk-writes', 'false')
  set('motd', 'BaseHider load test ' + LABEL)
  writePropertiesFile(propertiesPath, map)
  if (before != null) ACTIVE.serverPropertiesPath = propertiesPath
  ACTIVE.serverPropertiesBefore = before

  return {
    serverDir,
    paperJar,
    paperJarSizeBytes: fs.statSync(paperJar).size,
    baseHider,
    baseHiderConfig,
    packetEvents,
    serverPropertiesPath: propertiesPath,
    propertiesBefore: before,
    propertiesApplied: Object.fromEntries([...map.entries()].sort()),
    maxPlayers
  }
}

// --------------------------------------------------------------------- server lifecycle
function startServer () {
  const serverDir = ARGS.serverDir
  const logPath = SERVER_LOG_PATH
  fs.rmSync(logPath, { force: true })
  log('starting Paper: java -Xms' + ARGS.xms + ' -Xmx' + ARGS.xmx + ' -jar paper-1.21.4.jar --nogui (cwd ' + serverDir + ')')
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(JAVA, ['-Xms' + ARGS.xms, '-Xmx' + ARGS.xmx, '-jar', 'paper-1.21.4.jar', '--nogui'], {
    cwd: serverDir,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  })
  try { fs.closeSync(logFd) } catch (_) {}
  ACTIVE.serverChild = child
  ACTIVE.serverPid = child.pid
  ACTIVE.phase = 'server-starting'
  return { child, logPath, startedAt: Date.now() }
}

async function waitForServerDone (ctx) {
  const deadline = Date.now() + ARGS.startupTimeoutMs
  let scanned = ''
  let fileOffset = 0
  let exited = false
  let exitCode = null
  ctx.child.once('exit', (code) => {
    exited = true
    exitCode = code
    log('Paper process exited during startup with code ' + code)
  })
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(ctx.logPath)
      if (stat.size > fileOffset) {
        const fd = fs.openSync(ctx.logPath, 'r')
        const length = stat.size - fileOffset
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, fileOffset)
        fs.closeSync(fd)
        fileOffset = stat.size
        scanned += buffer.toString('utf8')
        if (scanned.length > 400000) scanned = scanned.slice(-200000)
      }
    } catch (_) {}
    if (/Done \(/.test(scanned)) {
      ctx.startupMs = Date.now() - ctx.startedAt
      log('Paper reached "Done (" after ' + ctx.startupMs + ' ms')
      return { startupMs: ctx.startupMs }
    }
    if (exited) break
    await sleep(400)
  }
  throw new Error('server did not reach "Done (" within ' + ARGS.startupTimeoutMs + ' ms' + (exited ? ` (process exited, code ${exitCode})` : ''))
}

function readFileTail (filePath, maxBytes = 400000) {
  try {
    const stat = fs.statSync(filePath)
    const length = Math.min(stat.size, maxBytes)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, stat.size - length)
    fs.closeSync(fd)
    return buffer.toString('utf8')
  } catch (_) {
    return ''
  }
}

// --------------------------------------------------------------------- datapack / items
async function prepareItems (serverPrep) {
  const startedAt = Date.now()
  const datapack = generateDatapack({ count: ARGS.items, serverDir: ARGS.serverDir })
  log('datapack written: ' + datapack.functionPath + ' (' + datapack.commandCount + ' commands, spacing ' +
    datapack.layout.spacing + ', layers ' + datapack.layout.layers + ', ' + JSON.stringify({ x: [datapack.layout.xMin, datapack.layout.xMax], z: [datapack.layout.zMin, datapack.layout.zMax], y: [datapack.layout.yMin, datapack.layout.yMax] }))
  void startedAt
  return datapack
}

async function summonAndVerifyItems (datapack) {
  const verification = { functionId: FUNCTION_ID, commands: {} }

  // Clean any item entities left in the world by earlier runs before summoning
  // the measured field. Without this, entity counts and the plugin's
  // "unexpected item spawn blocked" counters would include stale items.
  const preKill = await rconCmd('kill @e[type=minecraft:item]')
  verification.preCleanKill = preKill
  await sleep(300)
  const preCountResponse = await rconCmd('execute if entity @e[type=minecraft:item]')
  verification.commands.preCleanCount = preCountResponse
  const preMatch = /count:\s*(\d+)/.exec(stripFormatting(preCountResponse.raw))
  verification.preExistingItems = preMatch ? Number(preMatch[1]) : 0
  const datapackList = await rconCmd('datapack list')
  verification.commands.datapackList = datapackList
  verification.datapackEnabled = /bhload/i.test(stripFormatting(datapackList.raw))
  if (!verification.datapackEnabled) log('WARNING: datapack list does not mention bhload: ' + stripFormatting(datapackList.raw).slice(0, 300))

  const summonStarted = Date.now()
  const summon = await rconCmd('function ' + FUNCTION_ID)
  verification.summon = summon
  verification.summonDurationMs = Date.now() - summonStarted
  verification.summonAccepted = summon.ok && !/unknown|incomplete|error/i.test(stripFormatting(summon.raw) + ' ' + stripFormatting(summon.error || ''))
  log('function ' + FUNCTION_ID + ': ' + (verification.summonAccepted ? 'accepted' : 'FAILED') + ' (' + verification.summonDurationMs + ' ms)')

  await sleep(1000)
  const checkOk = await rconCmd('execute if entity @e[type=minecraft:item,limit=1] run say ITEM_OK')
  verification.commands.executeIfSay = checkOk
  let itemOk = /ITEM_OK/.test(stripFormatting(checkOk.raw))
  if (!itemOk) {
    itemOk = /ITEM_OK/.test(readFileTail(SERVER_LOG_PATH, 200000))
  }
  verification.itemOk = itemOk

  const checkCount = await rconCmd('execute if entity @e[type=minecraft:item]')
  verification.commands.executeIf = checkCount
  const countMatch = /count:?\s*(\d+)|(\d+)\s+entit/i.exec(stripFormatting(checkCount.raw))
  verification.entityCountFromExecuteIf = countMatch ? Number(countMatch[1] || countMatch[2]) : null
  verification.entityCountMatchesRequested = verification.entityCountFromExecuteIf === ARGS.items

  // Independent count via Paper's kill command is destructive; instead use the
  // plugin's own tracked-item count once bots are connected (first sample).
  verification.expectedItems = ARGS.items
  verification.note = 'entity count verified by /basehider diag trackedItems after bots connect; /execute if entity proves existence'
  return verification
}

// --------------------------------------------------------------------- bots
function planWorkers (totalBots) {
  if (ARGS.workers !== 'auto') {
    const n = Math.max(1, parseInt(ARGS.workers, 10) || 1)
    return Math.min(n, totalBots)
  }
  if (totalBots <= 100) return 1
  if (totalBots <= 250) return 2
  return 3
}

function spawnBotWorkers (totalBots) {
  const workerCount = planWorkers(totalBots)
  const workers = []
  let startIndex = 1
  for (let w = 0; w < workerCount; w++) {
    const remainingWorkers = workerCount - w
    const remainingBots = totalBots - (startIndex - 1)
    const count = Math.ceil(remainingBots / remainingWorkers)
    const worker = {
      index: w + 1,
      startIndex,
      count,
      child: null,
      input: null,
      stdoutBuffer: '',
      stderrBuffer: '',
      stderrLines: [],
      exitCode: null,
      exitAt: null,
      events: { spawned: 0, failed: 0 },
      lastStatus: null,
      summary: null,
      fatal: null
    }
    workers.push(worker)
    startIndex += count
  }

  for (const worker of workers) {
    const child = spawn(NODE, [
      BOT_SCRIPT,
      '--bots', String(worker.count),
      '--start-index', String(worker.startIndex),
      '--username-prefix', 'LoadBot',
      '--host', ARGS.serverHost,
      '--port', String(ARGS.serverPort),
      '--version', '1.21.4',
      '--stagger-ms', String(ARGS.staggerMs),
      '--max-ms', String(Math.max(120000, ARGS.maxRunMs))
    ], {
      cwd: BENCH_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, { MC_PROTOCOL_DIR: path.join(ROOT, 'itest', 'bot', 'node_modules') })
    })
    worker.child = child
    worker.input = child.stdin
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => onWorkerStdout(worker, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      worker.stderrBuffer += chunk
      if (worker.stderrBuffer.length > 200000) worker.stderrBuffer = worker.stderrBuffer.slice(-100000)
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) worker.stderrLines.push(line.trim())
      }
      if (worker.stderrLines.length > 200) worker.stderrLines = worker.stderrLines.slice(-200)
    })
    child.on('exit', (code) => {
      worker.exitCode = code
      worker.exitAt = nowIso()
      log('bot worker ' + worker.index + ' exited with code ' + code)
    })
    child.on('error', (error) => {
      worker.fatal = String(error && error.message ? error.message : error)
      log('bot worker ' + worker.index + ' spawn error: ' + worker.fatal)
    })
    log('spawned bot worker ' + worker.index + ': ' + worker.count + ' bots (indices ' + worker.startIndex + '..' + (worker.startIndex + worker.count - 1) + ')')
  }
  ACTIVE.workers = workers
  return workers
}

function onWorkerStdout (worker, chunk) {
  worker.stdoutBuffer += chunk
  const lines = worker.stdoutBuffer.split('\n')
  worker.stdoutBuffer = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (_) {
      worker.unparsed = worker.unparsed || []
      if (worker.unparsed.length < 50) worker.unparsed.push(line.slice(0, 400))
      continue
    }
    handleWorkerEvent(worker, event)
  }
}

function onBotEvent (event) {
  if (event.type === 'bot_spawned') {
    ACTIVE.botSpawned.push(event)
  } else if (event.type === 'bot_failed') {
    ACTIVE.botFailures.push(event)
  }
}

function handleWorkerEvent (worker, event) {
  if (!event || typeof event.type !== 'string') return
  if (event.type === 'status' && worker.statusWaiters && worker.statusWaiters.length) {
    const waiters = worker.statusWaiters
    worker.statusWaiters = []
    for (const waiter of waiters) {
      try { waiter(event) } catch (_) {}
    }
  }
  if (event.type === 'bot_spawned') {
    worker.events.spawned++
    onBotEvent(event)
  } else if (event.type === 'bot_failed') {
    worker.events.failed++
    onBotEvent(event)
  } else if (event.type === 'status') {
    worker.lastStatus = event
  } else if (event.type === 'summary') {
    worker.summary = event
  } else if (event.type === 'worker_started') {
    worker.started = event
  } else if (event.type === 'fatal' || event.type === 'worker_uncaught') {
    worker.fatal = event.error || event
    log('bot worker ' + worker.index + ' ' + event.type + ': ' + String(event.error).slice(0, 300))
  }
}

function allWorkersExited (workers) {
  return workers.length > 0 && workers.every((w) => w.child && w.child.exitCode !== null)
}

async function waitForBotSpawn () {
  const target = Math.ceil(ARGS.bots * 0.95)
  const deadline = Date.now() + ARGS.joinTimeoutMs
  const workers = ACTIVE.workers
  let lastLog = 0
  while (Date.now() < deadline) {
    const spawned = ACTIVE.botSpawned.length
    if (spawned >= target) {
      return { reached: true, target, spawned, waitedMs: Date.now() - ACTIVE.joinStartedAt, timedOut: false }
    }
    if (allWorkersExited(workers)) break
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now()
      const failures = ACTIVE.botFailures.length
      log(`join progress: ${spawned}/${ARGS.bots} spawned (target ${target}), ${failures} failed, ${Math.round((Date.now() - ACTIVE.joinStartedAt) / 1000)}s elapsed`)
    }
    await sleep(250)
  }
  return {
    reached: ACTIVE.botSpawned.length >= target,
    target,
    spawned: ACTIVE.botSpawned.length,
    waitedMs: Date.now() - ACTIVE.joinStartedAt,
    timedOut: true,
    workersExited: allWorkersExited(workers)
  }
}

async function getBotStatusSnapshot (timeoutMs = 5000) {
  const workers = ACTIVE.workers
  const waiters = workers.map((worker) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    worker.statusWaiters = worker.statusWaiters || []
    worker.statusWaiters.push((event) => {
      clearTimeout(timer)
      resolve(event)
    })
  }))
  for (const worker of workers) {
    try {
      worker.input.write(JSON.stringify({ cmd: 'status' }) + '\n')
    } catch (_) {}
  }
  const events = await Promise.all(waiters)
  const statuses = []
  const aggregate = { workers: workers.length, workersResponded: 0, bots: 0, spawned: 0, alive: 0, failed: 0, totalPackets: 0, totalBytes: 0 }
  for (let i = 0; i < workers.length; i++) {
    const event = events[i]
    if (!event) continue
    aggregate.workersResponded++
    aggregate.bots += event.workerBots || 0
    aggregate.spawned += event.spawned || 0
    aggregate.alive += event.alive || 0
    aggregate.failed += event.failed || 0
    aggregate.totalPackets += event.totalPackets || 0
    aggregate.totalBytes += event.totalBytes || 0
    statuses.push({
      worker: workers[i].index,
      workerBots: event.workerBots,
      spawned: event.spawned,
      alive: event.alive,
      failed: event.failed,
      totalPackets: event.totalPackets,
      totalBytes: event.totalBytes,
      bots: event.bots || []
    })
  }
  return { ok: aggregate.workersResponded === workers.length, aggregate, workers: statuses }
}

// --------------------------------------------------------------------- sampling
function makeCpuSampler () { return new CpuSampler() }

async function takeSample (ctx, index, phase) {
  const startedAt = Date.now()
  const sample = {
    index,
    phase,
    at: nowIso(),
    sinceStartMs: startedAt - ctx.runStartedAt,
    sinceJoinMs: ctx.joinStartedAt ? startedAt - ctx.joinStartedAt : null,
    hostCpuPct: ctx.cpuSampler.sample(),
    commands: {},
    mspt: null,
    tps: null,
    diag: null,
    paperHeap: null,
    jvmHeap: null,
    serverProcess: null,
    bots: null
  }

  sample.serverProcess = await getServerProcessStats(ACTIVE.serverPid)
  sample.jvmHeap = await getJvmHeap(ACTIVE.serverPid)
  sample.bots = await getBotStatusSnapshot(6000)

  const commandOrder = ['mspt', 'tps', 'basehider diag', 'basehider export']
  for (const command of commandOrder) {
    const response = await rconCmd(command)
    sample.commands[command] = response
  }

  sample.mspt = parseMspt(sample.commands.mspt.raw)
  sample.tps = parseTps(sample.commands.tps.raw)
  sample.diag = parseDiag(sample.commands['basehider diag'].raw)
  sample.sparkHealth = { available: false, note: 'not sampled: /spark health answers asynchronously and the RCON helper would drop the delayed reply' }
  // /paper heap in Paper 1.21.4 dumps a .hprof heap to disk instead of printing
  // used/max MB, so it is intentionally not part of the sampling loop.
  sample.paperHeap = {
    invoked: false,
    available: false,
    reason: 'Paper 1.21.4 /paper heap writes a .hprof heap dump to disk; it does not print used/max MB. ' +
      'Heap usage is measured with jcmd GC.heap_info instead. See README-load-test.md.'
  }
  // BaseHider 3.2.0 exposes /basehider export: schedules an async diagnostics.json
  // snapshot (includes itemStormBatches/itemStormMaxDepth and all live counters).
  if (sample.commands['basehider export'] && sample.commands['basehider export'].ok) {
    const snapshotPath = path.join(ARGS.serverDir, 'plugins', 'BaseHider', 'diagnostics.json')
    await sleep(400)
    sample.diagnosticsFile = readJsonFileWithMeta(snapshotPath)
    sample.diagnosticsSnapshot = sample.diagnosticsFile.data || null
  } else {
    sample.diagnosticsFile = null
    sample.diagnosticsSnapshot = null
  }
  sample.heap = {
    usedMB: sample.jvmHeap && sample.jvmHeap.heapUsedMB,
    committedMB: sample.jvmHeap && sample.jvmHeap.heapTotalMB,
    maxConfiguredMB: ctx.heapMaxConfiguredMB == null ? null : ctx.heapMaxConfiguredMB
  }
  sample.durationMs = Date.now() - startedAt
  return sample
}

function readJsonFileWithMeta (filePath) {
  try {
    const stat = fs.statSync(filePath)
    const text = fs.readFileSync(filePath, 'utf8')
    let data = null
    let parseError = null
    try { data = JSON.parse(text) } catch (error) { parseError = String(error.message) }
    return { path: filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, ageMs: Date.now() - stat.mtimeMs, data, parseError }
  } catch (error) {
    return { path: filePath, exists: false, error: String(error && error.message ? error.message : error) }
  }
}

function parseHeapSizeMB (text) {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([GgMmKk])$/.exec(String(text || '').trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  if (unit === 'G') return round(value * 1024)
  if (unit === 'K') return round(value / 1024)
  return round(value)
}

function sampleHeadline (sample) {
  const mspt5 = sample.mspt && sample.mspt.windows ? sample.mspt.windows[0] : null
  const diag = sample.diag || {}
  const heap = sample.heap || {}
  const snapshot = sample.diagnosticsSnapshot || {}
  return {
    sample: sample.index,
    phase: sample.phase,
    hostCpuPct: sample.hostCpuPct,
    mspt5s_avg: mspt5 ? mspt5.avg : null,
    mspt5s_max: mspt5 ? mspt5.max : null,
    tps: sample.tps && sample.tps.values ? sample.tps.values[0] : null,
    trackedItems: diag.trackedItems,
    basehiderP50: diag.p50Us,
    basehiderP95: diag.p95Us,
    basehiderP99: diag.p99Us,
    basehiderTickAvgUs: diag.tickAvgUs,
    basehiderTickMaxUs: diag.tickMaxUs,
    itemEvals: diag.itemEvals,
    itemStormBatches: snapshot.itemStormBatches == null ? null : snapshot.itemStormBatches,
    itemStormMaxDepth: snapshot.itemStormMaxDepth == null ? null : snapshot.itemStormMaxDepth,
    raycasts: diag.raycasts,
    heapUsedMB: heap.usedMB,
    heapMaxMB: heap.maxConfiguredMB,
    botsAlive: sample.bots ? sample.bots.aggregate.alive : null,
    serverWsMB: sample.serverProcess && sample.serverProcess.workingSetMB
  }
}

// --------------------------------------------------------------------- churn (soak)
async function churnItems (ctx, eventIndex) {
  const event = { index: eventIndex, at: nowIso(), atMs: Date.now() - ctx.runStartedAt }
  const kill = await rconCmd('kill @e[type=minecraft:item]')
  event.kill = kill
  event.killedCount = (() => {
    const m = /(\d+)\s+entit/i.exec(stripFormatting(kill.raw))
    return m ? Number(m[1]) : null
  })()
  const summonStarted = Date.now()
  const summon = await rconCmd('function ' + FUNCTION_ID)
  event.summon = summon
  event.summonDurationMs = Date.now() - summonStarted
  await sleep(300)
  const check = await rconCmd('execute if entity @e[type=minecraft:item,limit=1]')
  event.check = check
  event.itemPresent = /passed|Test passed/i.test(stripFormatting(check.raw)) || /ITEM_OK/.test(stripFormatting(check.raw))
  event.ok = kill.ok && summon.ok
  ACTIVE.soakChurnEvents.push(event)
  log(`churn #${eventIndex}: kill=${kill.ok ? 'ok' : 'ERR'} summon=${summon.ok ? 'ok' : 'ERR'} (${event.summonDurationMs} ms)`)
  return event
}

// --------------------------------------------------------------------- main
async function main () {
  const runStartedAt = Date.now()
  fs.writeFileSync(CONSOLE_LOG_PATH, '', 'utf8')
  const result = {
    harness: 'load-bench.js',
    harnessVersion: '1.0.0',
    label: LABEL,
    argv,
    runAt: nowIso(),
    env: {},
    params: {
      bots: ARGS.bots,
      items: ARGS.items,
      soakSeconds: ARGS.soakSeconds,
      serverPort: ARGS.serverPort,
      rconPort: ARGS.rconPort,
      staggerMs: ARGS.staggerMs,
      joinTimeoutMs: ARGS.joinTimeoutMs,
      warmupMs: ARGS.warmupMs,
      sampleCount: ARGS.sampleCount,
      sampleIntervalMs: ARGS.sampleIntervalMs,
      churnIntervalMs: ARGS.churnIntervalMs,
      workers: ARGS.workers,
      xms: ARGS.xms,
      xmx: ARGS.xmx,
      paperHeapProbe: ARGS.paperHeapProbe
    },
    paths: { result: RESULT_PATH, serverLog: SERVER_LOG_PATH, consoleLog: CONSOLE_LOG_PATH },
    status: 'running',
    join: null,
    datapack: null,
    itemsVerification: null,
    bots: null,
    samples: [],
    soak: null,
    summary: null,
    cleanup: null,
    limitations: []
  }

  const finish = async (exitCode) => {
    process.exit(exitCode)
  }

  try {
    ACTIVE.runStartedAt = runStartedAt
    ACTIVE.botSpawned = []
    ACTIVE.botFailures = []
    ACTIVE.soakChurnEvents = []
    ACTIVE.cpuSampler = makeCpuSampler()

    result.env = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      cpuModel: (os.cpus()[0] || {}).model || null,
      cpuCores: os.cpus().length,
      totalMemoryMB: round(os.totalmem() / (1024 * 1024)),
      freeMemoryMBAtStart: round(os.freemem() / (1024 * 1024)),
      node: process.version,
      nodeExec: NODE,
      java: JAVA,
      javaVersion: null,
      pid: process.pid
    }
    try {
      const { spawnSync } = require('child_process')
      const out = spawnSync(JAVA, ['-version'], { encoding: 'utf8', windowsHide: true })
      result.env.javaVersion = String((out.stderr || '') + (out.stdout || '')).trim()
    } catch (_) {}

    // ---- preflight -------------------------------------------------------
    ACTIVE.phase = 'preflight'
    log('preflight: checking ports ' + ARGS.serverPort + '/' + ARGS.rconPort + ' and foreign paper servers')
    const busyPorts = []
    for (const port of [ARGS.serverPort, ARGS.rconPort]) {
      if (await portInUse(port)) busyPorts.push(port)
    }
    if (busyPorts.length) {
      const details = []
      for (const port of busyPorts) {
        const pids = await findPortOwnerPids(port)
        details.push({ port, ownerPids: pids })
      }
      result.status = 'aborted-port-in-use'
      result.abort = { reason: 'ports already in use', busyPorts: details }
      fs.writeFileSync(ABORT_PATH, JSON.stringify(result, null, 2), 'utf8')
      log('ABORT: ports already in use: ' + JSON.stringify(details) + ' - refusing to start and not killing any foreign process. See ' + ABORT_PATH)
      return await finish(2)
    }
    const paper = await findPaperProcesses()
    if (paper.ok && paper.data) {
      const paperProcesses = Array.isArray(paper.data) ? paper.data : [paper.data]
      if (paperProcesses.length) {
        result.status = 'aborted-foreign-paper'
        result.abort = { reason: 'a paper-1.21.4 server is already running', processes: paperProcesses }
        fs.writeFileSync(ABORT_PATH, JSON.stringify(result, null, 2), 'utf8')
        log('ABORT: a paper-1.21.4.jar process is already running: ' + JSON.stringify(paperProcesses) + ' - not starting a second server and not killing it. See ' + ABORT_PATH)
        return await finish(2)
      }
    }
    await acquireLock()

    // ---- prepare ---------------------------------------------------------
    ACTIVE.phase = 'prepare'
    result.server = await prepareServerDir()
    result.server.mainClass = 'paper-1.21.4.jar'
    result.server.javaArgs = ['-Xms' + ARGS.xms, '-Xmx' + ARGS.xmx, '-jar', 'paper-1.21.4.jar', '--nogui']
    if (result.server.baseHider.sourceSha256 !== result.server.baseHider.targetSha256) {
      throw new Error('plugin jar copy verification failed (sha256 mismatch)')
    }
    log('plugin prepared: dist sha256 ' + result.server.baseHider.sourceSha256 + ' (size ' + result.server.baseHider.sizeBytes + ')')
    log('PacketEvents: ' + JSON.stringify({ source: result.server.packetEvents.source, sizeBytes: result.server.packetEvents.sizeBytes }))

    if (ARGS.items > 0) {
      result.datapack = await prepareItems(result.server)
    } else {
      result.datapack = null
      log('items=0: skipping datapack generation')
    }

    // ---- start server ----------------------------------------------------
    ACTIVE.phase = 'starting-server'
    const serverCtx = startServer()
    const startup = await waitForServerDone(serverCtx)
    result.server.startedAt = new Date(serverCtx.startedAt).toISOString()
    result.server.startupMs = startup.startupMs
    result.server.logPath = serverCtx.logPath
    result.server.pid = serverCtx.child.pid
    result.server.pluginStartupLines = readFileTail(SERVER_LOG_PATH, 400000)
      .split(/\r?\n/)
      .filter((line) => /\[BaseHider\]|packetevents v[0-9]|PluginRemapper|Done \(/i.test(line))
      .slice(-12)
      .map((line) => line.trim())
    const pv = result.server.pluginStartupLines.join('\n').match(/packetevents v([0-9][0-9.]*)/i)
    result.server.packetEventsVersion = pv ? pv[1] : null

    ACTIVE.phase = 'rcon-connect'
    await connectRcon(90000)
    log('RCON connected on ' + ARGS.serverHost + ':' + ARGS.rconPort)
    result.server.rconConnected = true

    if (ARGS.items > 0) {
      ACTIVE.phase = 'summon-items'
      result.itemsVerification = await summonAndVerifyItems(result.datapack)
      log('items verification: ' + JSON.stringify({
        datapackEnabled: result.itemsVerification.datapackEnabled,
        itemOk: result.itemsVerification.itemOk,
        entityCountFromExecuteIf: result.itemsVerification.entityCountFromExecuteIf
      }))
      if (!result.itemsVerification.itemOk) {
        result.limitations.push('item existence check (execute if entity ... say ITEM_OK) did not confirm item entities; diag trackedItems is the fallback count')
      }
    }

    // ---- bots ------------------------------------------------------------
    ACTIVE.phase = 'bots'
    ACTIVE.joinStartedAt = Date.now()
    spawnBotWorkers(ARGS.bots)
    const join = await waitForBotSpawn()
    result.join = join
    log('join result: ' + JSON.stringify({ reached: join.reached, spawned: join.spawned, target: join.target, waitedMs: join.waitedMs, timedOut: join.timedOut }))
    result.bots = {
      requested: ARGS.bots,
      spawned: ACTIVE.botSpawned.length,
      spawnedPct: round(100 * ACTIVE.botSpawned.length / ARGS.bots, 1),
      joinLatencyMs: stats(ACTIVE.botSpawned.map((event) => event.connectToSpawnMs)),
      failures: ACTIVE.botFailures.slice(0, 300),
      failureCount: ACTIVE.botFailures.length,
      workers: ACTIVE.workers.map((worker) => ({
        worker: worker.index,
        bots: worker.count,
        spawned: worker.events.spawned,
        failed: worker.events.failed,
        exitCode: worker.exitCode,
        exitAt: worker.exitAt,
        fatal: worker.fatal,
        unparsedLines: (worker.unparsed || []).length,
        stderrTail: worker.stderrLines.slice(-40)
      }))
    }

    if (!join.reached) {
      result.limitations.push(`only ${ACTIVE.botSpawned.length}/${ARGS.bots} bots reached spawn state within ${ARGS.joinTimeoutMs} ms ` +
        `(95% target = ${join.target}); tier did NOT pass`)
      ACTIVE.phase = 'join-failed'
      // still collect one status sample and one diag sample as evidence of the failure
      const failureSample = await takeSample({ runStartedAt, joinStartedAt: ACTIVE.joinStartedAt, cpuSampler: ACTIVE.cpuSampler, heapMaxConfiguredMB: parseHeapSizeMB(ARGS.xmx) }, 0, 'join-failed')
      result.samples.push(failureSample)
      result.status = 'failed-join'
      result.error = 'bots did not reach the 95% spawn target'
      await cleanup('join-failed')
      result.cleanup = ACTIVE.cleanupResult
      result.finishedAt = nowIso()
      result.filteringNote = 'server was started but the bot population could not join, so no load numbers are claimed for this tier'
      fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8')
      log('RESULT (failure evidence) ' + RESULT_PATH)
      return await finish(1)
    }

    // ---- warmup + samples ------------------------------------------------
    await sleep(ARGS.warmupMs)
    ACTIVE.phase = 'sampling'
    const sampleCtx = { runStartedAt, joinStartedAt: ACTIVE.joinStartedAt, cpuSampler: ACTIVE.cpuSampler, heapMaxConfiguredMB: parseHeapSizeMB(ARGS.xmx) }
    for (let i = 0; i < ARGS.sampleCount; i++) {
      if (i > 0) {
        const targetAt = ACTIVE.joinStartedAt + ARGS.warmupMs + i * ARGS.sampleIntervalMs
        const wait = targetAt - Date.now()
        if (wait > 0) await sleep(wait)
      }
      const sample = await takeSample(sampleCtx, i, 'baseline')
      result.samples.push(sample)
      log('sample ' + (i + 1) + '/' + ARGS.sampleCount + ' ' + JSON.stringify(sampleHeadline(sample)))
    }

    // ---- optional soak ---------------------------------------------------
    if (ARGS.soakSeconds > 0) {
      ACTIVE.phase = 'soak'
      result.soak = { seconds: ARGS.soakSeconds, churnIntervalMs: ARGS.churnIntervalMs, churnEvents: [], samples: [] }
      const soakStart = Date.now()
      const soakEnd = soakStart + ARGS.soakSeconds * 1000
      let nextChurn = soakStart
      let nextSample = soakStart + ARGS.sampleIntervalMs
      let churnIndex = 0
      let sampleCounter = ARGS.sampleCount
      log('soak start: ' + ARGS.soakSeconds + 's, churn every ' + ARGS.churnIntervalMs + 'ms')
      while (Date.now() < soakEnd) {
        const now = Date.now()
        if (now >= nextChurn) {
          churnIndex++
          await churnItems(sampleCtx, churnIndex)
          nextChurn = now + ARGS.churnIntervalMs
        }
        if (Date.now() >= nextSample) {
          const sample = await takeSample(sampleCtx, sampleCounter++, 'soak')
          result.samples.push(sample)
          result.soak.samples.push(sample.index)
          nextSample = Date.now() + ARGS.sampleIntervalMs
          log('soak sample ' + sample.index + ' ' + JSON.stringify(sampleHeadline(sample)))
        }
        await sleep(Math.min(200, Math.max(0, soakEnd - Date.now())))
      }
      const finalSample = await takeSample(sampleCtx, sampleCounter++, 'soak-final')
      result.samples.push(finalSample)
      result.soak.churnEvents = ACTIVE.soakChurnEvents
      result.soak.finalSampleIndex = finalSample.index
      log('soak done: ' + ACTIVE.soakChurnEvents.length + ' churn cycles')
    }

    // ---- optional one-shot /paper heap probe (opt-in, not part of sampling) ----
    if (ARGS.paperHeapProbe) {
      ACTIVE.phase = 'paper-heap-probe'
      log('running opt-in one-shot /paper heap probe (this may write a .hprof dump)')
      const listHprof = () => {
        try {
          return fs.readdirSync(ARGS.serverDir).filter((name) => name.endsWith('.hprof'))
        } catch (_) {
          return []
        }
      }
      const beforeHprof = listHprof()
      const probeResponse = await rconCmd('paper heap')
      let dumpFiles = []
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(1000)
        dumpFiles = listHprof().filter((name) => !beforeHprof.includes(name)).map((name) => {
          const filePath = path.join(ARGS.serverDir, name)
          let sizeBytes = null
          try { sizeBytes = fs.statSync(filePath).size } catch (_) {}
          return { file: filePath, sizeBytes }
        })
        if (dumpFiles.length) break
      }
      result.paperHeapProbe = {
        command: probeResponse,
        outputLooksUnavailable: /console|unknown|incomplete/i.test(stripFormatting(probeResponse.raw)),
        dumpFiles,
        note: 'Paper 1.21.4 /paper heap is a heap-dump command: it does not print used/max MB and may be console-only. ' +
          'Per-sample heap numbers come from /spark health and jcmd GC.heap_info.'
      }
      log('paper heap probe: ' + JSON.stringify({ raw: stripFormatting(probeResponse.raw).slice(0, 200), dumpFiles }))
    }

    // ---- final bot status ------------------------------------------------
    ACTIVE.phase = 'final-bot-status'
    const finalStatus = await getBotStatusSnapshot(8000)
    result.bots.final = {
      ok: finalStatus.ok,
      aggregate: finalStatus.aggregate,
      workers: finalStatus.workers.map((workerStatus) => ({
        worker: workerStatus.worker,
        workerBots: workerStatus.workerBots,
        spawned: workerStatus.spawned,
        alive: workerStatus.alive,
        failed: workerStatus.failed,
        totalPackets: workerStatus.totalPackets,
        totalBytes: workerStatus.totalBytes
      }))
    }
    result.bots.perBot = finalStatus.workers.flatMap((workerStatus) => workerStatus.bots || [])

    // ---- cleanup ---------------------------------------------------------
    ACTIVE.phase = 'cleanup'
    await cleanup('normal')
    result.cleanup = ACTIVE.cleanupResult

    // ---- summary ---------------------------------------------------------
    result.status = 'ok'
    result.finishedAt = nowIso()
    result.durationMs = Date.now() - runStartedAt
    result.summary = summarizeRun(result)
    if (!result.cleanup.portsAllFree) {
      result.limitations.push('after shutdown at least one of the load-test ports was still busy; see cleanup.ports')
    }
    if (result.cleanup.serverPropertiesRestored === false) {
      result.limitations.push('could not restore original server.properties')
    }
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8')
    log('RESULT ' + RESULT_PATH)
    log('SUMMARY ' + JSON.stringify(result.summary))
    return await finish(0)
  } catch (error) {
    result.status = 'error'
    result.error = String(error && error.stack ? error.stack : error)
    result.errorMessage = String(error && error.message ? error.message : error)
    log('RUN ERROR: ' + result.errorMessage)
    try {
      await cleanup('error')
      result.cleanup = ACTIVE.cleanupResult
    } catch (cleanupError) {
      result.cleanupError = String(cleanupError && cleanupError.message ? cleanupError.message : cleanupError)
    }
    result.finishedAt = nowIso()
    try {
      result.summary = summarizeRun(result)
    } catch (_) {}
    try {
      fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8')
      log('partial RESULT ' + RESULT_PATH)
    } catch (_) {}
    return await finish(1)
  }
}

function summarizeRun (result) {
  const samples = result.samples || []
  const baseline = samples.filter((s) => s.phase === 'baseline')
  const soakSamples = samples.filter((s) => s.phase === 'soak' || s.phase === 'soak-final')
  const diagField = (field) => samples.map((s) => s.diag && s.diag[field])
  const msptField = (windowIndex, field) => samples.map((s) => {
    const windows = s.mspt && s.mspt.windows
    return windows && windows[windowIndex] ? windows[windowIndex][field] : null
  })
  const summary = {
    tier: { botsRequested: result.params.bots, itemsRequested: result.params.items, botsSpawned: result.join ? result.join.spawned : (result.bots ? result.bots.spawned : null) },
    join: result.join || null,
    joinLatencyMs: result.bots ? result.bots.joinLatencyMs : null,
    joinPct: result.bots ? result.bots.spawnedPct : null,
    failures: result.bots ? result.bots.failureCount : null,
    samples: samples.length,
    baselineSamples: baseline.length,
    soakSamples: soakSamples.length,
    mspt: {
      last5s_avg: stats(msptField(0, 'avg')),
      last5s_max: stats(msptField(0, 'max')),
      last10s_avg: stats(msptField(1, 'avg')),
      last1m_avg: stats(msptField(2, 'avg'))
    },
    tps: stats(samples.map((s) => s.tps && s.tps.values ? s.tps.values[0] : null)),
    basehider: {
      tickLastUs: stats(diagField('tickLastUs')),
      tickAvgUs: stats(diagField('tickAvgUs')),
      tickMaxUs: stats(diagField('tickMaxUs')),
      p50Us: stats(diagField('p50Us')),
      p95Us: stats(diagField('p95Us')),
      p99Us: stats(diagField('p99Us')),
      overruns: stats(diagField('overruns')),
      itemEvals: stats(diagField('itemEvals')),
      itemStormBatches: stats(samples.map((s) => s.diagnosticsSnapshot && s.diagnosticsSnapshot.itemStormBatches)),
      itemStormMaxDepth: stats(samples.map((s) => s.diagnosticsSnapshot && s.diagnosticsSnapshot.itemStormMaxDepth)),
      blockEvals: stats(diagField('blockEvals')),
      raycasts: stats(diagField('raycasts')),
      raycastsDeferred: stats(diagField('raycastsDeferred')),
      trackedItems: stats(diagField('trackedItems')),
      trackedItemsAtEnd: (() => {
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].diag && samples[i].diag.trackedItems != null) return samples[i].diag.trackedItems
        }
        return null
      })(),
      errors: (() => {
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].diag && samples[i].diag.errors != null) return samples[i].diag.errors
        }
        return null
      })(),
      snapshot: {
        onlinePlayers: stats(samples.map((s2) => s2.diagnosticsSnapshot && s2.diagnosticsSnapshot.onlinePlayers)),
        trackedItems: stats(samples.map((s2) => s2.diagnosticsSnapshot && s2.diagnosticsSnapshot.trackedItems)),
        revealedItemViewerPairs: stats(samples.map((s2) => s2.diagnosticsSnapshot && s2.diagnosticsSnapshot.revealedItemViewerPairs)),
        itemEvaluations: stats(samples.map((s2) => s2.diagnosticsSnapshot && s2.diagnosticsSnapshot.itemEvaluations)),
        itemStormBatchesLatest: (() => {
          for (let i = samples.length - 1; i >= 0; i--) {
            if (samples[i].diagnosticsSnapshot && samples[i].diagnosticsSnapshot.itemStormBatches != null) return samples[i].diagnosticsSnapshot.itemStormBatches
          }
          return null
        })(),
        itemStormMaxDepthLatest: (() => {
          for (let i = samples.length - 1; i >= 0; i--) {
            if (samples[i].diagnosticsSnapshot && samples[i].diagnosticsSnapshot.itemStormMaxDepth != null) return samples[i].diagnosticsSnapshot.itemStormMaxDepth
          }
          return null
        })(),
        chunkPassedLatest: (() => {
          for (let i = samples.length - 1; i >= 0; i--) {
            if (samples[i].diagnosticsSnapshot && samples[i].diagnosticsSnapshot.chunkPassed != null) return samples[i].diagnosticsSnapshot.chunkPassed
          }
          return null
        })(),
        unexpectedItemSpawnPacketsBlockedLatest: (() => {
          for (let i = samples.length - 1; i >= 0; i--) {
            if (samples[i].diagnosticsSnapshot && samples[i].diagnosticsSnapshot.unexpectedItemSpawnPacketsBlocked != null) return samples[i].diagnosticsSnapshot.unexpectedItemSpawnPacketsBlocked
          }
          return null
        })()
      },
      chunkSanitizedAtEnd: (() => {
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].diag && samples[i].diag.chunkSanitized != null) return samples[i].diag.chunkSanitized
        }
        return null
      })(),
      gatewayStateAtEnd: (() => {
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].diag && samples[i].diag.gatewayState) return samples[i].diag.gatewayState
        }
        return null
      })()
    },
    heap: {
      jvmUsedMB: stats(samples.map((s) => s.jvmHeap && s.jvmHeap.heapUsedMB)),
      jvmTotalMB: stats(samples.map((s) => s.jvmHeap && s.jvmHeap.heapTotalMB)),
      maxConfiguredMB: (() => {
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].heap && samples[i].heap.maxConfiguredMB != null) return samples[i].heap.maxConfiguredMB
        }
        return null
      })(),
      serverWorkingSetMB: stats(samples.map((s) => s.serverProcess && s.serverProcess.workingSetMB)),
      paperHeapUsedMB: stats(samples.map((s) => s.paperHeap && s.paperHeap.usedMB)),
      paperHeapNote: 'Paper 1.21.4 /paper heap writes a .hprof dump and does not print used/max MB; ' +
        'used/committed heap is measured by jcmd GC.heap_info, max from the -Xmx argument'
    },
    hostCpuPct: stats(samples.map((s) => s.hostCpuPct)),
    bots: result.bots ? {
      spawned: result.bots.spawned,
      requested: result.bots.requested,
      spawnedPct: result.bots.spawnedPct,
      finalAlive: result.bots.final ? result.bots.final.aggregate.alive : null,
      finalSpawned: result.bots.final ? result.bots.final.aggregate.spawned : null,
      finalFailed: result.bots.final ? result.bots.final.aggregate.failed : null,
      totalPackets: result.bots.final ? result.bots.final.aggregate.totalPackets : null,
      totalBytes: result.bots.final ? result.bots.final.aggregate.totalBytes : null
    } : null,
    soak: result.soak ? {
      seconds: result.soak.seconds,
      churnCycles: result.soak.churnEvents ? result.soak.churnEvents.length : 0,
      churnOk: result.soak.churnEvents ? result.soak.churnEvents.filter((e) => e.ok).length : 0,
      mspt5sAvg: stats(soakSamples.map((s) => {
        const w = s.mspt && s.mspt.windows
        return w && w[0] ? w[0].avg : null
      })),
      trackedItems: stats(soakSamples.map((s) => s.diag && s.diag.trackedItems)),
      tps: stats(soakSamples.map((s) => s.tps && s.tps.values ? s.tps.values[0] : null))
    } : null
  }
  return summary
}

// --------------------------------------------------------------------- entry
main().then((code) => {
  process.exit(typeof code === 'number' ? code : 0)
}).catch((error) => {
  log('FATAL: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})

