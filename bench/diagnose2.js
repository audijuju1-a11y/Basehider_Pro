'use strict'
const fs = require('fs')
const path = require('path')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))
const cd = require(path.join('D:/Basehider/itest/bot/lib/chunk-decoder.js'))

const CAPTURE = 'D:/Basehider/bench/ProbeBot.ndjson'
const CHUNK_DIR = 'D:/Basehider/bench/ProbeBot-chunks'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

async function main () {
  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 15000 })
  await rcon.connect()
  const cmd = async (command) => {
    const response = strip(await rcon.cmd(command)).trim()
    console.log(`CMD ${command}\n${response}`)
    return response
  }
  const diag = async () => {
    const text = await cmd('basehider diag')
    const blocks = /blocks=(\d+)/.exec(text)?.[1]
    const chunks = /chunks=(\d+)/.exec(text)?.[1]
    const sanitized = /chunkSanitized=(\d+)/.exec(text)?.[1]
    const tracked = /tracked=(\d+)/.exec(text)?.[1]
    return { blocks: Number(blocks), chunks: Number(chunks), sanitized: Number(sanitized), tracked: Number(tracked), text }
  }

  try {
    await cmd('basehider verify')
    console.log('initial', await diag())

    // placed by console: no BlockPlaceEvent; discovery/reconciliation path only
    await cmd('fill 10 -60 10 14 -58 14 minecraft:air')
    await cmd('fill 10 -61 10 14 -61 14 minecraft:stone')
    await cmd('setblock 12 -60 12 minecraft:chest')
    let state
    for (let i = 0; i < 25; i++) {
      await sleep(1000)
      state = await diag()
      if (state.blocks > 0) break
    }
    console.log('after reconcile wait, blocks=', state.blocks, 'chunks=', state.chunks)

    // teleport away and back -> full chunk resend
    await cmd('tp ProbeBot 1012.5 -60 1014.5 180 0')
    await sleep(1500)
    await cmd('tp ProbeBot 12.5 -60 14.5 180 0')
    await sleep(2500)
    const after = await diag()
    console.log('after resend, blocks=', after.blocks, 'sanitizedChunkPackets=', after.sanitized, 'trackedItems=', after.tracked)

    // Decode newest captured chunk for chunk (0,0) and check the chest position.
    const files = fs.readdirSync(CHUNK_DIR)
      .filter((name) => /c0_0\.bin$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(CHUNK_DIR, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
    const newest = files[files.length - 1]
    if (!newest) {
      console.log('NO CHUNK CAPTURE for 0,0')
      return
    }
    const decoded = cd.decodeChunkData(fs.readFileSync(path.join(CHUNK_DIR, newest.name)))
    const s = cd.getBlockState(decoded, 12, -60, 12)
    console.log(`newest c0_0 chunk=${newest.name} state(12,-60,12)=${s} name=${cd.blockName(s)}`)

    // item registration check (console summon is an EntitySpawnEvent path for items)
    await cmd('kill @e[type=minecraft:item]')
    await cmd('summon minecraft:item 10.5 -59 10.5 {NoGravity:1b,PickupDelay:32767s,Item:{id:"minecraft:diamond",count:1}}')
    await sleep(700)
    const itemState = await diag()
    console.log('after summon, trackedItems=', itemState.tracked)

    const lines = fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch (_) { return null }
    }).filter(Boolean)
    const itemSpawns = lines.filter((l) => l.name === 'spawn_entity' && l.data && l.data.type === 68)
    console.log('captured item spawn packets:', itemSpawns.length)
    for (const spawn of itemSpawns.slice(-5)) {
      console.log('  item spawn uuid=', spawn.data.objectUUID, 'pos=', spawn.data.x, spawn.data.y, spawn.data.z)
    }
  } finally {
    rcon.close()
  }
}

main().catch((error) => {
  console.error('DIAGNOSE2 ERROR', error)
  process.exit(1)
})
