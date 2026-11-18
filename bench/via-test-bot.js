'use strict'
/* Headless capture bot for ViaVersion compatibility testing.
 * Usage: node via-test-bot.js <version> <outfile> [username]
 * Logs entity-related play packets as NDJSON and prints BOT_READY <json> on spawn.
 */
const fs = require('fs')
let mc
try {
  mc = require('minecraft-protocol')
} catch (_) {
  mc = require('D:/Basehider/itest/bot/node_modules/minecraft-protocol')
}

const version = process.argv[2] || '1.21.4'
const outFile = process.argv[3] || 'D:/Basehider/bench/via-test.ndjson'
const username = process.argv[4] || 'ViaTest'
const stream = fs.createWriteStream(outFile, { flags: 'w' })
let ready = false
let packetCount = 0
const entityPackets = new Map()

const bot = mc.createClient({
  host: '127.0.0.1',
  port: 25599,
  username,
  version,
  auth: 'offline'
})

bot.on('packet', (data, meta) => {
  packetCount++
  const name = meta.name
  if (/block_change|block_update|multi_block/i.test(name)) {
    console.log('BLOCK_CHANGE ' + JSON.stringify({ name, data }))
    return
  }
  if (/chunk/i.test(name)) {
    const chunkData = data && data.chunkData
    const blockEntities = data && (data.blockEntities || data.blockEntityList || [])
    let chestLike = 0
    let entitySummary = null
    try {
      const serialized = JSON.stringify(blockEntities)
      chestLike = (serialized.match(/chest/gi) || []).length
      entitySummary = serialized.slice(0, 600)
    } catch (_) {}
    const info = {
      name,
      x: data ? data.x : undefined,
      z: data ? data.z : undefined,
      chunkBytes: Buffer.isBuffer(chunkData) ? chunkData.length : null,
      blockEntities: Array.isArray(blockEntities) ? blockEntities.length : null,
      chestLike,
      entitySummary
    }
    console.log('CHUNK_INFO ' + JSON.stringify(info))
    if (Buffer.isBuffer(chunkData)) {
      try {
        fs.appendFileSync(outFile + '.chunks.bin', chunkData)
      } catch (_) {}
    }
    return
  }
  if (!/entity|spawn|destroy|remove|player_info|respawn|position/i.test(name)) {
    return
  }
  stream.write(JSON.stringify({ at: Date.now(), name, data }) + '\n')
  const id = data && (data.entityId !== undefined ? data.entityId
    : data.entityId === undefined && data.eid !== undefined ? data.eid : undefined)
  if (id !== undefined) {
    const entry = entityPackets.get(name) || []
    entry.push(id)
    entityPackets.set(name, entry)
  }
  if (name === 'spawn_entity' || name === 'spawn_entity_living' || name === 'named_entity_spawn') {
    console.log('ENTITY_SPAWN ' + JSON.stringify({ name, data }))
  }
})

bot.on('error', (error) => {
  console.error('BOT_ERROR ' + error.message)
  process.exit(2)
})
bot.on('kicked', (reason) => {
  console.error('BOT_KICKED ' + JSON.stringify(reason))
  process.exit(3)
})
bot.once('login', () => {
  console.log('BOT_LOGIN version=' + version)
  // Some protocol versions do not emit the library's 'spawn' helper event reliably;
  // consider the bot ready once login succeeds so orchestration can proceed.
  setTimeout(() => {
    if (!ready) {
      ready = true
      const position = bot.entity && bot.entity.position ? bot.entity.position : null
      console.log('BOT_READY ' + JSON.stringify({ version, position, username, fallback: true }))
    }
  }, 3000)
})
bot.once('spawn', () => {
  ready = true
  const position = bot.entity && bot.entity.position ? bot.entity.position : null
  console.log('BOT_READY ' + JSON.stringify({ version, position, username }))
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (line) => {
  if (line.trim() === 'status') {
    console.log('BOT_STATUS ' + JSON.stringify({
      ready, packets: packetCount,
      entityPackets: Object.fromEntries([...entityPackets].map(([k, v]) => [k, v.length])),
      entities: Object.keys(bot.entities || {}).length
    }))
  }
  if (line.trim() === 'quit') {
    shutdown()
  }
})

function shutdown () {
  try { stream.end() } catch (_) {}
  try { bot.end('test done') } catch (_) {}
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', shutdown)
setTimeout(() => {
  console.error('BOT_TIMEOUT ready=' + ready)
  shutdown()
}, 180000)
