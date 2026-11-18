#!/usr/bin/env node
'use strict'
/**
 * load-bot.js - lightweight headless Minecraft Java 1.21.4 bot worker for the
 * BaseHider load-test harness.
 *
 * One OS process can host many minecraft-protocol clients (the orchestrator
 * `bench/load-bench.js` uses --workers to spread large bot counts over a few
 * worker processes).  Each client:
 *   - connects with auth=offline and username <prefix><index>
 *   - completes login + configuration state (handled by minecraft-protocol)
 *   - answers server keep_alive automatically (minecraft-protocol's built-in
 *     keepalive plugin; we do not duplicate it)
 *   - confirms every server position/teleport packet and echoes its position
 *     back, which is required for the server to keep streaming chunks
 *   - counts received packets / bytes / chunks / keep-alives in memory only
 *   - writes no capture files and does no packet decoding beyond what
 *     minecraft-protocol already does
 *
 * Spawn = first play-state `position` packet after the play-state `login`
 * packet; connect-to-spawn latency is measured per bot from client creation.
 *
 * stdout is NDJSON control/evidence output (one JSON object per line):
 *   {"type":"worker_started", ...}
 *   {"type":"bot_spawned", "index":1, "username":"LoadBot1",
 *    "connectToSpawnMs":432, "connectMs":300, "loginMs":390, "position":{...}}
 *   {"type":"bot_failed", "index":1, "phase":"play", "reason":"..."}
 *   {"type":"status", "bots":[...]}            (reply to {"cmd":"status"})
 *   {"type":"summary", ...}                    (written once on exit)
 *
 * stdin accepts one JSON command per line:
 *   {"cmd":"status"}  -> immediately writes a {"type":"status"} line
 *   {"cmd":"quit"}    -> disconnect all bots and exit 0
 *
 * Usage (normally launched by load-bench.js):
 *   node bench/load-bot.js --bots 10 --start-index 1 --stagger-ms 75
 */
const path = require('path')
const readline = require('readline')

// --------------------------------------------------------------------- config
function parseArgs (argv) {
  const args = {
    bots: 1,
    startIndex: 1,
    usernamePrefix: 'LoadBot',
    host: '127.0.0.1',
    port: 25599,
    version: '1.21.4',
    staggerMs: 75,
    maxMs: 30 * 60 * 1000,
    viewDistance: 4
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--bots') args.bots = parseInt(next(), 10)
    else if (a === '--start-index') args.startIndex = parseInt(next(), 10)
    else if (a === '--username-prefix') args.usernamePrefix = String(next())
    else if (a === '--host') args.host = String(next())
    else if (a === '--port') args.port = parseInt(next(), 10)
    else if (a === '--version') args.version = String(next())
    else if (a === '--stagger-ms') args.staggerMs = parseInt(next(), 10)
    else if (a === '--max-ms') args.maxMs = parseInt(next(), 10)
    else if (a === '--view-distance') args.viewDistance = parseInt(next(), 10)
  }
  return args
}

/**
 * Resolve minecraft-protocol.  The package lives in D:/Basehider/itest/bot/node_modules
 * (installed there by the integration harness), which is NOT an ancestor of
 * D:/Basehider/bench, so normal Node resolution from this file would fail.
 * MC_PROTOCOL_DIR can override the node_modules directory.
 */
