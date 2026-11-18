#!/usr/bin/env node
'use strict'
/**
 * Datapack generator for the BaseHider load-test harness.
 *
 * Writes D:/Basehider/itest/server/world/datapacks/bhload with:
 *   pack.mcmeta                                      (pack_format 57 = MC 1.21.4)
 *   data/bhload/function/summon_items.mcfunction     (N summon commands)
 *
 * The item field is a grid of dropped diamond items around the world-spawn
 * area of the flat itest world.  Each entity is:
 *   {NoGravity:1b,PickupDelay:32767s,Age:-32768s,Item:{id:"minecraft:diamond",count:1}}
 * NoGravity keeps it in the air, PickupDelay prevents pickup, negative Age
 * prevents despawn.
 *
 * Layout rules (deterministic, same count => identical file bytes):
 *   * x/z spacing is always in the required 0.5-1.5 block range.
 *   * small fields (<= 841 items) are one flat layer; spacing grows up to 1.5
 *     for tiny fields.
 *   * larger fields use multiple horizontal layers spaced 2 blocks apart in Y
 *     (starting at -59, i.e. above the flat ground at y=-61) so the x/z
 *     footprint stays within roughly +/-11 blocks of spawn.  Layer spacing of
 *     2 also keeps item entities from merging vertically.
 *   * one individual entity per command, reported layout is written to the
 *     result JSON so the test is reproducible.
 *
 * This file can be used standalone:
 *   node bench/gen-datapack.js --items 2000
 * or required from load-bench.js:
 *   const { generateDatapack } = require('./gen-datapack.js')
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_SERVER_DIR = 'D:/Basehider/itest/server'
const DATAPACK_NAME = 'bhload'
const PACK_FORMAT = 57 // Minecraft 1.21.4 data pack format
const FUNCTION_ID = 'bhload:summon_items'
const DEFAULT_BASE_Y = -59 // flat itest world: ground top y=-61, player feet y=-60
const TARGET_MAX_HALF_SPAN = 14 // flat fields stay within ~+/-14 blocks of spawn (x/z)
const MIN_SPACING = 0.5
const MAX_SPACING = 1.5
// Above this many items a single flat layer would need > 1.0 spacing within the
// spawn footprint, so switch to multiple horizontal layers.
const SINGLE_LAYER_LIMIT = 841 // 29 x 29 grid at spacing 1.0 within +/-14 blocks
const LAYER_MAX_ITEMS = 529 // 23 x 23 grid at spacing 1.0 -> +/-11 blocks
const LAYER_Y_STEP = 2 // keeps item entities from merging vertically

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Format a coordinate without exponent notation and without float noise. */
function fmt (value) {
  if (!Number.isFinite(value)) throw new Error(`non-finite coordinate: ${value}`)
  const rounded = Math.round(value * 1000) / 1000
  if (Number.isInteger(rounded)) return String(rounded)
  return String(rounded)
}

/**
 * Compute the grid layout for `count` items.
 * @returns {object} layout metadata (reported verbatim in the result JSON)
 */
function computeLayout (count, opts = {}) {
  const centerX = opts.centerX === undefined ? 0.5 : Number(opts.centerX)
  const centerZ = opts.centerZ === undefined ? 0.5 : Number(opts.centerZ)
  const baseY = opts.baseY === undefined ? DEFAULT_BASE_Y : Number(opts.baseY)
  const maxHalfSpan = opts.maxHalfSpan === undefined
    ? TARGET_MAX_HALF_SPAN
    : Number(opts.maxHalfSpan)

  let layers; let perLayer; let spacing
  if (count <= SINGLE_LAYER_LIMIT) {
    layers = 1
    perLayer = count
    const cols = Math.ceil(Math.sqrt(perLayer))
    const rows = Math.ceil(perLayer / cols)
    const spanDenominator = Math.max(1, Math.max(cols - 1, rows - 1))
    spacing = clamp((maxHalfSpan * 2) / spanDenominator, MIN_SPACING, MAX_SPACING)
  } else {
    layers = Math.ceil(count / LAYER_MAX_ITEMS)
    perLayer = Math.ceil(count / layers)
    spacing = 1.0
    const cols = Math.ceil(Math.sqrt(perLayer))
    const rows = Math.ceil(perLayer / cols)
    if (cols - 1 > maxHalfSpan * 2) {
      throw new Error(`layout overflow: ${count} items need ${cols} columns at spacing ${spacing}`)
    }
    void rows
  }

  const cols = Math.ceil(Math.sqrt(perLayer))
  const rows = Math.ceil(perLayer / cols)
  const spanX = (cols - 1) * spacing
  const spanZ = (rows - 1) * spacing
  const halfSpanX = spanX / 2
  const halfSpanZ = spanZ / 2
  const xMin = centerX - halfSpanX
  const xMax = centerX + halfSpanX
  const zMin = centerZ - halfSpanZ
  const zMax = centerZ + halfSpanZ
  const yMin = baseY
  const yMax = baseY + (layers - 1) * LAYER_Y_STEP

  // worst case distance from the field centre (centerX, y of the bottom layer,
  // centerZ) - vertical layers add vertical distance for the entity position.
  const maxDistanceFromCenter = Math.sqrt(
    Math.pow(Math.max(Math.abs(xMin - centerX), Math.abs(xMax - centerX)), 2) +
    Math.pow(Math.max(Math.abs(zMin - centerZ), Math.abs(zMax - centerZ)), 2) +
    Math.pow(yMax - yMin, 2)
  )

  return {
    cols,
    rows,
    layers,
    perLayer,
    spacing: Math.round(spacing * 10000) / 10000,
    layerYStep: layers > 1 ? LAYER_Y_STEP : 0,
    spanX: Math.round(spanX * 10000) / 10000,
    spanZ: Math.round(spanZ * 10000) / 10000,
    xMin: Math.round(xMin * 10000) / 10000,
    xMax: Math.round(xMax * 10000) / 10000,
    zMin: Math.round(zMin * 10000) / 10000,
    zMax: Math.round(zMax * 10000) / 10000,
    yMin,
    yMax,
    maxDistanceFromCenter: Math.round(maxDistanceFromCenter * 1000) / 1000,
    baseY,
    centerX,
    centerZ
  }
}

