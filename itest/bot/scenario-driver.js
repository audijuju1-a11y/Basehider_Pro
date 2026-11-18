#!/usr/bin/env node
'use strict'
/**
 * BaseHider end-to-end scenario driver.
 *
 * Boots the dedicated Paper 1.21.4 test server (server/), connects two headless
 * capture bots (bot/capture-bot.js), creates fixtures over RCON, records all
 * packets, and evaluates six scenarios:
 *
 *   A. hidden dropped item  - item far away behind solid blocks must NOT be sent
 *   B. visible dropped item - item ~3 blocks in front must be sent within 3s
 *   C. chunk block hiding   - player-placed chest inside a stone room must not be
 *                             present in level_chunk_with_light chunk data after a
 *                             forced chunk resend (palette decoder verifies)
 *   D. far-band BE leak     - chests in chunks 160 and 336 blocks away must not
 *                             appear as block states OR block entities, while a
 *                             sign in the same chunks proves the chunk arrived
 *                             (the "DonutSMP 140-340 blocks" leak class)
 *   E. pie-ray registry     - across the whole session capture, the client-side
 *                             block-entity registry (what the F3 pie chart reads)
 *                             must never contain a hidden container entry; sign
 *                             block entities must be present as a positive control
 *   F. cache replay         - near the viewer the chest is revealed, but after
 *                             leaving, the last state sent for its position is the
 *                             filler again; a replaying Bobby/Distant Horizons
 *                             cache therefore stores the hidden state, not the chest
 *
 * `--baseline` flips the expectations for the legacy jar: A, C, D, E and F are
 * expected to leak or lack the hide/reveal sequence, which validates that the
 * harness can actually detect each gap.
 *
 * Writes out/report-<timestamp>.json and prints a PASS/FAIL summary.
 * Exit codes: 0 = all expectations met, 1 = expectation failure, 2 = harness error.
 */
const { spawn, execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const { Rcon } = require('./lib/rcon')
const cd = require('./lib/chunk-decoder')

// ------------------------------------------------------------------ paths / constants
const ROOT = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const OUT_DIR = path.join(ROOT, 'out')
const BOT_SCRIPT = path.join(__dirname, 'capture-bot.js')
const SERVER_PID_FILE = path.join(OUT_DIR, 'server.pid')
const DEFAULT_JAVA_HOME = 'C:\\Users\\audim_r0h5i\\.jdks\\jdk-21.0.13+9'
const JAVA_HOME = process.env.JAVA_HOME || DEFAULT_JAVA_HOME
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe')

const SERVER_PORT = 25599
const RCON_PORT = 25598
const RCON_PASSWORD = 'itest-rcon-pass'

const MIN_Y = cd.MIN_Y
const WORLD_HEIGHT = cd.WORLD_HEIGHT

// Entities / blocks of interest, resolved from minecraft-data so a data-version
// bump cannot silently change the ids used by assertions.
const mcdata = require('minecraft-data')('1.21.4')
const ITEM_ENTITY_TYPE = mcdata.entitiesByName.item.id
const PLAYER_ENTITY_TYPE = mcdata.entitiesByName.player.id
const CHEST_RANGE = cd.stateRange('chest')
const OBSERVER_RANGE = cd.stateRange('observer')
const STONE_RANGE = cd.stateRange('stone')
const BARREL_RANGE = cd.stateRange('barrel')

// World coordinates for fixtures (flat world ground surface is y=-61, feet y=-60).
const STAGE = { x: 8.5, y: -59, z: 8.5, yaw: 0 } // facing +z (south)
const STAGE2 = { x: 12.5, y: -59, z: 8.5, yaw: 0 }
const HIDDEN_ITEM = { x: 8.5, y: -59.0, z: 32.5 }
const HIDDEN_WALL = { x1: 0, y1: -60, z1: 16, x2: 16, y2: -54, z2: 17 }
const VISIBLE_ITEM = { x: 8.5, y: -56.5, z: 11.5 }
const VISIBLE_WALL = { x1: 0, y1: -60, z1: 18, x2: 16, y2: -54, z2: 19 } // background only
const ROOM = { x1: 97, y1: -60, z1: 97, x2: 103, z2: 103, floorY: -60, ceilingY: -56 }
const CHEST_POS = { x: 100, y: -59, z: 101 }
const CHEST_CLICK = { x: 100, y: -60, z: 101, face: 1 } // top face of the floor block
const OBSERVER_POS = { x: 101, y: -59, z: 99 }
const STONE_MARKER_POS = { x: 98, y: -59, z: 98 }
const CONTROL_CHEST_POS = { x: 98, y: -59, z: 100 }
const ROOM_BOT_POS = { x: 100.5, y: -59, z: 102.5, yaw: 180 }
const FAR_AWAY = { x: 1100.5, y: -59, z: 102.5, yaw: 180 }
const ROOM_CHUNK = { x: 6, z: 6 }

// Three-gap benchmark fixtures. The bot stands at STAGE (chunk 0,0); band chunks
// 10 and 21 are 160 and 336 blocks away, inside the harness server's
// view-distance=22 but far outside any plausible reveal distance. Each band
// chunk holds one protected chest plus one oak sign that MUST still be sent:
// the sign is the positive control proving the chunk packet really arrived.
const BAND_FIXTURES = [
  {
    label: 'band-160-blocks',
    chunkX: 10,
    chunkZ: 0,
    chest: { x: 168, y: -59, z: 8 },
    sign: { x: 170, y: -59, z: 10 }
  },
  {
    label: 'band-336-blocks',
    chunkX: 21,
    chunkZ: 0,
    chest: { x: 344, y: -59, z: 8 },
    sign: { x: 346, y: -59, z: 10 }
  }
]

// Block-entity registry names (NBT "id") of every hidden storage type in the
// harness server config. Used by the cumulative pie-ray registry check.
const HIDDEN_BLOCK_ENTITY_TYPES = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'shulker_box',
  'hopper', 'dropper', 'dispenser',
  'furnace', 'blast_furnace', 'smoker', 'brewing_stand',
  'mob_spawner', 'trial_spawner', 'vault'
])
function bareTypeName (nbtId) {
  if (!nbtId) return null
  const s = String(nbtId)
  const colon = s.indexOf(':')
  return (colon >= 0 ? s.slice(colon + 1) : s).toLowerCase()
}

const UUID_A_INTS = [169090600, 185273100, 201326600, 217480100]
const UUID_B_INTS = [202050200, 218103800, 234157400, 250211000]

// ------------------------------------------------------------------ args
function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    }
  }
  return out
}
const argv = parseArgs(process.argv.slice(2))
const BASELINE = !!argv.baseline
const JAR_PATH = argv.jar ? path.resolve(String(argv.jar)) : path.join(ROOT, '.cache', 'baseline-BaseHider.jar')
const BOOT_TIMEOUT_MS = parseInt(argv['boot-timeout-ms'] || '240000', 10)
const SCENARIO_FILTER = argv.scenarios ? String(argv.scenarios).split(',') : null
const KEEP_SERVER = !!argv['keep-server']
const SKIP_BOOT = !!argv['skip-boot']
const SCENARIO_ORDER = ['A', 'B', 'C', 'D', 'E', 'F']
const which = SCENARIO_FILTER || SCENARIO_ORDER

// ------------------------------------------------------------------ small utilities
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Waits until the bot's NDJSON capture stops growing for quietMs. Used after
// teleports so assertions run only after the whole (view-distance=24) chunk
// batch has arrived instead of racing the chunk stream.
async function waitCaptureQuiet (bot, quietMs = 1200, timeoutMs = 45000) {
  const start = Date.now()
  let lastSize = -1
  let lastChange = Date.now()
  while (Date.now() - start < timeoutMs) {
    let size = 0
    try { size = fs.statSync(bot.ndjsonPath).size } catch (_) { size = 0 }
    if (size !== lastSize) {
      lastSize = size
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return true
    }
    await sleep(250)
  }
  return false
}

