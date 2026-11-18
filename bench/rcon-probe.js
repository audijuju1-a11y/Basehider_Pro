'use strict'
/* Manual diagnostic client: connects to the itest Paper server over RCON and runs
 * commands, printing the response. Usage:
 *   node bench/rcon-probe.js "command 1" "command 2" ...
 */
const path = require('path')
const { Rcon } = require(path.join('D:/Basehider/itest/bot/lib/rcon.js'))

const password = process.env.ITEST_RCON_PASS || 'itest-rcon-pass'
const port = parseInt(process.env.ITEST_RCON_PORT || '25598', 10)

async function main () {
  const rcon = new Rcon({ host: '127.0.0.1', port, password, timeoutMs: 20000 })
  await rcon.connect()
  try {
    for (const command of process.argv.slice(2)) {
      const started = Date.now()
      const response = await rcon.cmd(command)
      console.log(`CMD ${JSON.stringify(command)} (${Date.now() - started}ms)`)
      console.log(response)
      console.log('---')
    }
  } finally {
    rcon.close()
  }
}

main().catch((error) => {
  console.error('PROBE ERROR', error)
  process.exit(1)
})
