const fs = require('fs')
const cd = require('D:/Basehider/itest/bot/lib/chunk-decoder.js')
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file)
  const decoded = cd.decodeChunkData(buf)
  const state = cd.getBlockState(decoded, 12, -60, 12)
  console.log(file.split('\\').pop(), 'sections=', decoded.sectionCount, 'state(12,-60,12)=', state, cd.blockName(state))
  // also count chest states in all sections
  let chestCount = 0
  const range = cd.stateRange('chest')
  for (let i = 0; i < decoded.sectionCount; i++) {
    const section = decoded.sections[i]
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const s = cd.getBlockState(decoded, x, i * 16 + cd.MIN_Y + y, z)
      if (cd.stateMatches(s, range)) chestCount++
    }
  }
  console.log('  chest states in whole chunk=', chestCount)
}