// Waits until every requested chunk packet appears AFTER fromOffset. A size-based
// quiet check can fire in a gap between chunk batches when the server is throttling
// a view-distance=24 stream, which made the 336-block band flaky (chunk 21 only
// arrives in the tail of the batch).
async function waitForChunkPackets (bot, chunkKeys, fromOffset, quietMs = 1000, timeoutMs = 90000) {
  const pending = new Set(chunkKeys.map(k => `${k.x},${k.z}`))
  const start = Date.now()
  let offset = fromOffset
  let partial = ''
  while (Date.now() - start < timeoutMs) {
    let size = 0
    try { size = fs.statSync(bot.ndjsonPath).size } catch (_) { size = 0 }
    if (size > offset) {
      const fd = fs.openSync(bot.ndjsonPath, 'r')
      try {
        const length = size - offset
        const buf = Buffer.alloc(length)
        fs.readSync(fd, buf, 0, length, offset)
        offset = size
        const lines = (partial + buf.toString('utf8')).split('\n')
        partial = lines.pop()
        for (const line of lines) {
          if (!line) continue
          let entry
          try { entry = JSON.parse(line) } catch (_) { continue }
          if (entry.name === 'level_chunk_with_light' && entry.data) {
            pending.delete(`${entry.data.x},${entry.data.z}`)
          }
        }
      } finally {
        fs.closeSync(fd)
      }
    }
    if (pending.size === 0) {
      await sleep(quietMs)
      return true
    }
    await sleep(250)
  }
  return false
}
const nowIso = () => new Date().toISOString()
function stamp () {
  const d = new Date()
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}
function sha256 (file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}
function uuidFromInts (ints) {
  const hex = ints.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const UUID_A = uuidFromInts(UUID_A_INTS)
const UUID_B = uuidFromInts(UUID_B_INTS)
function normUuid (v) {
  if (!v) return null
  if (typeof v === 'string') return v.toLowerCase()
  if (Buffer.isBuffer(v)) return uuidFromInts([v.readInt32BE(0), v.readInt32BE(4), v.readInt32BE(8), v.readInt32BE(12)])
  if (Array.isArray(v)) return v.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
  return String(v).toLowerCase()
}
function stateLabel (stateId) {
  if (stateId === null || stateId === undefined) return 'out_of_world'
  return `${cd.blockName(stateId)} (state ${stateId})`
}
function sectionBlockIndex (x, y, z) {
  return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15)
}
function chunkSectionIndexForY (y) { return (y - MIN_Y) >> 4 }
function isPortOpen (port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch (_) {} ; resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}
function portOwnerInfo (port) {
  try {
    const ps = `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c) { $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($c[0].OwningProcess)"; [Console]::Out.WriteLine("PID=$($c[0].OwningProcess);CMD=$($p.CommandLine)") }`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 }).trim()
    return out || 'unknown'
  } catch (e) {
    return `unknown (${e.message})`
  }
}
function killPidTree (pid, reason) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 })
    return true
  } catch (e) {
    return false
  }
}

// ------------------------------------------------------------------ report bucket
const report = {
  schema: 'basehider-itest/report/v1',
  runId: null,
  startedAt: nowIso(),
  baselineMode: BASELINE,
  environment: {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    minecraftProtocol: require('minecraft-protocol/package.json').version,
    java: JAVA,
    serverPort: SERVER_PORT,
    rconPort: RCON_PORT
  },
  plugin: null,
  server: null,
  decoderSelfTest: null,
  scenarios: {},
  overall: { pass: false, reason: 'not-finished' },
  limitations: [],
  artifacts: {},
  errors: []
}
function addError (msg) {
  report.errors.push(msg)
  console.error(`[driver] ERROR: ${msg}`)
}

// ------------------------------------------------------------------ server management
class PaperServer {
  constructor (runDir) {
    this.runDir = runDir
    this.logPath = path.join(runDir, 'server-console.log')
    this.proc = null
    this.lines = []
    this.exited = false
    this.exitInfo = null
    this.rcon = null
    this.bootMs = null
    this.stopped = false
    this._logStream = null
  }

  async preflight () {
    if (!fs.existsSync(JAVA)) throw new Error(`Java 21 not found at ${JAVA}`)
    if (!fs.existsSync(path.join(SERVER_DIR, 'paper-1.21.4.jar'))) throw new Error('server/paper-1.21.4.jar missing - run setup-server.ps1')
    for (const port of [SERVER_PORT, RCON_PORT]) {
      if (await isPortOpen(port)) {
        throw new Error(`port ${port} is already in use (${portOwnerInfo(port)}); run run-itest.ps1 to clean up or stop the process`)
      }
    }
  }

  start () {
    fs.mkdirSync(this.runDir, { recursive: true })
    this._logStream = fs.createWriteStream(this.logPath, { flags: 'w' })
    const jvmArgs = [
      '-Xms512M', '-Xmx2048M', '-XX:+UseG1GC', '-Dfile.encoding=UTF-8',
      '-jar', path.join(SERVER_DIR, 'paper-1.21.4.jar'), '--nogui'
    ]
    this.proc = spawn(JAVA, jvmArgs, {
      cwd: SERVER_DIR,
      env: Object.assign({}, process.env, { JAVA_HOME, PATH: `${path.join(JAVA_HOME, 'bin')};${process.env.PATH || ''}` }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    try {
      fs.writeFileSync(SERVER_PID_FILE, JSON.stringify({ pid: this.proc.pid, startedAt: nowIso(), jar: path.join(SERVER_DIR, 'paper-1.21.4.jar'), cwd: SERVER_DIR }) + '\n')
    } catch (e) {
      addError(`could not write server pid file: ${e.message}`)
    }
    const onChunk = (buf) => {
      const text = buf.toString('utf8')
      this._logStream.write(text)
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.lines.push(line)
        if (this.lines.length > 4000) this.lines.shift()
      }
    }
    this.proc.stdout.on('data', onChunk)
    this.proc.stderr.on('data', onChunk)
    this.proc.on('exit', (code, signal) => {
      this.exited = true
      this.exitInfo = { code, signal }
      if (this._logStream) {
        try { this._logStream.write(`\n[driver] server process exited code=${code} signal=${signal}\n`) } catch (_) {}
      }
    })
  }

  async waitForDone (timeoutMs) {
    const start = Date.now()
    let lastProgress = start
    while (Date.now() - start < timeoutMs) {
      if (this.exited && !this.stopped) {
        const tail = this.lines.slice(-25).join('\n')
        throw new Error(`Paper server exited during boot (code=${this.exitInfo && this.exitInfo.code}). Last log lines:\n${tail}`)
      }
      if (this.lines.some(l => /Done \([\d.]+s\)!/.test(l))) {
        this.bootMs = Date.now() - start
        return this.bootMs
      }
      if (Date.now() - lastProgress > 30000) lastProgress = Date.now()
      await sleep(100)
    }
    throw new Error(`Paper server did not reach "Done (" within ${Math.round(timeoutMs / 1000)}s; see ${this.logPath}`)
  }

  async connectRcon (timeoutMs = 20000) {
    const start = Date.now()
    let lastErr = null
    while (Date.now() - start < timeoutMs) {
      if (this.exited && !this.stopped) throw new Error('server exited before RCON could connect')
      const rcon = new Rcon({ host: '127.0.0.1', port: RCON_PORT, password: RCON_PASSWORD, timeoutMs: 8000 })
      try {
        await rcon.connect()
        this.rcon = rcon
        return rcon
      } catch (e) {
        lastErr = e
        try { rcon.close() } catch (_) {}
        await sleep(500)
      }
    }
    throw new Error(`RCON connect failed after ${timeoutMs}ms: ${lastErr && lastErr.message}`)
  }

  async rconCmd (command) {
    if (this.exited) throw new Error('Paper server process has exited; RCON command aborted')
    if (!this.rcon) throw new Error('RCON not connected')
    const res = await this.rcon.cmd(command)
    this._lastRcon = { command, response: res, at: nowIso() }
    return res
  }

  async stop (reason) {
    this.stopped = reason || 'driver-stop'
    if (this.rcon) {
      try { await Promise.race([this.rcon.cmd('stop'), sleep(5000)]) } catch (_) {}
      try { this.rcon.close() } catch (_) {}
      this.rcon = null
    }
    const start = Date.now()
    while (!this.exited && Date.now() - start < 45000) await sleep(200)
    let killedTree = false
    if (!this.exited && this.proc && this.proc.pid) {
      killedTree = killPidTree(this.proc.pid, 'stop-timeout')
      const kstart = Date.now()
      while (!this.exited && Date.now() - kstart < 15000) await sleep(200)
    }
    if (this._logStream) {
      try { this._logStream.write(`\n[driver] stop requested (${reason}); cleanExit=${this.exited && !killedTree}\n`); this._logStream.end() } catch (_) {}
    }
    // Wait for the ports to be released.
    const portStart = Date.now()
    while (Date.now() - portStart < 15000) {
      const busy = (await isPortOpen(SERVER_PORT)) || (await isPortOpen(RCON_PORT))
      if (!busy) break
      await sleep(250)
    }
    try { fs.unlinkSync(SERVER_PID_FILE) } catch (_) {}
    return {
      cleanExit: !!(this.exited && !killedTree),
      killedTree,
      exitCode: this.exitInfo && this.exitInfo.code,
      portsFreeAfterStop: !(await isPortOpen(SERVER_PORT)) && !(await isPortOpen(RCON_PORT))
    }
  }
}

// ------------------------------------------------------------------ bot management
class BotHandle {
  constructor (name, runDir) {
    this.name = name // username
    this.runDir = runDir
    this.ndjsonPath = path.join(runDir, `${name}.ndjson`)
    this.chunkDir = path.join(runDir, `${name}-chunks`)
    this.stderrPath = path.join(runDir, `${name}.stderr.log`)
    this.proc = null
    this.ready = null
    this.stdoutBuf = ''
    this.stdoutLines = []
    this.seenMarkers = new Set()
    this.markerWaiters = []
    this.exit = null
    this.stderrTail = []
    this._stderrStream = null
  }

  start () {
    fs.mkdirSync(this.chunkDir, { recursive: true })
    this._stderrStream = fs.createWriteStream(this.stderrPath, { flags: 'w' })
    this.proc = spawn(process.execPath, [
      BOT_SCRIPT,
      '--username', this.name,
      '--host', '127.0.0.1',
      '--port', String(SERVER_PORT),
      '--out', this.ndjsonPath,
      '--chunk-dir', this.chunkDir,
      '--max-ms', '1800000'
    ], { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    this.proc.stdout.on('data', (data) => {
      const text = data.toString()
      this.stdoutBuf += text
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stdoutLines.push(line)
        if (line.startsWith('BOT_READY ')) {
          try { this.ready = JSON.parse(line.slice('BOT_READY '.length)) } catch (_) {}
        } else if (line.startsWith('BOT_MARKED ')) {
          try {
            const m = JSON.parse(line.slice('BOT_MARKED '.length))
            this.seenMarkers.add(m.label)
            const stillWaiting = []
            for (const w of this.markerWaiters) {
              if (w.label === m.label) w.resolve()
              else stillWaiting.push(w)
            }
            this.markerWaiters = stillWaiting
          } catch (_) {}
        } else if (line.startsWith('BOT_PLACED ')) {
          try { this.lastPlaced = JSON.parse(line.slice('BOT_PLACED '.length)) } catch (_) {}
        } else if (line.startsWith('BOT_PLACE_ERROR ') || line.startsWith('BOT_ERROR ')) {
          this.stderrTail.push(line)
        }
      }
    })
    this.proc.stderr.on('data', (data) => {
      const text = data.toString()
      this.stderrTail.push(text)
      if (this.stderrTail.length > 80) this.stderrTail.shift()
      if (this._stderrStream) this._stderrStream.write(text)
    })
    this.proc.on('exit', (code, signal) => {
      this.exit = { code, signal }
      for (const w of this.markerWaiters) w.reject(new Error(`bot ${this.name} exited: ${code}`))
      this.markerWaiters = []
      if (this._stderrStream) {
        try { this._stderrStream.write(`\n[driver] bot process exited code=${code} signal=${signal}\n`); this._stderrStream.end() } catch (_) {}
      }
    })
  }

  send (obj) {
    if (!this.proc || this.exit) throw new Error(`bot ${this.name} is not running`)
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  async waitReady (timeoutMs = 45000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this.exit) throw new Error(`bot ${this.name} exited before ready (${JSON.stringify(this.exit)}): ${this.stderrTail.join('').slice(-600)}`)
      if (this.ready) return this.ready
      await sleep(100)
    }
    throw new Error(`bot ${this.name} did not become ready within ${timeoutMs}ms; stderr: ${this.stderrTail.join('').slice(-600)}`)
  }

  async waitMarker (label, timeoutMs = 15000) {
    if (this.seenMarkers.has(label)) return
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.markerWaiters = this.markerWaiters.filter(w => w !== waiter)
        reject(new Error(`bot ${this.name} marker "${label}" not reported within ${timeoutMs}ms; stderr: ${this.stderrTail.join('').slice(-400)}`))
      }, timeoutMs)
      const waiter = {
        label,
        resolve: () => { if (done) return; done = true; clearTimeout(timer); resolve() },
        reject: (err) => { if (done) return; done = true; clearTimeout(timer); reject(err) }
      }
      this.markerWaiters.push(waiter)
    })
  }

  async mark (label, timeoutMs = 15000) {
    this.send({ cmd: 'mark', label })
    await this.waitMarker(label, timeoutMs)
    return label
  }

  async quit () {
    if (!this.proc || this.exit) return this.exit
    try { this.send({ cmd: 'quit' }) } catch (_) {}
    const start = Date.now()
    while (!this.exit && Date.now() - start < 8000) await sleep(100)
    if (!this.exit && this.proc.pid) {
      killPidTree(this.proc.pid, 'bot-quit-timeout')
      await sleep(500)
    }
    return this.exit
  }
}