function loadMcProtocol () {
  const candidates = [
    process.env.MC_PROTOCOL_DIR ? path.join(process.env.MC_PROTOCOL_DIR, 'minecraft-protocol') : null,
    'D:/Basehider/itest/bot/node_modules/minecraft-protocol',
    path.join(__dirname, '..', 'itest', 'bot', 'node_modules', 'minecraft-protocol')
  ].filter(Boolean)
  let lastError = null
  for (const candidate of candidates) {
    try {
      return { mc: require(candidate), resolvedFrom: candidate }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    'load-bot: cannot load minecraft-protocol; tried ' + candidates.join(', ') +
    '; last error: ' + (lastError && lastError.message)
  )
}

const ARGS = parseArgs(process.argv.slice(2))

let mcModule
try {
  mcModule = loadMcProtocol()
} catch (error) {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.stdout.write(JSON.stringify({ type: 'fatal', error: String(error && error.message) }) + '\n')
  process.exit(2)
}
const mc = mcModule.mc
const MC_RESOLVED_FROM = mcModule.resolvedFrom

// --------------------------------------------------------------------- helpers
function nowIso () { return new Date().toISOString() }
function emit (obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch (_) { /* stdout closed */ }
}
function round (value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const m = Math.pow(10, digits)
  return Math.round(value * m) / m
}
/** Compact text for a kick reason / error object. */
function describeReason (reason) {
  if (reason == null) return null
  try {
    if (typeof reason === 'string') return reason
    const json = JSON.stringify(reason)
    return json && json.length > 300 ? json.slice(0, 300) + '...' : json
  } catch (_) {
    return String(reason)
  }
}
function pushErrorSample (st, message) {
  if (st.errorSamples.length < 3 && message) st.errorSamples.push(message)
}

// --------------------------------------------------------------------- state
const bots = []
const scheduledTimers = []
let quitting = false
let summaryWritten = false
const workerStartedAt = Date.now()
let lifetimeTimer = null

// --------------------------------------------------------------------- bots
function makeBotState (index) {
  return {
    index,
    username: (ARGS.usernamePrefix + index).slice(0, 16),
    createdAt: Date.now(),
    connectedAt: null,
    loginAt: null,
    spawnedAt: null,
    endedAt: null,
    lastPacketAt: null,
    state: 'pending',
    entityId: null,
    position: null,
    packets: 0,
    bytes: 0,
    chunks: 0,
    keepAlives: 0,
    errors: 0,
    errorSamples: [],
    kickReason: null,
    spawnedEmitted: false,
    failedEmitted: false,
    client: null
  }
}

function emitSpawned (st) {
  if (st.spawnedEmitted) return
  st.spawnedEmitted = true
  emit({
    type: 'bot_spawned',
    index: st.index,
    username: st.username,
    entityId: st.entityId,
    connectToSpawnMs: st.connectToSpawnMs,
    connectMs: st.connectedAt ? st.connectedAt - st.createdAt : null,
    loginMs: st.loginAt ? st.loginAt - st.createdAt : null,
    position: st.position
      ? { x: round(st.position.x, 3), y: round(st.position.y, 3), z: round(st.position.z, 3) }
      : null,
    at: nowIso()
  })
}

function failBot (st, phase, reason) {
  if (st.failedEmitted) return
  st.failedEmitted = true
  if (st.state !== 'kicked') st.state = st.state === 'failed' ? 'failed' : (st.spawnedAt ? 'failed-after-spawn' : 'failed')
  emit({
    type: 'bot_failed',
    index: st.index,
    username: st.username,
    phase,
    reason: reason == null ? null : String(reason),
    spawned: !!st.spawnedAt,
    errors: st.errors,
    errorSamples: st.errorSamples,
    at: nowIso()
  })
}

function createBot (index) {
  const st = makeBotState(index)
  bots.push(st)
  st.state = 'connecting'
  let client
  try {
    client = mc.createClient({
      host: ARGS.host,
      port: ARGS.port,
      username: st.username,
      version: ARGS.version,
      auth: 'offline',
      hideErrors: true,
      clientSettings: {
        locale: 'en_us',
        viewDistance: ARGS.viewDistance,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true
      }
    })
  } catch (error) {
    st.state = 'failed'
    failBot(st, 'create', error && error.message ? error.message : String(error))
    return
  }
  st.client = client

  client.on('connect', () => {
    st.connectedAt = Date.now()
    if (st.state === 'connecting') st.state = 'connected'
  })

  client.on('login', (packet) => {
    // play-state login packet: configuration state is complete, player is in world
    st.loginAt = Date.now()
    if (packet && packet.entityId !== undefined) st.entityId = packet.entityId
    if (st.state === 'connecting' || st.state === 'connected') st.state = 'play'
  })

  client.on('position', (packet) => {
    st.lastPacketAt = Date.now()
    st.position = { x: packet.x, y: packet.y, z: packet.z, yaw: packet.yaw, pitch: packet.pitch }
    // Required handshake: confirm every server teleport so chunk streaming continues.
    try {
      client.write('teleport_confirm', { teleportId: packet.teleportId })
    } catch (error) {
      st.errors++
      pushErrorSample(st, 'teleport_confirm: ' + error.message)
    }
    // Echo our authoritative position back so the server keeps us tracked.
    try {
      client.write('position_look', {
        x: packet.x,
        y: packet.y,
        z: packet.z,
        yaw: packet.yaw,
        pitch: packet.pitch,
        flags: 0
      })
    } catch (error) {
      st.errors++
      pushErrorSample(st, 'position_look: ' + error.message)
    }
    if (!st.spawnedAt) {
      st.spawnedAt = Date.now()
      st.state = 'spawned'
      st.connectToSpawnMs = st.spawnedAt - st.createdAt
      emitSpawned(st)
    }
  })

  // In-memory counters only: we never serialize or store packet payloads.
  client.on('packet', (data, meta, buffer) => {
    st.packets++
    if (buffer && buffer.length) st.bytes += buffer.length
    st.lastPacketAt = Date.now()
    if (meta && meta.name) {
      if (meta.name === 'map_chunk') st.chunks++
      else if (meta.name === 'keep_alive') st.keepAlives++
    }
  })

  client.on('kick_disconnect', (packet) => {
    st.kickReason = describeReason(packet && packet.reason)
    st.state = 'kicked'
    failBot(st, st.spawnedAt ? 'play' : 'login', 'kicked: ' + st.kickReason)
  })

  client.on('error', (error) => {
    st.errors++
    pushErrorSample(st, String(error && error.message ? error.message : error))
  })

  client.on('end', (reason) => {
    st.endedAt = Date.now()
    if (!st.spawnedAt && st.state !== 'kicked' && !st.failedEmitted) {
      failBot(st, st.state, 'connection ended before spawn (' + String(reason || '') + ')')
    }
  })
}

function botStatus (st) {
  return {
    i: st.index,
    u: st.username,
    s: st.state,
    spawned: !!st.spawnedAt,
    pos: st.position
      ? [round(st.position.x, 2), round(st.position.y, 2), round(st.position.z, 2)]
      : null,
    pk: st.packets,
    kb: st.bytes,
    ch: st.chunks,
    ka: st.keepAlives,
    err: st.errors,
    sincePkMs: st.lastPacketAt ? Date.now() - st.lastPacketAt : null,
    aliveMs: Date.now() - st.createdAt,
    spawnMs: st.connectToSpawnMs,
    kick: st.kickReason
  }
}

function emitStatus () {
  const statuses = bots.map(botStatus)
  emit({
    type: 'status',
    at: nowIso(),
    workerUptimeMs: Date.now() - workerStartedAt,
    workerBots: bots.length,
    spawned: statuses.filter((s) => s.spawned).length,
    alive: bots.filter((b) => b.spawnedAt && !b.endedAt).length,
    failed: bots.filter((b) => b.failedEmitted).length,
    totalPackets: statuses.reduce((sum, s) => sum + s.pk, 0),
    totalBytes: statuses.reduce((sum, s) => sum + s.kb, 0),
    bots: statuses
  })
}

function writeSummary (exitReason, exitCode) {
  if (summaryWritten) return
  summaryWritten = true
  const statuses = bots.map(botStatus)
  emit({
    type: 'summary',
    at: nowIso(),
    pid: process.pid,
    workerUptimeMs: Date.now() - workerStartedAt,
    requestedBots: ARGS.bots,
    startIndex: ARGS.startIndex,
    startedBots: bots.length,
    spawnedBots: statuses.filter((s) => s.spawned).length,
    aliveBots: bots.filter((b) => b.spawnedAt && !b.endedAt).length,
    failedBots: bots.filter((b) => b.failedEmitted).length,
    totalPackets: statuses.reduce((sum, s) => sum + s.pk, 0),
    totalBytes: statuses.reduce((sum, s) => sum + s.kb, 0),
    exitReason,
    exitCode,
    mcProtocolResolvedFrom: MC_RESOLVED_FROM,
    bots: statuses
  })
}

// --------------------------------------------------------------------- shutdown
function quit (code, reason) {
  if (quitting) return
  quitting = true
  for (const timer of scheduledTimers) clearTimeout(timer)
  if (lifetimeTimer) clearTimeout(lifetimeTimer)
  try { rl.close() } catch (_) { /* rl may not exist yet */ }
  const active = bots.filter((b) => b.client && !b.endedAt)
  for (const b of active) {
    try { b.client.end('load-bench-quit') } catch (_) { /* already gone */ }
  }
  if (active.length === 0) {
    writeSummary(reason, code)
    setTimeout(() => process.exit(code), 50)
    return
  }
  const deadline = Date.now() + 5000
  const timer = setInterval(() => {
    const left = bots.filter((b) => b.client && !b.endedAt).length
    if (left === 0 || Date.now() > deadline) {
      clearInterval(timer)
      writeSummary(reason, code)
      setTimeout(() => process.exit(code), 50)
    }
  }, 50)
  timer.unref()
}

// --------------------------------------------------------------------- stdin control channel
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch (error) {
    emit({ type: 'control_error', error: 'bad json: ' + line.slice(0, 120) })
    return
  }
  if (cmd && cmd.cmd === 'status') {
    emitStatus()
  } else if (cmd && cmd.cmd === 'quit') {
    quit(0, 'quit')
  } else {
    emit({ type: 'control_error', error: 'unknown command: ' + String(cmd && cmd.cmd) })
  }
})
rl.on('close', () => {
  // Parent/orchestrator is gone: do not leave orphan bot connections behind.
  if (!quitting) quit(0, 'stdin-closed')
})

