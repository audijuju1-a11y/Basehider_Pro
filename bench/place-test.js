'use strict'
/* Places a chest with a real player action (creative block_place via the harness
 * capture bot), then checks whether BaseHider indexed it and sanitized the chunk
 * packet on a forced resend.
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))
const cd = require(path.join('D:/Basehider/itest/bot/lib/chunk-decoder.js'))

const NODE = process.execPath
const BOT_DIR = 'D:/Basehider/itest/bot'
const OUT = 'D:/Basehider/bench/PlaceBot.ndjson'
const CHUNK_DIR = 'D:/Basehider/bench/PlaceBot-chunks'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

const CHEST_X = 12
const CHEST_Y = -60
const CHEST_Z = 12
const CLICK = { x: 12, y: -61, z: 12, face: 1 } // top face of the floor block

async function main () {
  const bot = spawn(NODE, [
    path.join(BOT_DIR, 'capture-bot.js'),
    '--username', 'PlaceBot',
    '--host', '127.0.0.1',
    '--port', '25599',
    '--out', OUT,
    '--chunk-dir', CHUNK_DIR,
    '--max-ms', '600000'
  ], { cwd: BOT_DIR, stdio: ['pipe', 'pipe', 'pipe'] })

  const botLines = []
  let ready = false
  let placed = null
  bot.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (!line.trim()) continue
      botLines.push(line)
      if (line.startsWith('BOT_READY')) ready = true
      if (line.startsWith('BOT_PLACED')) placed = line
      console.log('[bot] ' + line.trim())
    }
  })
  bot.stderr.on('data', (data) => process.stderr.write('[bot-err] ' + data.toString()))

  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 15000 })
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
      sanitized: Number(/chunkSanitized=(\d+)/.exec(text)?.[1])
    }
  }

  try {
    const deadline = Date.now() + 30000
    while (!ready && Date.now() < deadline) await sleep(200)
    if (!ready) throw new Error('bot did not become ready')
    await sleep(500)

    await cmd('kill @e[type=minecraft:item]')
    await cmd('fill 10 -60 10 14 -58 14 minecraft:air')
    await cmd('fill 10 -61 10 14 -61 14 minecraft:stone')
    await cmd('tp PlaceBot 12.5 -60 14.5 180 0')
    await cmd('gamemode creative PlaceBot')
    await sleep(800)
    const before = await diag()
    console.log('before place blocks=', before.blocks, 'chunks=', before.chunks)

    bot.stdin.write(JSON.stringify({
      cmd: 'place', block: 'chest', x: CLICK.x, y: CLICK.y, z: CLICK.z, face: CLICK.face,
      cursorX: 0.5, cursorY: 1.0, cursorZ: 0.5
    }) + '\n')
    await sleep(1500)
    await cmd(`data get block ${CHEST_X} ${CHEST_Y} ${CHEST_Z}`)
    const after = await diag()
    console.log('after player place blocks=', after.blocks, 'chunks=', after.chunks, 'indexRevision=',
      /indexRevision=(\d+)/.exec(after.text)?.[1])

    // force chunk resend
    await cmd('tp PlaceBot 1012.5 -60 1014.5 180 0')
    await sleep(1500)
    await cmd('tp PlaceBot 12.5 -60 14.5 180 0')
    await sleep(2500)
    const afterResend = await diag()
    console.log('after resend blocks=', afterResend.blocks, 'sanitized=', afterResend.sanitized)

    const files = fs.readdirSync(CHUNK_DIR)
      .filter((name) => /c0_0\.bin$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(CHUNK_DIR, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
    const newest = files[files.length - 1]
    if (!newest) {
      console.log('NO c0_0 CHUNK CAPTURE')
    } else {
      const decoded = cd.decodeChunkData(fs.readFileSync(path.join(CHUNK_DIR, newest.name)))
      const state = cd.getBlockState(decoded, CHEST_X, CHEST_Y, CHEST_Z)
      console.log(`newest chunk=${newest.name} state(${CHEST_X},${CHEST_Y},${CHEST_Z})=${state} name=${cd.blockName(state)}`)
    }
  } finally {
    try { bot.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch (_) {}
    await sleep(300)
    try { bot.kill() } catch (_) {}
    rcon.close()
  }
}

main().catch((error) => {
  console.error('PLACE-TEST ERROR', error)
  process.exit(1)
})
