'use strict'
const fs = require('fs')
const path = require('path')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))
const cd = require(path.join('D:/Basehider/itest/bot/lib/chunk-decoder.js'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')
const CAPTURE = 'D:/Basehider/bench/ProbeBot.ndjson'
const CHUNK_DIR = 'D:/Basehider/bench/ProbeBot-chunks'

async function main () {
  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 20000 })
  await rcon.connect()
  const cmd = async (command) => {
    const response = strip(await rcon.cmd(command)).trim()
    console.log(`CMD ${command}\n${response}`)
    return response
  }
  const diag = async () => {
    const text = await cmd('basehider diag')
    return {
      text,
      blocks: Number(/blocks=(\d+)/.exec(text)?.[1]),
      chunks: Number(/chunks=(\d+)/.exec(text)?.[1]),
      sanitized: Number(/chunkSanitized=(\d+)/.exec(text)?.[1]),
      tracked: Number(/tracked=(\d+)/.exec(text)?.[1])
    }
  }
  try {
    await cmd('basehider verify')
    console.log('initial', await diag())

    // Registered-block path: console setblock has no BlockPlaceEvent -> rescan discovers it.
    await cmd('fill 10 -60 10 14 -58 14 minecraft:air')
    await cmd('setblock 12 -60 12 minecraft:chest')
    const rescan = await cmd('basehider rescan')
    console.log(rescan)
    const afterRescan = await diag()
    console.log('after rescan blocks=', afterRescan.blocks, 'chunks=', afterRescan.chunks)

    // Item registration check (summon = ItemSpawnEvent path after fix).
    await cmd('kill @e[type=minecraft:item]')
    await cmd('tp ProbeBot 12.5 -60 14.5 180 0')
    await sleep(400)
    await cmd('tp ProbeBot 12.5 -60 14.5 0 0')
    await sleep(300)
    await cmd('summon minecraft:item 40.5 -59 40.5 {NoGravity:1b,PickupDelay:32767s,Item:{id:"minecraft:diamond",count:1}}')
    await sleep(800)
    const afterSummon = await diag()
    console.log('after summon tracked=', afterSummon.tracked)

    // Chunk resend and decode.
    const beforeResend = Date.now()
    await cmd('tp ProbeBot 1012.5 -60 1014.5 180 0')
    await sleep(1500)
    await cmd('tp ProbeBot 12.5 -60 14.5 180 0')
    await sleep(2500)
    const after = await diag()
    console.log('after resend blocks=', after.blocks, 'sanitized=', after.sanitized)

    const files = fs.readdirSync(CHUNK_DIR)
      .filter((name) => /c0_0\.bin$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(CHUNK_DIR, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
    const newest = files[files.length - 1]
    if (newest) {
      const decoded = cd.decodeChunkData(fs.readFileSync(path.join(CHUNK_DIR, newest.name)))
      const state = cd.getBlockState(decoded, 12, -60, 12)
      console.log(`newest c0_0 chunk=${newest.name} state(12,-60,12)=${state} name=${cd.blockName(state)}`)
    } else {
      console.log('NO c0_0 CHUNK CAPTURE')
    }

    const lines = fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch (_) { return null }
    }).filter(Boolean)
    const itemSpawns = lines.filter((l) => l.name === 'spawn_entity' && l.data && l.data.type === 68)
    console.log('captured item spawn packets total=', itemSpawns.length)
    for (const spawn of itemSpawns.slice(-5)) {
      console.log('  item spawn uuid=', spawn.data.objectUUID, 'pos=', spawn.data.x, spawn.data.y, spawn.data.z)
    }
  } finally {
    rcon.close()
  }
}

main().catch((error) => {
  console.error('DIAGNOSE3 ERROR', error)
  process.exit(1)
})