// ------------------------------------------------------------------ capture reading / analysis
function readCapture (bot) {
  if (!fs.existsSync(bot.ndjsonPath)) return { lines: [], markers: {} }
  const raw = fs.readFileSync(bot.ndjsonPath, 'utf8')
  const lines = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { lines.push(JSON.parse(line)) } catch (_) {}
  }
  const markers = {}
  for (const l of lines) {
    if (l.state === 'marker' && l.data && l.data.label) markers[l.data.label] = l
  }
  return { lines, markers, chunkDir: bot.chunkDir, ndjsonPath: bot.ndjsonPath }
}
function windowBetween (capture, startLabel, endLabel) {
  const start = capture.markers[startLabel]
  const end = capture.markers[endLabel]
  if (!start || !end) return { start, end, entries: [] }
  return {
    start,
    end,
    entries: capture.lines.filter(l => l.seq > start.seq && l.seq < end.seq && l.state !== 'marker')
  }
}
function followupsForEntity (entries, entityId, afterSeq) {
  const names = new Set(['set_entity_metadata', 'entity_metadata', 'rel_entity_move', 'entity_teleport', 'entity_move_look', 'entity_velocity', 'entity_head_rotation'])
  return entries.filter(l => l.seq > (afterSeq || 0) && names.has(l.name) && l.data && l.data.entityId === entityId)
}
function captureStats (capture) {
  const counts = {}
  for (const l of capture.lines) {
    if (['marker', 'meta', 'error'].includes(l.state)) continue
    counts[l.name] = (counts[l.name] || 0) + 1
  }
  return counts
}
function markerEvidence (m) {
  if (!m) return null
  return { label: m.data && m.data.label, seq: m.seq, timestampMs: m.timestampMs, tRelMs: m.tRelMs }
}

// ------------------------------------------------------------------ fixture / scenario helpers
class Harness {
  constructor (server, bots) {
    this.server = server
    this.bots = bots // {testBot, testBot2}
    this.rconTrace = []
    this.scenarioResults = {}
  }

  async rcon (command) {
    const response = await this.server.rconCmd(command)
    this.rconTrace.push({ at: nowIso(), command, response })
    if (this.rconTrace.length > 500) this.rconTrace.shift()
    return response
  }

  async tp (botName, pos) {
    return this.rcon(`tp ${botName} ${pos.x} ${pos.y} ${pos.z} ${pos.yaw ?? 0} ${pos.pitch ?? 0}`)
  }

  async forEachBot (fn) {
    for (const [key, bot] of Object.entries(this.bots)) await fn(bot, key)
  }

  async clearEntities () {
    try { await this.rcon('kill @e[type=!minecraft:player]') } catch (e) { addError(`clearEntities failed: ${e.message}`) }
  }

  async clearTextArea () {
    // Remove any stray items/entities, teleport bots to the staging area.
    await this.clearEntities()
    await this.tp('TestBot', STAGE)
    await this.tp('TestBot2', STAGE2)
    await sleep(900)
  }
}

