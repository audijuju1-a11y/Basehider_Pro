'use strict'
/* MSPT benchmark using Paper's built-in /mspt command (works from the console/RCON).
 *
 * Requires a Paper server already running on 127.0.0.1:25599 with RCON 25598.
 * Connects a headless bot (kept alive via piped stdin), samples idle server tick times
 * and BaseHider's own diag, optionally spawns a dense dropped-item field in front of the
 * bot and samples again.
 *
 * Usage: node bench/mspt-bench.js --label plugin-idle --items 0
 *        node bench/mspt-bench.js --label plugin-items300 --items 300
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))

const BOT_DIR = 'D:/Basehider/itest/bot'
const BENCH_DIR = 'D:/Basehider/bench'
const CAPTURE = path.join(BENCH_DIR, 'mspt-bot.ndjson')
const CHUNK_DIR = path.join(BENCH_DIR, 'mspt-bot-chunks')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

function parseArgs () {
  const args = { label: 'run', items: 0, warmupMs: 15000, sampleMs: 10000 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') args.label = argv[++i]
    else if (argv[i] === '--items') args.items = parseInt(argv[++i], 10)
    else if (argv[i] === '--warmup-ms') args.warmupMs = parseInt(argv[++i], 10)
  }
  return args
}

function parseMspt (text) {
  const clean = strip(text)
  // Two formats observed; capture the first line that contains three avg/min/max groups.
  const line = clean.split('\n').find((value) => /Server tick times|tick times/i.test(value))
    || clean.split('\n').find((value) => /[0-9]+\.[0-9]+\/[0-9]+\.[0-9]+\/[0-9]+\.[0-9]+/.test(value))
    || clean
  const groups = [...clean.matchAll(/([0-9]+\.[0-9]+)\/([0-9]+\.[0-9]+)\/([0-9]+\.[0-9]+)/g)]
  return {
    raw: clean.trim(),
    line: line.trim(),
    samples: groups.map((match) => ({ avg: Number(match[1]), min: Number(match[2]), max: Number(match[3]) }))
  }
}

function parseDiag (text) {
  const get = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null }
  return {
    raw: strip(text).trim(),
    tickLastUs: get(/Security tick last\/avg\/max: (\d+)/),
    tickAvgUs: get(/Security tick last\/avg\/max: \d+ \/ (\d+)/),
    tickMaxUs: get(/Security tick last\/avg\/max: \d+ \/ \d+ \/ (\d+)/),
    p50Us: get(/p50\/p95\/p99: (\d+)/),
    p95Us: get(/p50\/p95\/p99: \d+\/(\d+)/),
    p99Us: get(/p50\/p95\/p99: \d+\/\d+\/(\d+)/),
    itemDecisionMaxUs: get(/Engine time \(item\/block\) last: \d+\/\d+ us max: (\d+)/),
    blockDecisionMaxUs: get(/Engine time \(item\/block\) last: \d+\/\d+ us max: \d+\/(\d+)/),
    raycasts: get(/Raycasts: (\d+)/),
    raycastsDeferred: get(/deferred by budget: (\d+)/),
    trackedItems: get(/tracked=(\d+)/),
    itemEvals: get(/Item engine: .* evals=(\d+)/),
    blockEvals: get(/Block engine: .* evals=(\d+)/),
    chunkSanitized: get(/chunkSanitized=(\d+)/),
    chunkFailClosed: get(/chunkFailClosed=(\d+)/),
    packetDetectedBlocks: get(/packetDetectedBlocks=(\d+)/),
    errors: get(/Errors\/config warnings: (\d+)/),
    tickOverruns: get(/overruns: (\d+)/)
  }
}

async function main () {
  const args = parseArgs()
  fs.rmSync(CAPTURE, { force: true })
  fs.rmSync(CHUNK_DIR, { recursive: true, force: true })
  const bot = spawn(process.execPath, [
    path.join(BOT_DIR, 'capture-bot.js'), '--username', 'MsptBot', '--host', '127.0.0.1',
    '--port', '25599', '--out', CAPTURE, '--chunk-dir', CHUNK_DIR, '--max-ms', '900000'
  ], { cwd: BOT_DIR, stdio: ['pipe', 'pipe', 'pipe'] })
  let botPosition = null
  bot.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line.startsWith('BOT_READY')) {
        try { botPosition = JSON.parse(line.slice(line.indexOf(' ')).trim()).position } catch (_) {}
      }
    }
  })
  bot.stderr.on('data', () => {})

  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 30000 })
  await rcon.connect()
  const cmd = async (command) => strip(await rcon.cmd(command)).trim()
  const result = { label: args.label, items: args.items, startedAt: new Date().toISOString() }
  try {
    const deadline = Date.now() + 60000
    while (!botPosition && Date.now() < deadline) await sleep(200)
    if (!botPosition) throw new Error('bot did not spawn')
    result.botPosition = botPosition
    result.pluginPresent = !(await cmd('basehider diag')).includes('Unknown or incomplete')

    await sleep(args.warmupMs)
    result.idle = {
      mspt1: parseMspt(await cmd('mspt')),
      mspt2: parseMspt(await cmd('mspt')),
      diag: result.pluginPresent ? parseDiag(await cmd('basehider diag')) : null
    }

    if (args.items > 0) {
      await cmd('kill @e[type=minecraft:item]')
      const baseX = Math.round(botPosition.x)
      const baseY = Math.round(botPosition.y) + 1
      const baseZ = Math.round(botPosition.z)
      let spawned = 0
      for (let i = 0; i < args.items; i++) {
        const dx = (i % 20) - 10
        const dz = 3 + Math.floor(i / 20) % 16
        const response = await cmd(`summon minecraft:item ${baseX + dx + 0.5} ${baseY} `
          + `${baseZ + dz + 0.5} {NoGravity:1b,PickupDelay:32767s,Age:-32768s,`
          + 'Item:{id:"minecraft:diamond",count:1}}')
        if (/Summoned/.test(response)) spawned++
      }
      result.itemsSpawned = spawned
      await sleep(12000)
      result.loaded = {
        mspt1: parseMspt(await cmd('mspt')),
        mspt2: parseMspt(await cmd('mspt')),
        diag: result.pluginPresent ? parseDiag(await cmd('basehider diag')) : null
      }
      await cmd('kill @e[type=minecraft:item]')
    }

    result.finishedAt = new Date().toISOString()
    const out = path.join(BENCH_DIR, `mspt-${args.label}.json`)
    fs.writeFileSync(out, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    console.log('RESULT ' + out)
  } finally {
    try { bot.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch (_) {}
    await sleep(400)
    try { bot.kill() } catch (_) {}
    rcon.close()
  }
}

main().catch((error) => {
  console.error('MSPT BENCH ERROR', error)
  process.exit(1)
})
