'use strict'
/* Interactive diagnostic driver for BaseHider on the itest Paper server.
 * Connects over RCON, runs a scripted set of fixtures and prints plugin state plus
 * a small packet summary parsed from the ProbeBot NDJSON capture.
 */
const fs = require('fs')
const path = require('path')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))

const CAPTURE = 'D:/Basehider/bench/ProbeBot.ndjson'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stripMinecraftFormatting (text) {
  return (text || '').replace(/§[0-9a-fklmnor]/gi, '')
}

class R {
  constructor () {
    this.rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 20000 })
  }

  async connect () { await this.rcon.connect() }

  async cmd (command) {
    const response = await this.rcon.cmd(command)
    console.log(`\nCMD ${command}`)
    console.log(stripMinecraftFormatting(response).trim())
    return response
  }

  close () { this.rcon.close() }
}

function readCaptureLines () {
  if (!fs.existsSync(CAPTURE)) return []
  return fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch (_) { return null }
  }).filter(Boolean)
}

function summarizePackets (label) {
  const lines = readCaptureLines()
  const counts = {}
  for (const line of lines) {
    if (line.state !== 'play') continue
    counts[line.name] = (counts[line.name] || 0) + 1
  }
  console.log(`\n[packets] ${label}: ` + Object.entries(counts)
    .filter(([name]) => ['spawn_entity', 'level_chunk_with_light', 'block_update', 'multi_block_change'].includes(name))
    .map(([name, count]) => `${name}=${count}`).join(' '))
  const spawns = lines.filter((line) => line.name === 'spawn_entity' && line.state === 'play')
  for (const spawn of spawns.slice(-8)) {
    const d = spawn.data
    console.log(`  spawn id=${d.entityId} uuid=${d.objectUUID} type=${d.type} pos=(${d.x},${d.y},${d.z})`)
  }
  return { lines, counts, spawns }
}

async function main () {
  const r = new R()
  await r.connect()
  try {
    await r.cmd('gamerule sendCommandFeedback true')
    await r.cmd('basehider diag')

    // 1) item registration check: summon an item while the bot is online
    await r.cmd('kill @e[type=minecraft:item]')
    await r.cmd('summon minecraft:item 10.5 -59 10.5 {NoGravity:1b,PickupDelay:32767s,Item:{id:"minecraft:diamond",count:1}}')
    await sleep(800)
    await r.cmd('basehider diag')
    summarizePackets('after summon')

    // 2) place a chest with a console command (no BlockPlaceEvent) and wait for reconciliation
    await r.cmd('kill @e[type=minecraft:item]')
    await r.cmd('setblock 12 -60 12 minecraft:chest')
    await sleep(500)
    await r.cmd('basehider diag')
    await sleep(3000)
    await r.cmd('basehider diag')

    // 3) chunk resend: teleport far away and back, then look at chest chunk data
    await r.cmd('tp ProbeBot 12.5 -60 14.5 180 0')
    await sleep(400)
    await r.cmd('tp ProbeBot 1012.5 -60 1014.5 180 0')
    await sleep(800)
    await r.cmd('tp ProbeBot 12.5 -60 14.5 180 0')
    await sleep(1200)
    await r.cmd('basehider diag')
    summarizePackets('after resend')
  } finally {
    r.close()
  }
}

main().catch((error) => {
  console.error('DIAGNOSE ERROR', error)
  process.exit(1)
})