// Scenario A: dropped item far away behind solid blocks must be invisible.
async function scenarioA (h) {
  const result = {
    id: 'A',
    name: 'hidden dropped item far away behind solid blocks',
    expectation: BASELINE ? 'LEAK' : 'HIDDEN',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  try {
    await h.clearTextArea()
    // Rebuild the blocking wall (idempotent) and make sure no leftover items exist.
    await h.rcon(`fill ${HIDDEN_WALL.x1} ${HIDDEN_WALL.y1} ${HIDDEN_WALL.z1} ${HIDDEN_WALL.x2} ${HIDDEN_WALL.y2} ${HIDDEN_WALL.z2} minecraft:stone`)
    await sleep(400)
    await h.tp('TestBot', STAGE)
    await h.tp('TestBot2', STAGE2)
    await sleep(900)

    for (const bot of Object.values(h.bots)) await bot.mark('A-start')
    const summon = `summon minecraft:item ${HIDDEN_ITEM.x} ${HIDDEN_ITEM.y} ${HIDDEN_ITEM.z} {UUID:[I;${UUID_A_INTS.join(',')}],NoGravity:1b,PickupDelay:32767s,Item:{id:"minecraft:diamond",count:1}}`
    const summonResponse = await h.rcon(summon)
    result.evidence.summonCommand = summon
    result.evidence.summonResponse = summonResponse
    await sleep(3000)
    for (const bot of Object.values(h.bots)) await bot.mark('A-end')
    await sleep(150)

    const perBot = {}
    let anyLeak = false
    let anySpawn = false
    for (const [key, bot] of Object.entries(h.bots)) {
      const capture = readCapture(bot)
      const win = windowBetween(capture, 'A-start', 'A-end')
      const before = capture.lines.filter(l => l.seq <= (win.start ? win.start.seq : 0))
      const knownEntityIds = new Set(before.filter(l => l.name === 'spawn_entity' && l.data).map(l => l.data.entityId))
      const itemSpawns = win.entries.filter(l => l.name === 'spawn_entity' && l.data && l.data.type === ITEM_ENTITY_TYPE)
      const uuidMatches = itemSpawns.filter(l => normUuid(l.data.objectUUID) === UUID_A)
      const leakedIds = itemSpawns.map(l => l.data.entityId)
      const followups = win.entries.filter(l => ['set_entity_metadata', 'entity_metadata', 'rel_entity_move', 'entity_teleport', 'entity_move_look', 'entity_velocity', 'entity_head_rotation'].includes(l.name) && leakedIds.includes(l.data && l.data.entityId))
      const unknownEntityPackets = win.entries.filter(l => ['rel_entity_move', 'entity_teleport', 'entity_move_look', 'entity_velocity', 'set_entity_metadata', 'entity_metadata'].includes(l.name) && l.data && !knownEntityIds.has(l.data.entityId) && l.data.entityId !== (bot.ready && bot.ready.entityId))
      const leak = itemSpawns.length > 0
      anyLeak = anyLeak || leak
      anySpawn = anySpawn || itemSpawns.length > 0
      perBot[key] = {
        username: bot.name,
        windowPackets: win.entries.length,
        itemSpawnPackets: itemSpawns.length,
        targetUuidSpawns: uuidMatches.length,
        leakedEntityIds: leakedIds,
        followupPackets: followups.length,
        followupByType: followups.reduce((acc, l) => { acc[l.name] = (acc[l.name] || 0) + 1; return acc }, {}),
        unknownEntityPackets: unknownEntityPackets.length,
        leaked: leak,
        capturePath: bot.ndjsonPath
      }
    }
    result.evidence.perBot = perBot
    result.evidence.anyLeak = anyLeak
    result.evidence.totalLeakedSpawnPackets = Object.values(perBot).reduce((n, b) => n + b.itemSpawnPackets, 0)
    result.evidence.totalFollowupPackets = Object.values(perBot).reduce((n, b) => n + b.followupPackets, 0)
    result.evidence.targetUuid = UUID_A
    result.evidence.itemPosition = HIDDEN_ITEM
    result.evidence.observerDistance = Math.hypot(HIDDEN_ITEM.x - STAGE.x, HIDDEN_ITEM.z - STAGE.z)
    {
      const capture = readCapture(h.bots.testBot)
      const win = windowBetween(capture, 'A-start', 'A-end')
      result.markers = { start: markerEvidence(win.start), end: markerEvidence(win.end) }
      result.evidence.packetCountsTestBot = captureStats(capture)
    }

    const observed = anyLeak ? 'LEAK' : 'HIDDEN'
    result.outcome = observed
    // Validation semantics: in baseline mode a LEAK proves the harness can detect
    // leaks; against the real plugin a LEAK is a failure.
    result.expectationMet = observed === result.expectation
    result.pass = result.expectationMet
    if (!result.pass) {
      result.failureReason = BASELINE
        ? 'baseline did not leak the hidden item; the harness fixture/probe is not reliable'
        : `hidden item was sent to the client (${result.evidence.totalLeakedSpawnPackets} item spawn packets)`
    }
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario A: ${e.message}`)
  }
  result.durationMs = Date.now() - t0
  return result
}

// Scenario B: dropped item ~3 blocks in front must be visible within 3s.
async function scenarioB (h) {
  const result = {
    id: 'B',
    name: 'visible dropped item ~3 blocks in front',
    expectation: 'VISIBLE',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  try {
    await h.clearEntities()
    await h.rcon(`fill ${VISIBLE_WALL.x1} ${VISIBLE_WALL.y1} ${VISIBLE_WALL.z1} ${VISIBLE_WALL.x2} ${VISIBLE_WALL.y2} ${VISIBLE_WALL.z2} minecraft:stone`)
    await h.tp('TestBot', STAGE)
    await h.tp('TestBot2', STAGE2)
    await sleep(900)

    for (const bot of Object.values(h.bots)) await bot.mark('B-start')
    const summon = `summon minecraft:item ${VISIBLE_ITEM.x} ${VISIBLE_ITEM.y} ${VISIBLE_ITEM.z} {UUID:[I;${UUID_B_INTS.join(',')}],PickupDelay:32767s,Item:{id:"minecraft:diamond",count:1}}`
    const summonResponse = await h.rcon(summon)
    result.evidence.summonCommand = summon
    result.evidence.summonResponse = summonResponse
    await sleep(3000)
    for (const bot of Object.values(h.bots)) await bot.mark('B-end')
    await sleep(150)

    const perBot = {}
    let visible = false
    for (const [key, bot] of Object.entries(h.bots)) {
      const capture = readCapture(bot)
      const win = windowBetween(capture, 'B-start', 'B-end')
      const isTarget = (l) => l.name === 'spawn_entity' && l.data && (normUuid(l.data.objectUUID) === UUID_B ||
        (l.data.type === ITEM_ENTITY_TYPE && Math.hypot(l.data.x - VISIBLE_ITEM.x, l.data.z - VISIBLE_ITEM.z) < 6))
      const spawns = win.entries.filter(isTarget)
      const first = spawns[0]
      const latencyMs = first && win.start ? first.timestampMs - win.start.timestampMs : null
      const entityId = first ? first.data.entityId : null
      const followups = entityId == null ? [] : followupsForEntity(win.entries, entityId)
      const byType = followups.reduce((acc, l) => { acc[l.name] = (acc[l.name] || 0) + 1; return acc }, {})
      const metadata = followups.filter(l => l.name === 'set_entity_metadata' || l.name === 'entity_metadata').length
      const position = followups.filter(l => ['rel_entity_move', 'entity_teleport', 'entity_move_look', 'entity_velocity'].includes(l.name)).length
      const botVisible = !!first && (metadata > 0 || position > 0) && latencyMs <= 3000
      visible = visible || botVisible
      perBot[key] = {
        username: bot.name,
        windowPackets: win.entries.length,
        spawnPackets: spawns.length,
        targetUuidFound: spawns.some(l => normUuid(l.data.objectUUID) === UUID_B),
        firstSpawnLatencyMs: latencyMs,
        entityId,
        followupPackets: followups.length,
        followupByType: byType,
        metadataPackets: metadata,
        positionPackets: position,
        visible: botVisible,
        capturePath: bot.ndjsonPath
      }
    }
    result.evidence.perBot = perBot
    result.evidence.targetUuid = UUID_B
    result.evidence.itemPosition = VISIBLE_ITEM
    result.evidence.visible = visible
    {
      const capture = readCapture(h.bots.testBot)
      const win = windowBetween(capture, 'B-start', 'B-end')
      result.markers = { start: markerEvidence(win.start), end: markerEvidence(win.end) }
      result.evidence.packetCountsTestBot = captureStats(capture)
    }
    result.outcome = visible ? 'VISIBLE' : 'NOT_VISIBLE'
    result.pass = visible
    if (!visible) result.failureReason = 'visible item spawn/follow-up packets were not observed within 3s'
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario B: ${e.message}`)
  }
  result.durationMs = Date.now() - t0
  return result
}

