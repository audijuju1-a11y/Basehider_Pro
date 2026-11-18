'use strict'
/* Orchestrates one ViaVersion capture test:
 * - starts via-test-bot.js with a given client version
 * - waits for BOT_READY, summons hidden entities at fixed offsets via RCON
 * - waits, prints the bot's entity packet summary, quits the bot
 * Usage: node via-test-run.js <clientVersion> <label>
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Rcon } = require(path.join(__dirname, '..', 'itest', 'bot', 'lib', 'rcon.js'))

const nodeExec = process.execPath
const label = process.argv[3] || ('client-' + (process.argv[2] || '1.21.4'))
const clientVersion = process.argv[2] || '1.21.4'
const outFile = path.join(__dirname, 'via-test-' + label + '.ndjson')
const logFile = path.join(__dirname, 'via-test-' + label + '.log')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main () {
  const bot = spawn(nodeExec, [path.join(__dirname, 'via-test-bot.js'), clientVersion, outFile, 'ViaTest'], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  bot.stdout.on('data', (data) => {
    out += data.toString()
    process.stdout.write(data)
  })
  bot.stderr.on('data', (data) => process.stderr.write(data))

  const deadline = Date.now() + 120000
  while (!out.includes('BOT_READY') && Date.now() < deadline) {
    await sleep(500)
  }
  if (!out.includes('BOT_READY')) {
    console.error('BOT NOT READY')
    bot.kill()
    process.exit(1)
  }

  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 20000 })
  await rcon.connect()
  const cmd = async (command) => {
    try { return (await rcon.cmd(command)).trim() } catch (error) { return 'ERR ' + error.message }
  }
  console.log('placing chest in front of the bot for reveal test...')
  console.log(await cmd('execute at ViaTest run setblock ^ ^1 ^3 minecraft:chest'))
  await sleep(8000)
  console.log(await cmd('basehider diag'))
  console.log(await cmd('basehider viewer ViaTest'))
  console.log('summoning hidden entities around the bot...')
  console.log(await cmd('execute at ViaTest run summon minecraft:zombie ~30 ~ ~'))
  console.log(await cmd('execute at ViaTest run summon minecraft:item ~30 ~ ~ {Item:{id:"minecraft:diamond",count:1},PickupDelay:32767s,NoGravity:1b}'))
  console.log(await cmd('execute at ViaTest run summon minecraft:armor_stand ~-30 ~ ~'))
  console.log(await cmd('execute at ViaTest run summon minecraft:chest_minecart ~ ~ ~-30'))
  await cmd('basehider status')
  await cmd('basehider diag')
  await sleep(6000)
  bot.stdin.write('status\n')
  await sleep(1500)
  bot.stdin.write('quit\n')
  await sleep(1500)
  try { bot.kill() } catch (_) {}
  rcon.close()
  fs.writeFileSync(logFile, out)
  console.log('CAPTURE ' + outFile)
}

main().catch((error) => {
  console.error('RUN ERROR', error)
  process.exit(1)
})
