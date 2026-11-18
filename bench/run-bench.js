'use strict'
/* End-to-end benchmark orchestrator for BaseHider on real Paper 1.21.4.
 *
 * For each mode it (re)starts the itest Paper server with or without the plugin jar,
 * connects a headless bot, measures:
 *   - spark `/spark tps` server tick report
 *   - BaseHider's own per-tick work from `/basehider diag`
 *   - optionally spawns a dense dropped-item field to measure ItemShield cost
 * then stops the server and continues with the next mode.
 *
 * Usage: node bench/run-bench.js
 * Output: bench/bench-results.json + console table.
 */
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn, execSync } = require('child_process')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))

const JAVA = 'C:/Users/audim_r0h5i/.jdks/jdk-21.0.13+9/bin/java.exe'
const NODE = process.execPath
const SERVER_DIR = 'D:/Basehider/itest/server'
const BOT_DIR = 'D:/Basehider/itest/bot'
const PLUGIN_JAR = 'D:/Basehider/dist/BaseHider-3.1.0.jar'
const SERVER_PLUGIN = path.join(SERVER_DIR, 'plugins/BaseHider.jar')
const BENCH_DIR = 'D:/Basehider/bench'
const BOT_CAPTURE = path.join(BENCH_DIR, 'bench-bot.ndjson')
const BOT_CHUNKS = path.join(BENCH_DIR, 'bench-bot-chunks')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readLogTail = (logPath) => {
  try {
    const content = fs.readFileSync(logPath, 'utf8')
    return content.slice(Math.max(0, content.length - 60000))
  } catch (_) {
    return ''
  }
}
const refreshSpark = async (cmd, logPath) => {
  await cmd('spark tps')
  await sleep(2000)
  const block = lastSparkBlock(readLogTail(logPath))
  if (block) return block
  // fallback: last 25 lines around the command are still useful evidence
  return readLogTail(logPath).split('\\n').filter((line) => /tps|tick|mspt|spark/i.test(line)).slice(-25).join('\\n')
}
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

const MODES = [
  { label: 'A-baseline-disabled', plugin: false, items: 0 },
  { label: 'B-plugin-idle', plugin: true, items: 0 },
  { label: 'C-plugin-items300', plugin: true, items: 300 },
  { label: 'D-plugin-items800', plugin: true, items: 800 }
]

function portFree (port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function waitForPortFree (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(port)) return true
    await sleep(500)
  }
  return false
}

function killLastJava () {
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='java.exe'\\" | Where-Object { $_.CommandLine -like '*paper-1.21.4.jar*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' })
  } catch (_) {}
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*capture-bot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' })
  } catch (_) {}
}

function summarizeSpark (text) {
  return strip(text).trim()
}

function lastSparkBlock (content) {
  const index = content.lastIndexOf('Tick durations')
  if (index < 0) {
    return ''
  }
  const start = Math.max(0, content.lastIndexOf('TPS', index))
  return content.slice(start, index + 400)
}

function summarizeDiag (text) {
  const get = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null }
  return {
    tickLastUs: get(/Tick last\/avg\/max: (\d+)/),
    tickAvgUs: get(/Tick last\/avg\/max: \d+ \/ (\d+)/),
    tickMaxUs: get(/Tick last\/avg\/max: \d+ \/ \d+ \/ (\d+)/),
    overruns: get(/overruns: (\d+)/),
    raycasts: get(/Raycasts: (\d+)/),
    trackedItems: get(/tracked=(\d+)/),
    itemEvaluations: null,
    chunkSanitized: get(/chunkSanitized=(\d+)/),
    errors: get(/Errors\/config warnings: (\d+)/)
  }
}

function parseSparkTps (text) {
  const tps = /TPS:?\s*([0-9.]+)/i.exec(text)
  const mspt = /(?:MSPT|Tick durations|Average tick time)[^0-9]*([0-9.]+)/i.exec(text)
  return { raw: strip(text).trim(), tps: tps ? Number(tps[1]) : null, mspt: mspt ? Number(mspt[1]) : null }
}

async function startServer (logPath) {
  if (!(await waitForPortFree(25599, 10000)) || !(await waitForPortFree(25598, 10000))) {
    throw new Error('ports 25598/25599 are still in use; refusing to start')
  }
  fs.rmSync(logPath, { force: true })
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(JAVA, ['-Xms512M', '-Xmx1536M', '-jar', 'paper-1.21.4.jar', '--nogui'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  })
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8')
      if (content.includes('Done (')) {
        fs.closeSync(logFd)
        return { child, logPath }
      }
      if (/Exception|Error: Could not|Failed to start/.test(content.slice(-4000)) && content.includes('Could not load')) {
        break
      }
    }
    await sleep(1000)
  }
  try { child.kill() } catch (_) {}
  throw new Error('server did not reach Done() within timeout; see ' + logPath)
}