// Scenario C: player-placed chest inside a stone room must be absent from chunk data.
async function scenarioC (h) {
  const result = {
    id: 'C',
    name: 'chunk-level block hiding of a player-placed chest after forced chunk resend',
    expectation: BASELINE ? 'LEAK' : 'HIDDEN',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  try {
    // Stage bots away from the room chunk so it is unloaded before the test.
    await h.clearEntities()
    await h.tp('TestBot', STAGE)
    await h.tp('TestBot2', STAGE2)
    await sleep(900)

    // Idempotent room build. Flat world: ground surface y=-61, so the room floor
    // block sits at y=-60 and a player inside stands at y=-59.
    const cmds = [
      `fill ${ROOM.x1} ${ROOM.floorY} ${ROOM.z1} ${ROOM.x2} ${ROOM.ceilingY} ${ROOM.z2} minecraft:air`,
      `fill ${ROOM.x1} ${ROOM.floorY} ${ROOM.z1} ${ROOM.x2} ${ROOM.floorY} ${ROOM.z2} minecraft:stone`,
      `fill ${ROOM.x1} ${ROOM.floorY + 1} ${ROOM.z1} ${ROOM.x2} ${ROOM.ceilingY} ${ROOM.z2} minecraft:stone`,
      `fill ${ROOM.x1 + 1} ${ROOM.floorY + 1} ${ROOM.z1 + 1} ${ROOM.x2 - 1} ${ROOM.ceilingY - 1} ${ROOM.z2 - 1} minecraft:air`
    ]
    for (const c of cmds) await h.rcon(c)
    await h.rcon(`setblock ${STONE_MARKER_POS.x} ${STONE_MARKER_POS.y} ${STONE_MARKER_POS.z} minecraft:stone`)
    await h.rcon(`setblock ${OBSERVER_POS.x} ${OBSERVER_POS.y} ${OBSERVER_POS.z} minecraft:observer[facing=up]`)
    // Informational control: a chest placed by RCON (no BlockPlaceEvent); used to
    // distinguish placement-index-based hiding from material-scan hiding.
    await h.rcon(`setblock ${CONTROL_CHEST_POS.x} ${CONTROL_CHEST_POS.y} ${CONTROL_CHEST_POS.z} minecraft:chest`)
    await sleep(400)

    // Teleport the viewer into the room and place the primary chest as a player
    // (fires BlockPlaceEvent, so placement-index based plugins see it).
    await h.tp('TestBot', ROOM_BOT_POS)
    await sleep(800)
    const testBot = h.bots.testBot
    await testBot.mark('C-place')
    testBot.send({ cmd: 'place', block: 'chest', x: CHEST_CLICK.x, y: CHEST_CLICK.y, z: CHEST_CLICK.z, face: CHEST_CLICK.face, cursorX: 0.5, cursorY: 1.0, cursorZ: 0.5 })
    try {
      await sleep(1200)
      await testBot.mark('C-placed')
    } catch (e) { addError(`scenario C: marker after place failed: ${e.message}`) }

    // Verify the fixture on the server side before asserting on packets.
    const chestData = await h.rcon(`data get block ${CHEST_POS.x} ${CHEST_POS.y} ${CHEST_POS.z}`)
    const observerData = await h.rcon(`data get block ${OBSERVER_POS.x} ${OBSERVER_POS.y} ${OBSERVER_POS.z}`)
    result.evidence.fixture = { chestServerData: chestData, observerServerData: observerData }
    if (!/chest/i.test(chestData || '')) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = `fixture failure: no chest at ${JSON.stringify(CHEST_POS)} after bot placement (server said: ${chestData})`
      result.pass = false
      addError(`scenario C: ${result.failureReason}`)
      result.durationMs = Date.now() - t0
      return result
    }
    // Give the plugin time to scan/index and (for hiding plugins) to rewrite.
    await sleep(1200)

    // Force a real chunk resend: teleport 1000 blocks away, then back.
    await testBot.mark('C-far')
    await h.tp('TestBot', FAR_AWAY)
    await sleep(1600)
    await testBot.mark('C-back')
    await h.tp('TestBot', ROOM_BOT_POS)
    await sleep(2600)
    await testBot.mark('C-end')
    await sleep(200)

    const capture = readCapture(testBot)
    const win = windowBetween(capture, 'C-back', 'C-end')
    const farWin = windowBetween(capture, 'C-far', 'C-back')
    result.markers = {
      place: markerEvidence(capture.markers['C-place']),
      placed: markerEvidence(capture.markers['C-placed']),
      far: markerEvidence(capture.markers['C-far']),
      back: markerEvidence(capture.markers['C-back']),
      end: markerEvidence(capture.markers['C-end'])
    }
    result.evidence.packetCountsTestBot = captureStats(capture)
    const unloads = farWin.entries.filter(l => l.name === 'forget_level_chunk' || l.rawName === 'unload_chunk')
      .filter(l => l.data && l.data.chunkX === ROOM_CHUNK.x && l.data.chunkZ === ROOM_CHUNK.z)
    const chunkEntries = win.entries.filter(l => l.name === 'level_chunk_with_light' && l.data && l.data.x === ROOM_CHUNK.x && l.data.z === ROOM_CHUNK.z)
    result.evidence.resend = {
      chunkUnloadPacketsForRoomChunk: unloads.length,
      chunkPacketsForRoomChunkAfterReturn: chunkEntries.length
    }
    if (!chunkEntries.length) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = `fixture failure: bot received no level_chunk_with_light for chunk (${ROOM_CHUNK.x},${ROOM_CHUNK.z}) after teleporting back`
      result.pass = false
      addError(`scenario C: ${result.failureReason}`)
      result.durationMs = Date.now() - t0
      return result
    }
    const lastChunk = chunkEntries[chunkEntries.length - 1]
    const binPath = path.join(testBot.chunkDir, lastChunk.data.chunkDataFile)
    if (!fs.existsSync(binPath)) throw new Error(`chunk payload file missing: ${binPath}`)
    const decoded = cd.decodeChunkData(fs.readFileSync(binPath))
    const blockAt = (p) => {
      const state = cd.getBlockState(decoded, p.x, p.y, p.z)
      return { state, name: state === null ? 'out_of_world' : cd.blockName(state), matches: (range) => state !== null && cd.stateMatches(state, range) }
    }
    const chest = blockAt(CHEST_POS)
    const observer = blockAt(OBSERVER_POS)
    const stoneMarker = blockAt(STONE_MARKER_POS)
    const floorStone = blockAt({ x: CHEST_CLICK.x, y: CHEST_CLICK.y, z: CHEST_CLICK.z })
    const controlChest = blockAt(CONTROL_CHEST_POS)
    const chestInChunk = cd.stateMatches(chest.state, CHEST_RANGE)
    const observerPresent = cd.stateMatches(observer.state, OBSERVER_RANGE)
    const stoneMarkerPresent = cd.stateMatches(stoneMarker.state, STONE_RANGE)
    const floorStonePresent = cd.stateMatches(floorStone.state, STONE_RANGE)

    // Positive controls: the decoder must find the marker blocks at their exact
    // coordinates in the same real chunk packet, otherwise the assertion is void.
    result.evidence.decoderPositiveControls = {
      stoneMarkerAt: STONE_MARKER_POS, stoneMarkerState: stoneMarker.state, stoneMarkerName: stoneMarker.name, stoneMarkerPresent,
      floorStoneAt: { x: CHEST_CLICK.x, y: CHEST_CLICK.y, z: CHEST_CLICK.z }, floorStoneState: floorStone.state, floorStoneName: floorStone.name, floorStonePresent,
      observerAt: OBSERVER_POS, observerState: observer.state, observerName: observer.name, observerPresent
    }
    if (!(stoneMarkerPresent && floorStonePresent && observerPresent)) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = 'decoder positive controls failed: marker stone/observer blocks were not decoded at their known coordinates (chunk decoder bug or wrong chunk)'
      result.pass = false
      addError(`scenario C: ${result.failureReason}`)
      result.durationMs = Date.now() - t0
      return result
    }

    // Count chest states in the section containing the fixture (leak magnitude).
    const secIdx = chunkSectionIndexForY(CHEST_POS.y)
    const section = decoded.sections[secIdx]
    let chestStatesInSection = 0
    for (let i = 0; i < 4096; i++) {
      if (cd.stateMatches(section.blocks.get(i), CHEST_RANGE)) chestStatesInSection++
    }

    // Post-chunk block updates: what a client would end up rendering if the chunk
    // packet leaked and the plugin patched it afterwards with block-change packets.
    const updates = capture.lines.filter(l => l.seq > lastChunk.seq && l.name === 'block_update' && l.data && l.data.location &&
      l.data.location.x === CHEST_POS.x && l.data.location.y === CHEST_POS.y && l.data.location.z === CHEST_POS.z)
    const lastUpdate = updates[updates.length - 1]
    result.evidence.chestInChunkData = chestInChunk
    result.evidence.chestChunkState = { state: chest.state, name: chest.name, inChestRange: chestInChunk }
    result.evidence.controlChestInChunkData = controlChest.inChestRange
    result.evidence.controlChestChunkState = { state: controlChest.state, name: controlChest.name }
    result.evidence.chestStatesInSection = chestStatesInSection
    result.evidence.postChunkBlockUpdatesAtChest = {
      count: updates.length,
      lastState: lastUpdate ? lastUpdate.data.type : null,
      lastName: lastUpdate ? cd.blockName(lastUpdate.data.type) : null
    }
    result.evidence.serverGroundTruthChest = chestData

    const observed = chestInChunk ? 'LEAK' : 'HIDDEN'
    result.outcome = observed
    result.expectationMet = observed === result.expectation
    result.pass = result.expectationMet
    if (!result.pass) {
      result.failureReason = BASELINE
        ? 'baseline did not leak the chest into the chunk packet; the decoder/fixture cannot prove a leak'
        : `player-placed chest was present in level_chunk_with_light chunk data (${chest.name} state ${chest.state} at ${JSON.stringify(CHEST_POS)})`
    }
    if (controlChest.inChestRange && !chestInChunk) {
      result.evidence.note = 'primary chest hidden but RCON-placed control chest leaked - plugin hiding appears placement-tracked, not material-wide'
    }
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario C: ${e.message}`)
  }
  result.durationMs = Date.now() - t0
  return result
}

// Scenario D: protected chests inside far chunks (160 / 336 blocks) must never
// reach the client, while a sign in the same chunk proves the chunk was sent.
async function scenarioD (h) {
  const result = {
    id: 'D',
    name: 'block-entity leak at 160/336 blocks (far chunk resend)',
    expectation: BASELINE ? 'LEAK' : 'HIDDEN',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  const testBot = h.bots.testBot
  try {
    await h.clearEntities()
    // Park far away first so the fixture area is not resident client-side; the
    // chunks must arrive AFTER the chests exist for this to be a chunk-path test.
    await h.tp('TestBot', FAR_AWAY)
    await h.tp('TestBot2', STAGE2)
    await waitCaptureQuiet(testBot, 1200, 60000)
    await sleep(400)

    for (const band of BAND_FIXTURES) {
      await h.rcon(`forceload add ${band.chest.x} ${band.chest.z}`)
      await h.rcon(`setblock ${band.chest.x} ${band.chest.y} ${band.chest.z} minecraft:chest`)
      await h.rcon(`setblock ${band.sign.x} ${band.sign.y} ${band.sign.z} minecraft:oak_sign`)
    }
    await sleep(500)

    const fixture = []
    for (const band of BAND_FIXTURES) {
      const chestData = await h.rcon(`data get block ${band.chest.x} ${band.chest.y} ${band.chest.z}`)
      const signData = await h.rcon(`data get block ${band.sign.x} ${band.sign.y} ${band.sign.z}`)
      fixture.push({ label: band.label, chestServerData: chestData, signServerData: signData })
    }
    result.evidence.fixture = fixture
    if (fixture.some(f => !/chest/i.test(f.chestServerData || ''))) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = `fixture failure: server-side chest missing (${JSON.stringify(fixture)})`
      result.durationMs = Date.now() - t0
      addError(`scenario D: ${result.failureReason}`)
      return result
    }

    await testBot.mark('D-start')
    const captureOffset = (() => { try { return fs.statSync(testBot.ndjsonPath).size } catch (_) { return 0 } })()
    await h.tp('TestBot', STAGE)
    // Chunk 21 is at the edge of the server view distance; wait for the exact
    // packets instead of trusting a size-stability heuristic.
    await waitForChunkPackets(testBot, BAND_FIXTURES.map(b => ({ x: b.chunkX, z: b.chunkZ })), captureOffset, 1000, 90000)
    await waitCaptureQuiet(testBot, 1500, 90000)
    await testBot.mark('D-end')
    await sleep(200)

    const capture = readCapture(testBot)
    const win = windowBetween(capture, 'D-start', 'D-end')
    result.markers = { start: markerEvidence(win.start), end: markerEvidence(win.end) }
    result.evidence.packetCountsTestBot = captureStats(capture)

    const perBand = {}
    let anyLeak = false
    let allControlsPresent = true
    let allChunksReceived = true
    for (const band of BAND_FIXTURES) {
      const chunkEntries = win.entries.filter(l => l.name === 'level_chunk_with_light' && l.data &&
        l.data.x === band.chunkX && l.data.z === band.chunkZ)
      const lastChunk = chunkEntries[chunkEntries.length - 1]
      const distance = Math.hypot(band.chest.x + 0.5 - STAGE.x, band.chest.z + 0.5 - STAGE.z)
      const entry = {
        label: band.label,
        distanceBlocks: Math.round(distance * 10) / 10,
        chunk: { x: band.chunkX, z: band.chunkZ },
        chunkPacketsReceived: chunkEntries.length,
        chestAt: band.chest,
        signAt: band.sign
      }
      if (!lastChunk) {
        allChunksReceived = false
        entry.note = 'fixture failure: chunk packet for this band was never received'
        perBand[band.label] = entry
        continue
      }
      const binPath = path.join(testBot.chunkDir, lastChunk.data.chunkDataFile)
      let decoded = null
      if (fs.existsSync(binPath)) decoded = cd.decodeChunkData(fs.readFileSync(binPath))
      const chestState = decoded ? cd.getBlockState(decoded, band.chest.x, band.chest.y, band.chest.z) : null
      const signState = decoded ? cd.getBlockState(decoded, band.sign.x, band.sign.y, band.sign.z) : null
      const beEntries = lastChunk.data.blockEntities && Array.isArray(lastChunk.data.blockEntities.entries)
        ? lastChunk.data.blockEntities.entries
        : []
      const beAt = (p) => beEntries.filter(e => e.worldX === p.x && e.worldZ === p.z && e.y === p.y)
      const chestBes = beAt(band.chest)
      const signBes = beAt(band.sign)
      const chestStateLeak = chestState !== null && cd.stateMatches(chestState, CHEST_RANGE)
      const chestBeLeak = chestBes.length > 0
      const signStatePresent = signState !== null && signState !== 0
      const signBePresent = signBes.length > 0
      const leak = chestStateLeak || chestBeLeak
      anyLeak = anyLeak || leak
      if (!signBePresent && !signStatePresent) allControlsPresent = false
      entry.blockEntityCount = lastChunk.data.blockEntities ? lastChunk.data.blockEntities.count : null
      entry.chestState = { state: chestState, name: chestState === null ? 'out_of_world' : cd.blockName(chestState), leak: chestStateLeak }
      entry.chestBlockEntities = chestBes
      entry.signControl = { state: signState, signStatePresent, signBlockEntityPresent: signBePresent, blockEntities: signBes }
      entry.leak = leak
      perBand[band.label] = entry
    }
    result.evidence.perBand = perBand
    result.evidence.anyLeak = anyLeak
    if (!allChunksReceived) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = 'fixture failure: at least one band chunk packet was not received after the teleport'
      result.durationMs = Date.now() - t0
      addError(`scenario D: ${result.failureReason}`)
      return result
    }
    if (!allControlsPresent) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = 'positive control failed: the sign (block + block entity) inside a band chunk was not received, the assertion would be void'
      result.durationMs = Date.now() - t0
      addError(`scenario D: ${result.failureReason}`)
      return result
    }

    const observed = anyLeak ? 'LEAK' : 'HIDDEN'
    result.outcome = observed
    result.expectationMet = observed === result.expectation
    result.pass = result.expectationMet
    if (!result.pass) {
      result.failureReason = BASELINE
        ? 'baseline did not leak a far-band chest into chunk data; the detector cannot prove a leak'
        : 'a protected chest (block state or block entity) reached the client at 160/336 blocks'
    }
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario D: ${e.message}`)
  } finally {
    for (const band of BAND_FIXTURES) {
      try { await h.rcon(`forceload remove ${band.chest.x} ${band.chest.z}`) } catch (_) {}
    }
  }
  result.durationMs = Date.now() - t0
  return result
}

