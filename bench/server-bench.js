'use strict'
/* Real-server benchmark driver.
 *
 * Starts a headless capture bot (kept alive through a piped stdin), waits for spawn,
 * records BaseHider's own per-tick work (`/basehider diag`) and spark's server tick
 * report, then optionally spawns a dense dropped-item field and measures again.
 *
 * Usage:
 *   node bench/server-bench.js --label plugin-idle --items 0
 *   node bench/server-bench.js --label plugin-items300 --items 300
 *   node bench/server-bench.js --label baseline --items 0
 *
 * The Paper server itself must already be running on 127.0.0.1:25599 with RCON
 * 25598 (the itest server directory is reused). Plugin presence is whatever is in
 * itest/server/plugins.
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))

const BOT_DIR = 'D:/Basehider/itest/bot'
const CAPTURE = 'D:/Basehider/bench/bench-bot.ndjson'
const CHUNK_DIR = 'D:/Basehider/bench/bench-bot-chunks'
const RESULTS_DIR = 'D:/Basehider/bench'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

function parseArgs () {
  const args = { label: 'run', items: 0 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') args.label = argv[++i]
    else if (argv[i] === '--items') args.items = parseInt(argv[++i], 10)
  }
  return args
}

function parseBotReady (line) {
  try {
    const data = JSON.parse(line.slice(line.indexOf(' ')).trim())
    return data.position || null
  } catch (_) {
    return null
  }
}

function summarizeDiag (text) {
  const get = (re) => { const m = re.exec(text); return m ? m[1] : null }
  return {
    tickLastUs: get(/Tick last\/avg\/max: (\d+)/),
    tickAvgUs: get(/Tick last\/avg\/max: \d+ \/ (\d+)/),
    tickMaxUs: get(/Tick last\/avg\/max: \d+ \/ \d+ \/ (\d+)/),
    overruns: get(/overruns: (\d+)/),
    raycasts: get(/Raycasts: (\d+)/),
    trackedItems: get(/tracked=(\d+)/),
    itemEvals: null,
    gatewaySanitized: get(/chunkSanitized=(\d+)/),
    errors: get(/Errors\/config warnings: (\d+)/)
  }
}

function summarizeSpark (text) {
  return strip(text).trim()
}

async function main () {
  const args = parseArgs()
  const startedAt = new Date().toISOString()
  fs.rmSync(CAPTURE, { force: true })
  fs.rmSync(CHUNK_DIR, { recursive: true, force: true })

  const bot = spawn(process.execPath, [
    path.join(BOT_DIR, 'capture-bot.js'),
    '--username', 'BenchBot',
    '--host', '127.0.0.1',
    '--port', '25599',
    '--out', CAPTURE,
    '--chunk-dir', CHUNK_DIR,
    '--max-ms', '900000'
  ], { cwd: BOT_DIR, stdio: ['pipe', 'pipe', 'pipe'] })

  let botPosition = null
  bot.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line.startsWith('BOT_READY')) {
        botPosition = parseBotReady(line)
      }
    }
  })
  bot.stderr.on('data', () => {})

  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 30000 })
  await rcon.connect()
  const cmd = async (command) => strip(await rcon.cmd(command)).trim()
  const diag = async () => {
    const text = await cmd('basehider diag')
    return text.includes('BaseHider') ? summarizeDiag(text) : { unavailable: true }
  }

  const result = {
    label: args.label,
    startedAt,
    botPosition: null,
    pluginPresent: false,
    idle: {},
    items: {},
    spark: {},
    notes: []
  }

  try {
    const deadline = Date.now() + 60000
    while (!botPosition && Date.now() < deadline) await sleep(200)
    if (!botPosition) throw new Error('bench bot did not spawn')
    result.botPosition = botPosition
    await sleep(5000)

    result.pluginPresent = !(await cmd('basehider diag')).includes('Unknown command')
    result.idle.diag = await diag()
    result.spark.idle = summarizeSpark(await cmd('spark tps'))

    if (args.items > 0) {
      await cmd('kill @e[type=minecraft:item]')
      const baseX = Math.round(botPosition.x)
      const baseY = Math.round(botPosition.y) + 1
      const baseZ = Math.round(botPosition.z)
      let spawned = 0
      for (let i = 0; i < args.items; i++) {
        const dx = (i % 15) - 7
        const dz = 3 + Math.floor(i / 15) % 14
        const command = `summon minecraft:item ${baseX + dx + 0.5} ${baseY} ${baseZ + dz + 0.5} `
          + `{NoGravity:1b,PickupDelay:32767s,Age:-32768s,Item:{id:"minecraft:diamond",count:1}}`
        const response = await cmd(command)
        if (/Summoned/.test(response)) spawned++
      }
      result.notes.push(`spawnedItems=${spawned}`)
      await sleep(8000)
      result.items.diag = await diag()
      result.spark.items = summarizeSpark(await cmd('spark tps'))
      await cmd('kill @e[type=minecraft:item]')
    }

    result.finishedAt = new Date().toISOString()
    const outPath = path.join(RESULTS_DIR, `result-${args.label}.json`)
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    console.log(`RESULT FILE ${outPath}`)
  } finally {
    try { bot.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch (_) {}
    await sleep(400)
    try { bot.kill() } catch (_) {}
    rcon.close()
  }
}

main().catch((error) => {
  console.error('BENCH ERROR', error)
  process.exit(1)
})
