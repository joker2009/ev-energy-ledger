const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(
  __dirname,
  '..',
  'miniprogram',
  'miniprogram_npm',
  'tdesign-miniprogram'
)

// 只保留页面实际用到的组件及其依赖。重新 build-npm 后需要再执行一次。
const KEEP = new Set([
  'button',
  'input',
  'textarea',
  'radio-group',
  'radio',
  'date-time-picker',
  'picker',
  'picker-item',
  'popup',
  'overlay',
  'swipe-cell',
  'icon',
  'loading',
  'common',
  'locale',
  'mixins',
  'config-provider'
])

const NESTED_KEEP = new Set(['dayjs', 'tslib'])

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch (err) {
    return false
  }
}

function dirSize(target) {
  let total = 0
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

if (!isDirectory(ROOT)) {
  console.error('未找到 miniprogram_npm，请先在开发者工具执行 build-npm')
  process.exit(1)
}

let removed = 0

for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name)
  if (!isDirectory(full) || name === 'miniprogram_npm') continue
  if (KEEP.has(name)) continue
  removed += dirSize(full)
  fs.rmSync(full, { recursive: true, force: true })
  console.log(`removed ${name}`)
}

const nested = path.join(ROOT, 'miniprogram_npm')
if (isDirectory(nested)) {
  for (const name of fs.readdirSync(nested)) {
    const full = path.join(nested, name)
    if (!isDirectory(full) || NESTED_KEEP.has(name)) continue
    removed += dirSize(full)
    fs.rmSync(full, { recursive: true, force: true })
    console.log(`removed nested ${name}`)
  }
}

const remaining = dirSize(ROOT)
console.log(
  `TDesign pruned: removed ${(removed / 1048576).toFixed(2)} MB, remaining ${(remaining / 1048576).toFixed(2)} MB`
)