process.on('SIGINT', () => quit(0, 'sigint'))
process.on('SIGTERM', () => quit(0, 'sigterm'))
process.on('uncaughtException', (error) => {
  emit({ type: 'worker_uncaught', error: String(error && error.stack ? error.stack : error) })
  writeSummary('uncaughtException', 5)
  setTimeout(() => process.exit(5), 50)
})
process.on('unhandledRejection', (error) => {
  emit({ type: 'worker_unhandled_rejection', error: describeReason(error) })
})

// --------------------------------------------------------------------- start
function scheduleAll () {
  emit({
    type: 'worker_started',
    at: nowIso(),
    pid: process.pid,
    node: process.version,
    requestedBots: ARGS.bots,
    startIndex: ARGS.startIndex,
    usernamePrefix: ARGS.usernamePrefix,
    host: ARGS.host,
    port: ARGS.port,
    version: ARGS.version,
    staggerMs: ARGS.staggerMs,
    viewDistance: ARGS.viewDistance,
    mcProtocolResolvedFrom: MC_RESOLVED_FROM
  })
  for (let k = 0; k < ARGS.bots; k++) {
    const index = ARGS.startIndex + k
    if (ARGS.staggerMs <= 0) {
      if (!quitting) createBot(index)
      continue
    }
    const timer = setTimeout(() => {
      if (!quitting) createBot(index)
    }, k * ARGS.staggerMs)
    scheduledTimers.push(timer)
  }
}

lifetimeTimer = setTimeout(() => {
  emit({ type: 'worker_lifetime_exceeded', maxMs: ARGS.maxMs, at: nowIso() })
  quit(4, 'lifetime')
}, Math.max(1000, ARGS.maxMs))

scheduleAll()