/** Build the .mcfunction command list (one summon per line). */
function buildSummonCommands (count, layout) {
  const lines = []
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / layout.perLayer)
    const slot = i % layout.perLayer
    const col = slot % layout.cols
    const row = Math.floor(slot / layout.cols)
    const x = layout.centerX + (col - (layout.cols - 1) / 2) * layout.spacing
    const z = layout.centerZ + (row - (layout.rows - 1) / 2) * layout.spacing
    const y = layout.baseY + layer * layout.layerYStep
    lines.push(
      `summon minecraft:item ${fmt(x)} ${fmt(y)} ${fmt(z)} ` +
      '{NoGravity:1b,PickupDelay:32767s,Age:-32768s,Item:{id:"minecraft:diamond",count:1}}'
    )
  }
  return lines
}

/**
 * Write the datapack.
 * @param {object} options
 * @param {number} options.count number of item entities
 * @param {string} [options.serverDir]
 * @param {string} [options.datapackName]
 * @param {number} [options.centerX]
 * @param {number} [options.centerZ]
 * @param {number} [options.baseY]
 * @param {number} [options.maxHalfSpan]
 * @returns {object} metadata about what was written
 */
function generateDatapack (options) {
  if (!options || !Number.isInteger(options.count) || options.count <= 0) {
    throw new Error('generateDatapack: options.count must be a positive integer')
  }
  const count = options.count
  const serverDir = options.serverDir || DEFAULT_SERVER_DIR
  const datapackName = options.datapackName || DATAPACK_NAME
  const worldDir = path.join(serverDir, 'world')
  const datapackDir = path.join(worldDir, 'datapacks', datapackName)

  fs.mkdirSync(worldDir, { recursive: true })
  fs.rmSync(datapackDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(datapackDir, 'data', 'bhload', 'function'), { recursive: true })

  const layout = computeLayout(count, options)
  const lines = buildSummonCommands(count, layout)
  const mcmeta = {
    pack: {
      pack_format: PACK_FORMAT,
      description: `BaseHider load test item field (${count} dropped items, generated by bench/gen-datapack.js)`
    }
  }
  const mcmetaPath = path.join(datapackDir, 'pack.mcmeta')
  const functionPath = path.join(datapackDir, 'data', 'bhload', 'function', 'summon_items.mcfunction')
  fs.writeFileSync(mcmetaPath, JSON.stringify(mcmeta, null, 2) + '\n', 'utf8')
  fs.writeFileSync(functionPath, lines.join('\n') + '\n', 'utf8')

  return {
    generatedAt: new Date().toISOString(),
    serverDir,
    worldDir,
    datapackDir,
    datapackName,
    packFormat: PACK_FORMAT,
    functionId: FUNCTION_ID,
    packMcmetaPath: mcmetaPath,
    functionPath,
    commandCount: lines.length,
    layout,
    sampleCommands: [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]]
  }
}

module.exports = {
  generateDatapack,
  computeLayout,
  buildSummonCommands,
  PACK_FORMAT,
  FUNCTION_ID,
  DATAPACK_NAME,
  DEFAULT_SERVER_DIR,
  DEFAULT_BASE_Y
}

// Standalone CLI: node bench/gen-datapack.js --items 2000 [--server-dir ...]
if (require.main === module) {
  const argv = process.argv.slice(2)
  const args = { items: 200, serverDir: DEFAULT_SERVER_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items' || argv[i] === '--count') args.items = parseInt(argv[++i], 10)
    else if (argv[i] === '--server-dir') args.serverDir = argv[++i]
    else if (argv[i] === '--y') args.baseY = Number(argv[++i])
    else if (argv[i] === '--center-x') args.centerX = Number(argv[++i])
    else if (argv[i] === '--center-z') args.centerZ = Number(argv[++i])
  }
  try {
    const info = generateDatapack({ count: args.items, serverDir: args.serverDir, baseY: args.baseY, centerX: args.centerX, centerZ: args.centerZ })
    process.stdout.write(JSON.stringify(info, null, 2) + '\n')
  } catch (error) {
    process.stderr.write('gen-datapack failed: ' + (error && error.stack ? error.stack : error) + '\n')
    process.exit(1)
  }
}