async function stopServer (child, rcon) {
  try {
    if (rcon) await rcon.cmd('stop')
  } catch (_) {}
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true
    await sleep(500)
  }
  try { child.kill() } catch (_) {}
  return false
}

async function measureMode (mode) {
  killLastJava()
  await sleep(2000)
  // plugin jar presence
  fs.rmSync(SERVER_PLUGIN, { force: true })
  if (mode.plugin) fs.copyFileSync(PLUGIN_JAR, SERVER_PLUGIN)
  const logPath = path.join(BENCH_DIR, `bench-server-${mode.label}.log`)
  const server = await startServer(logPath)

  fs.rmSync(BOT_CAPTURE, { force: true })
  fs.rmSync(BOT_CHUNKS, { recursive: true, force: true })
  const bot = spawn(NODE, [
    path.join(BOT_DIR, 'capture-bot.js'), '--username', 'BenchBot', '--host', '127.0.0.1',
    '--port', '25599', '--out', BOT_CAPTURE, '--chunk-dir', BOT_CHUNKS, '--max-ms', '900000'
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
  const result = { label: mode.label, mode, botPosition: null, idle: {}, items: {}, spark: {}, plugin: {} }

  try {
    const deadline = Date.now() + 60000
    while (!botPosition && Date.now() < deadline) await sleep(200)
    if (!botPosition) throw new Error('bench bot did not spawn')
    result.botPosition = botPosition
    await sleep(6000)

    result.plugin.installed = mode.plugin
    if (mode.plugin) {
      const diagText = await cmd('basehider diag')
      result.plugin.diag = summarizeDiag(diagText)
      result.plugin.diagRaw = strip(diagText)
    }
    result.idle.spark = parseSparkTps(await refreshSpark(cmd, logPath))

    if (mode.items > 0) {
      await cmd('kill @e[type=minecraft:item]')
      const baseX = Math.round(botPosition.x)
      const baseY = Math.round(botPosition.y) + 1
      const baseZ = Math.round(botPosition.z)
      let spawned = 0
      for (let i = 0; i < mode.items; i++) {
        const dx = (i % 20) - 10
        const dz = 3 + Math.floor(i / 20) % 16
        const response = await cmd(`summon minecraft:item ${baseX + dx + 0.5} ${baseY} `
          + `${baseZ + dz + 0.5} {NoGravity:1b,PickupDelay:32767s,Age:-32768s,`
          + 'Item:{id:"minecraft:diamond",count:1}}')
        if (/Summoned/.test(response)) spawned++
      }
      result.items.spawned = spawned
      await sleep(10000)
      const itemDiag = await cmd('basehider diag')
      if (mode.plugin) result.items.diag = summarizeDiag(itemDiag)
      result.items.spark = parseSparkTps(await refreshSpark(cmd, logPath))
      await cmd('kill @e[type=minecraft:item]')
    }
    return result
  } finally {
    try { bot.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch (_) {}
    await sleep(300)
    try { bot.kill() } catch (_) {}
    await stopServer(server.child, rcon)
    try { rcon.close() } catch (_) {}
    killLastJava()
    await sleep(1500)
  }
}

async function main () {
  // make sure nothing from an earlier run is alive
  killLastJava()
  await sleep(1500)
  const results = []
  for (const mode of MODES) {
    const previous = fs.existsSync(SERVER_PLUGIN)
      ? fs.readFileSync(SERVER_PLUGIN)
      : null
    try {
      console.log(`\n=== BENCH MODE ${mode.label} ===`)
      const result = await measureMode(mode)
      results.push(result)
      console.log(JSON.stringify(result, null, 2))
    } catch (error) {
      results.push({ label: mode.label, error: String(error && error.message ? error.message : error) })
      console.error(`MODE ${mode.label} FAILED:`, error)
    } finally {
      // leave the server dir clean for the integration harness (default: no plugin jar)
      fs.rmSync(SERVER_PLUGIN, { force: true })
      if (previous) {
        // do not restore; the itest harness installs its own jar when run
      }
    }
  }
  const outPath = path.join(BENCH_DIR, 'bench-results.json')
  fs.writeFileSync(outPath, JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2))
  console.log(`\nBENCH RESULTS ${outPath}`)
  console.table(results.map((r) => ({
    label: r.label,
    plugin: r.plugin && r.plugin.installed,
    idleSpark: r.idle && r.idle.spark ? r.idle.spark.raw.split('\n')[0] : r.error || '',
    pluginTickAvgUs: r.plugin && r.plugin.diag ? r.plugin.diag.tickAvgUs : '',
    pluginTickMaxUs: r.plugin && r.plugin.diag ? r.plugin.diag.tickMaxUs : '',
    itemsTracked: r.items && r.items.diag ? r.items.diag.trackedItems : '',
    itemsTickAvgUs: r.items && r.items.diag ? r.items.diag.tickAvgUs : ''
  })))
}

main().catch((error) => {
  console.error('BENCH ORCHESTRATOR ERROR', error)
  process.exit(1)
})
