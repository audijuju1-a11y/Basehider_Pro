'use strict'
const path = require('path')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const strip = (s) => (s || '').replace(/§[0-9a-fklmnor]/gi, '')

async function main () {
  const rcon = new Rcon({ host: '127.0.0.1', port: 25598, password: 'itest-rcon-pass', timeoutMs: 45000 })
  await rcon.connect()
  try {
    const commands = process.argv.slice(2)
    for (const command of commands) {
      const started = Date.now()
      try {
        const response = await rcon.cmd(command)
        console.log(`\nCMD ${command} (${Date.now() - started} ms)`)
        console.log(strip(response).trim())
      } catch (error) {
        console.log(`\nCMD ${command} (${Date.now() - started} ms) ERROR ${error.message}`)
      }
    }
  } finally {
    rcon.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