// Scenario E: pie-ray proxy. The F3 pie chart (and every client-side ESP that
// enumerates block entities) can only name a container if a block-entity entry
// for it ever reached the client. Scan the WHOLE session capture: zero hidden
// container block entities may exist, while sign block entities must exist as a
// positive control (scenario D places them).
async function scenarioE (h) {
  const result = {
    id: 'E',
    name: 'pie-ray: cumulative client block-entity registry stays free of hidden containers',
    expectation: BASELINE ? 'DIRTY_REGISTRY' : 'CLEAN_REGISTRY',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  const testBot = h.bots.testBot
  try {
    const capture = readCapture(testBot)
    const chunkPackets = capture.lines.filter(l => l.name === 'level_chunk_with_light' && l.data)
    let beBearingChunks = 0
    let signBlockEntities = 0
    const offenders = []
    const typeCounts = {}
    for (const chunk of chunkPackets) {
      const summary = chunk.data.blockEntities
      if (!summary || !Array.isArray(summary.entries)) continue
      beBearingChunks++
      for (const be of summary.entries) {
        const bare = bareTypeName(be.typeName)
        if (!bare) continue
        typeCounts[bare] = (typeCounts[bare] || 0) + 1
        if (bare === 'sign' || bare === 'hanging_sign') signBlockEntities++
        if (HIDDEN_BLOCK_ENTITY_TYPES.has(bare)) {
          if (offenders.length < 20) {
            offenders.push({
              chunk: { x: chunk.data.x, z: chunk.data.z },
              worldX: be.worldX,
              worldY: be.y,
              worldZ: be.worldZ,
              typeName: bare,
              seq: chunk.seq
            })
          }
        }
      }
    }
    result.evidence = {
      chunkPacketsScanned: chunkPackets.length,
      chunksWithBlockEntities: beBearingChunks,
      signBlockEntities,
      hiddenContainerBlockEntities: offenders.length,
      offenders,
      blockEntityTypeCounts: typeCounts
    }
    if (beBearingChunks === 0 || signBlockEntities === 0) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = 'positive control failed: no sign block entity was captured at all (scenario D control fixture missing?), so an empty registry proves nothing'
      result.pass = false
      addError(`scenario E: ${result.failureReason}`)
      result.durationMs = Date.now() - t0
      return result
    }
    const clean = offenders.length === 0
    result.outcome = clean ? 'CLEAN_REGISTRY' : 'DIRTY_REGISTRY'
    result.expectationMet = result.outcome === result.expectation
    result.pass = result.expectationMet
    if (!result.pass) {
      result.failureReason = BASELINE
        ? 'baseline did not expose any hidden container block entity; the registry probe found nothing to detect'
        : `hidden container block entities reached the client: ${offenders.length} entries, e.g. ${JSON.stringify(offenders[0])}`
    }
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario E: ${e.message}`)
  }
  result.durationMs = Date.now() - t0
  return result
}

// Scenario F: Bobby / Distant Horizons cache replay. Those mods persist whatever
// chunk/block state the client last held. The plugin must reveal a chest while
// the viewer stands next to it, then push the filler state again when the viewer
// leaves, so the last cached state is the filler - a replay cannot show a chest.
async function scenarioF (h) {
  const result = {
    id: 'F',
    name: 'cache replay (Bobby/Distant Horizons): reveal near, re-hide before the client caches',
    expectation: BASELINE ? 'CACHE_LEAK' : 'REVEAL_THEN_REHIDE',
    startedAt: nowIso(),
    durationMs: 0,
    outcome: 'INCONCLUSIVE',
    pass: false,
    evidence: {},
    markers: {}
  }
  const t0 = Date.now()
  const testBot = h.bots.testBot
  try {
    await h.clearEntities()
    await h.tp('TestBot', FAR_AWAY)
    await h.tp('TestBot2', STAGE2)
    await waitCaptureQuiet(testBot, 1200, 60000)

    // Build the room far from the bot, then place the protected chest via RCON:
    // no placement block-update can be confused with a reveal packet later.
    const cmds = [
      `fill ${ROOM.x1} ${ROOM.floorY} ${ROOM.z1} ${ROOM.x2} ${ROOM.ceilingY} ${ROOM.z2} minecraft:air`,
      `fill ${ROOM.x1} ${ROOM.floorY} ${ROOM.z1} ${ROOM.x2} ${ROOM.floorY} ${ROOM.z2} minecraft:stone`,
      `fill ${ROOM.x1} ${ROOM.floorY + 1} ${ROOM.z1} ${ROOM.x2} ${ROOM.ceilingY} ${ROOM.z2} minecraft:stone`,
      `fill ${ROOM.x1 + 1} ${ROOM.floorY + 1} ${ROOM.z1 + 1} ${ROOM.x2 - 1} ${ROOM.ceilingY - 1} ${ROOM.z2 - 1} minecraft:air`
    ]
    for (const c of cmds) await h.rcon(c)
    await h.rcon(`setblock ${CHEST_POS.x} ${CHEST_POS.y} ${CHEST_POS.z} minecraft:air`)
    await h.rcon(`setblock ${CHEST_POS.x} ${CHEST_POS.y} ${CHEST_POS.z} minecraft:chest`)
    await sleep(400)
    const chestData = await h.rcon(`data get block ${CHEST_POS.x} ${CHEST_POS.y} ${CHEST_POS.z}`)
    result.evidence.fixture = { chestServerData: chestData, chestAt: CHEST_POS }
    if (!/chest/i.test(chestData || '')) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = `fixture failure: no chest at ${JSON.stringify(CHEST_POS)} (server said: ${chestData})`
      result.durationMs = Date.now() - t0
      addError(`scenario F: ${result.failureReason}`)
      return result
    }

    // Approach: the room chunk arrives with the chest already hidden.
    await testBot.mark('F-start')
    await h.tp('TestBot', ROOM_BOT_POS)
    await waitCaptureQuiet(testBot, 1200, 45000)
    await sleep(2500) // reveal tick: near + in FOV + line of sight
    await testBot.mark('F-revealed')
    // Leave: beyond reveal.max-distance * keep-distance-factor -> re-hide update.
    await h.tp('TestBot', FAR_AWAY)
    await sleep(3000)
    await testBot.mark('F-end')
    await sleep(200)

    const capture = readCapture(testBot)
    const win = windowBetween(capture, 'F-start', 'F-end')
    result.markers = {
      start: markerEvidence(win.start),
      revealed: markerEvidence(capture.markers['F-revealed']),
      end: markerEvidence(win.end)
    }
    const roomChunks = win.entries.filter(l => l.name === 'level_chunk_with_light' && l.data &&
      l.data.x === ROOM_CHUNK.x && l.data.z === ROOM_CHUNK.z)
    if (!roomChunks.length) {
      result.outcome = 'INCONCLUSIVE'
      result.failureReason = `fixture failure: no chunk packet for the room chunk (${ROOM_CHUNK.x},${ROOM_CHUNK.z}) on approach`
      result.durationMs = Date.now() - t0
      addError(`scenario F: ${result.failureReason}`)
      return result
    }
    const firstChunk = roomChunks[0]
    const binPath = path.join(testBot.chunkDir, firstChunk.data.chunkDataFile)
    let arrivalState = null
    if (fs.existsSync(binPath)) {
      const decoded = cd.decodeChunkData(fs.readFileSync(binPath))
      arrivalState = cd.getBlockState(decoded, CHEST_POS.x, CHEST_POS.y, CHEST_POS.z)
    }
    const updates = win.entries.filter(l => l.name === 'block_update' && l.data && l.data.location &&
      l.data.location.x === CHEST_POS.x && l.data.location.y === CHEST_POS.y &&
      l.data.location.z === CHEST_POS.z && l.seq > firstChunk.seq)
    const chestUpdateIdx = []
    updates.forEach((u, i) => { if (cd.stateMatches(u.data.type, CHEST_RANGE)) chestUpdateIdx.push(i) })
    const revealSeen = chestUpdateIdx.length > 0
    const lastChestIdx = revealSeen ? chestUpdateIdx[chestUpdateIdx.length - 1] : -1
    const rehideUpdates = lastChestIdx >= 0
      ? updates.slice(lastChestIdx + 1).filter(u => !cd.stateMatches(u.data.type, CHEST_RANGE))
      : []
    const lastUpdate = updates[updates.length - 1]
    const finalStateValue = lastUpdate ? lastUpdate.data.type : arrivalState
    const finalStateName = finalStateValue === null || finalStateValue === undefined
      ? 'out_of_world'
      : cd.blockName(finalStateValue)
    const arrivalHidden = arrivalState !== null && arrivalState !== undefined && !cd.stateMatches(arrivalState, CHEST_RANGE)
    const cacheDirty = finalStateValue !== null && finalStateValue !== undefined && cd.stateMatches(finalStateValue, CHEST_RANGE)

    result.evidence = Object.assign(result.evidence, {
      roomChunkPackets: roomChunks.length,
      arrivalState: {
        state: arrivalState,
        name: arrivalState === null || arrivalState === undefined ? 'out_of_world' : cd.blockName(arrivalState),
        hidden: arrivalHidden
      },
      blockUpdatesAtChest: updates.map(u => ({ seq: u.seq, state: u.data.type, name: cd.blockName(u.data.type) })),
      revealSeen,
      revealUpdates: chestUpdateIdx.length,
      rehideUpdates: rehideUpdates.map(u => ({ seq: u.seq, state: u.data.type, name: cd.blockName(u.data.type) })),
      finalCachedState: { state: finalStateValue === undefined ? null : finalStateValue, name: finalStateName, dirty: cacheDirty },
      cacheDirty
    })

    let observed
    if (BASELINE) {
      observed = cacheDirty ? 'CACHE_LEAK' : 'NO_CACHE_LEAK'
    } else {
      observed = (arrivalHidden && revealSeen && rehideUpdates.length > 0 && !cacheDirty)
        ? 'REVEAL_THEN_REHIDE'
        : (cacheDirty ? 'CACHE_LEAK' : 'INCOMPLETE_SEQUENCE')
    }
    result.outcome = observed
    result.expectationMet = observed === result.expectation
    result.pass = result.expectationMet
    if (!result.pass) {
      result.failureReason = BASELINE
        ? 'baseline cache did not end with a leaked chest state; the replay probe cannot prove a leak'
        : (cacheDirty
            ? 'the last state sent for the chest position is the real chest - a replaying client would cache it'
            : 'sequence incomplete: expected chunk-hidden arrival, a near reveal, and a far re-hide update')
    }
  } catch (e) {
    result.outcome = 'ERROR'
    result.error = String(e && e.stack || e)
    result.failureReason = 'harness exception: ' + (e && e.message)
    result.pass = false
    addError(`scenario F: ${e.message}`)
  }
  result.durationMs = Date.now() - t0
  return result
}

// ------------------------------------------------------------------ summary + report
function printSummary (report) {
  const line = (s) => console.log(s)
  line('')
  line('================================================================================')
  line(`BaseHider integration test  ${report.baselineMode ? '[BASELINE MODE - old jar, leaks expected]' : '[PLUGIN UNDER TEST]'}`)
  line(`run: ${report.runId}    plugin: ${report.plugin ? path.basename(report.plugin.jarPath) : '?'} (${report.plugin ? report.plugin.sha256.slice(0, 12) : '?'})`)
  line(`server boot: ${report.server && report.server.bootMs != null ? report.server.bootMs + 'ms' : 'n/a'}    decoder self-test: ${report.decoderSelfTest && report.decoderSelfTest.ok ? 'OK' : 'FAILED'}`)
  line('--------------------------------------------------------------------------------')
  for (const id of SCENARIO_ORDER) {
    const r = report.scenarios[id]
    if (!r) continue
    const verdict = r.pass ? 'PASS' : (r.outcome === 'INCONCLUSIVE' || r.outcome === 'ERROR' ? 'ERROR' : 'FAIL')
    let detail = ''
    if (id === 'A' || id === 'B') {
      const pb = (r.evidence && r.evidence.perBot) || {}
      const spawns = Object.values(pb).map(b => `${b.username}:${b.itemSpawnPackets ?? b.spawnPackets} spawn`)
      detail = `${spawns.join(', ')}`
      if (id === 'A') detail += `; followups=${r.evidence.totalFollowupPackets ?? 0}`
      if (id === 'B') {
        const first = Object.values(pb).find(b => b.firstSpawnLatencyMs != null)
        detail += `; latency=${first ? first.firstSpawnLatencyMs + 'ms' : 'n/a'}; followups=${Object.values(pb).reduce((n, b) => n + (b.followupPackets || 0), 0)}`
      }
    }
    if (id === 'C') {
      const ch = r.evidence.chestInChunkData
      const obs = r.evidence.decoderPositiveControls && r.evidence.decoderPositiveControls.observerPresent
      detail = `chest_in_chunk=${ch}; observer_marker=${obs}; chest_states_in_section=${r.evidence.chestStatesInSection}`
      if (r.evidence.resend) detail += `; resend_chunk_packets=${r.evidence.resend.chunkPacketsForRoomChunkAfterReturn}`
    }
    if (id === 'D') {
      const bands = (r.evidence && r.evidence.perBand) || {}
      detail = Object.values(bands).map(b => `${b.label}: chunk=${b.chunkPacketsReceived} chest_leak=${b.leak}`).join('; ')
    }
    if (id === 'E') {
      detail = `chunks=${r.evidence.chunkPacketsScanned}; hidden_container_BEs=${r.evidence.hiddenContainerBlockEntities}; sign_BEs=${r.evidence.signBlockEntities}`
    }
    if (id === 'F') {
      const ev = r.evidence || {}
      detail = `arrival_hidden=${ev.arrivalState && ev.arrivalState.hidden}; reveal=${ev.revealSeen}; rehide_updates=${(ev.rehideUpdates || []).length}; final=${ev.finalCachedState && ev.finalCachedState.name}`
    }
    line(`[${verdict}] ${id} ${r.name}`)
    line(`       expected=${r.expectation} observed=${r.outcome} ${detail} ${r.failureReason ? '\n       reason: ' + r.failureReason : ''} (${r.durationMs}ms)`)
  }
  line('--------------------------------------------------------------------------------')
  line(`OVERALL: ${report.overall.pass ? 'PASS' : 'FAIL'} (${report.overall.reason})`)
  if (report.artifacts.captures) {
    for (const [name, p] of Object.entries(report.artifacts.captures)) line(`capture ${name}: ${p}`)
  }
  if (report.server && report.server.logPath) line(`server log: ${report.server.logPath}`)
  line(`report: ${report.artifacts.reportPath}`)
  line('================================================================================')
}

// ------------------------------------------------------------------ main
async function main () {
  const runId = `run-${stamp()}`
  report.runId = runId
  const runDir = path.join(OUT_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })
  report.artifacts.runDir = runDir

  // --- plugin metadata -------------------------------------------------------
  if (!fs.existsSync(JAR_PATH)) throw new Error(`plugin jar not found: ${JAR_PATH}`)
  const jarStat = fs.statSync(JAR_PATH)
  let pluginYml = null
  try {
    const AdmZip = null // no zip lib; use jar tool
    const jarTool = path.join(JAVA_HOME, 'bin', 'jar.exe')
    const tmpDir = path.join(runDir, 'plugin-yml')
    fs.mkdirSync(tmpDir, { recursive: true })
    execFileSync(jarTool, ['xf', JAR_PATH, 'plugin.yml'], { cwd: tmpDir, timeout: 30000 })
    pluginYml = fs.readFileSync(path.join(tmpDir, 'plugin.yml'), 'utf8')
  } catch (e) {
    addError(`could not read plugin.yml from jar: ${e.message}`)
  }
  report.plugin = {
    jarPath: JAR_PATH,
    size: jarStat.size,
    sha256: sha256(JAR_PATH),
    pluginYmlName: pluginYml ? (pluginYml.match(/^name:\s*(.+)$/m) || [])[1] : null,
    pluginYmlVersion: pluginYml ? (pluginYml.match(/^version:\s*(.+)$/m) || [])[1] : null,
    packetEventsInstalled: fs.existsSync(path.join(SERVER_DIR, 'plugins', 'PacketEvents.jar'))
  }

  // --- chunk decoder self-test ----------------------------------------------
  report.decoderSelfTest = cd.selfTest()

  // --- server ----------------------------------------------------------------
  const server = new PaperServer(runDir)
  const bots = {
    testBot: new BotHandle('TestBot', runDir),
    testBot2: new BotHandle('TestBot2', runDir)
  }
  report.server = {
    dir: SERVER_DIR,
    jar: path.join(SERVER_DIR, 'paper-1.21.4.jar'),
    port: SERVER_PORT,
    rconPort: RCON_PORT,
    logPath: server.logPath,
    bootMs: null,
    versionLine: null,
    rconReady: false,
    crashDetected: false
  }
  report.artifacts.captures = {}
  report.artifacts.chunkDirs = {}
  report.artifacts.botStderrLogs = {}
  for (const bot of Object.values(bots)) {
    report.artifacts.captures[bot.name] = bot.ndjsonPath
    report.artifacts.chunkDirs[bot.name] = bot.chunkDir
    report.artifacts.botStderrLogs[bot.name] = bot.stderrPath
  }

  let exitCode = 2
  let serverStarted = false
  try {
    await server.preflight()
    console.log(`[driver] starting Paper server on port ${SERVER_PORT} (log: ${server.logPath})`)
    server.start()
    serverStarted = true
    const bootMs = await server.waitForDone(BOOT_TIMEOUT_MS)
    report.server.bootMs = bootMs
    report.server.pid = server.proc && server.proc.pid
    report.server.pidFile = SERVER_PID_FILE
    const versionLine = server.lines.find(l => /Starting minecraft server version|Loading Paper/.test(l))
    report.server.versionLine = versionLine ? versionLine.trim() : null
    console.log(`[driver] server ready after ${bootMs}ms: ${versionLine ? versionLine.trim() : ''}`)
    await server.connectRcon()
    report.server.rconReady = true
    // Detect a server crash while scenarios run (report it once).
    let crashReported = false
    const crashWatcher = setInterval(() => {
      if (server.exited && !server.stopped && !crashReported) {
        crashReported = true
        report.server.crashDetected = true
        addError('Paper server exited unexpectedly during the test run')
      }
    }, 500)
    crashWatcher.unref()

    // --- bots ---------------------------------------------------------------
    for (const bot of Object.values(bots)) bot.start()
    const [ready1, ready2] = await Promise.all([bots.testBot.waitReady(), bots.testBot2.waitReady()])
    report.bots = { TestBot: ready1, TestBot2: ready2 }
    console.log(`[driver] bots ready: ${ready1.username} entity=${ready1.entityId} @ ${ready1.position.x},${ready1.position.y},${ready1.position.z}; ${ready2.username} entity=${ready2.entityId}`)
    // Creative mode is needed for the bot-side chest placement in scenario C.
    for (const name of Object.keys(bots)) {
      try { await server.rconCmd(`gamemode creative ${name}`) } catch (e) { addError(`gamemode creative ${name}: ${e.message}`) }
    }

    const harness = new Harness(server, bots)
    const assertServerAlive = async (stage) => {
      await sleep(250) // let the child-process 'exit' event be delivered
      const exitCode = server.proc ? server.proc.exitCode : null
      if ((server.exited || exitCode !== null) && !server.stopped) {
        throw new Error(`Paper server process died unexpectedly during ${stage} (exit=${JSON.stringify(server.exitInfo || { code: exitCode })}); see ${server.logPath}`)
      }
    }
    if (which.includes('A')) {
      await assertServerAlive('startup')
      console.log('[driver] scenario A: hidden dropped item ...')
      report.scenarios.A = await scenarioA(harness)
      printScenarioProgress(report.scenarios.A)
      await assertServerAlive('scenario A')
    }
    if (which.includes('B')) {
      await assertServerAlive('between scenarios')
      console.log('[driver] scenario B: visible dropped item ...')
      report.scenarios.B = await scenarioB(harness)
      printScenarioProgress(report.scenarios.B)
      await assertServerAlive('scenario B')
    }
    if (which.includes('C')) {
      await assertServerAlive('between scenarios')
      console.log('[driver] scenario C: chunk-level chest hiding ...')
      report.scenarios.C = await scenarioC(harness)
      printScenarioProgress(report.scenarios.C)
      await assertServerAlive('scenario C')
    }
    if (which.includes('D')) {
      await assertServerAlive('between scenarios')
      console.log('[driver] scenario D: far-band block-entity leak (160/336 blocks) ...')
      report.scenarios.D = await scenarioD(harness)
      printScenarioProgress(report.scenarios.D)
      await assertServerAlive('scenario D')
    }
    if (which.includes('E')) {
      await assertServerAlive('between scenarios')
      console.log('[driver] scenario E: pie-ray client block-entity registry scan ...')
      report.scenarios.E = await scenarioE(harness)
      printScenarioProgress(report.scenarios.E)
      await assertServerAlive('scenario E')
    }
    if (which.includes('F')) {
      await assertServerAlive('between scenarios')
      console.log('[driver] scenario F: Bobby/Distant Horizons cache replay ...')
      report.scenarios.F = await scenarioF(harness)
      printScenarioProgress(report.scenarios.F)
      await assertServerAlive('scenario F')
    }
    report.rconTrace = harness.rconTrace
  } catch (e) {
    addError(`harness failure: ${e && e.stack || e}`)
    report.overall = { pass: false, reason: `harness error: ${e && e.message}` }
  } finally {
    // --- teardown -----------------------------------------------------------
    for (const bot of Object.values(bots)) {
      try { await bot.quit() } catch (e) { addError(`bot ${bot.name} quit: ${e.message}`) }
    }
    if (serverStarted) {
      const stopInfo = await server.stop(KEEP_SERVER ? 'keep-server' : 'run-finished')
      report.server.stopped = stopInfo
      if (KEEP_SERVER) console.log('[driver] --keep-server: leaving the server process running on purpose')
    }
  }

  // --- verdict ---------------------------------------------------------------
  const scenarioIds = Object.keys(report.scenarios)
  const missingScenarios = which.filter(id => !report.scenarios[id])
  if (report.overall.reason !== 'not-finished' && report.overall.reason.startsWith('harness error')) {
    exitCode = 2
  } else if (!missingScenarios.length && which.every(id => report.scenarios[id].pass) && !report.server.crashDetected) {
    report.overall = {
      pass: true,
      reason: BASELINE
        ? 'baseline validation passed - all expected leaks/visibility differences were detected'
        : 'all scenarios meet plugin expectations (items hidden/visible, chunk + far-band containers hidden, clean client BE registry, cache re-hidden)'
    }
    exitCode = 0
  } else {
    const failed = missingScenarios.length ? missingScenarios : scenarioIds.filter(id => !report.scenarios[id].pass)
    report.overall = { pass: false, reason: `failed scenarios: ${failed.join(', ') || 'none recorded'}` }
    exitCode = 1
  }
  report.finishedAt = nowIso()
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt)
  report.artifacts.consoleLog = server.logPath
  report.artifacts.dedup = undefined

  // --- write report ----------------------------------------------------------
  const reportPath = path.join(OUT_DIR, `report-${stamp()}.json`)
  report.artifacts.reportPath = reportPath
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2))
  printSummary(report)
  process.exit(exitCode)
}

function printScenarioProgress (r) {
  const icon = r.pass ? 'PASS' : (r.outcome === 'ERROR' || r.outcome === 'INCONCLUSIVE' ? 'ERROR' : 'FAIL')
  console.log(`[driver] scenario ${r.id}: ${icon} expectation=${r.expectation} observed=${r.outcome} (${r.durationMs}ms)`)
}

main().catch((e) => {
  console.error('[driver] FATAL', e && e.stack || e)
  report.overall = { pass: false, reason: `fatal: ${e && e.message}` }
  try { fs.writeFileSync(path.join(OUT_DIR, 'latest-report.json'), JSON.stringify(report, null, 2)) } catch (_) {}
  process.exit(2)
})
