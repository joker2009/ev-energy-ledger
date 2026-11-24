const assert = require('assert')
const {
  parseJsonObject,
  normalizeOrderFields,
  detectImageMime
} = require('../cloudfunctions/ledger/lib/order')

const TODAY = '2026-11-24'

const parsed = parseJsonObject(
  '```json\n{"date":"2026/01/05","time":"9:05:30","odometer":"12,000 km","chargeKwh":"40.1234 度","chargeFee":"¥30.5","socStart":"20%","socEnd":"100%","chargeType":"fast","station":"测试充电站","note":"测试备注"}\n```'
)
const fields = normalizeOrderFields(parsed, TODAY)
assert.deepStrictEqual(fields, {
  date: '2026-01-05',
  time: '09:05',
  odometer: 12000,
  chargeKwh: 40.123,
  chargeFee: 30.5,
  socStart: 20,
  socEnd: 100,
  chargeType: 'fast',
  station: '测试充电站',
  note: '测试备注'
})

const invalid = normalizeOrderFields(
  {
    date: '2030-01-01',
    odometer: -1,
    chargeKwh: 0,
    chargeFee: -1,
    socStart: 50,
    socEnd: 40,
    chargeType: 'unknown'
  },
  TODAY
)
assert.deepStrictEqual(invalid, {})

assert.strictEqual(parseJsonObject('no json'), null)
assert.strictEqual(parseJsonObject('```\n{"ok":true}\n```').ok, true)
assert.strictEqual(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png')
assert.strictEqual(detectImageMime(Buffer.from('GIF89a')), 'image/gif')
assert.strictEqual(detectImageMime(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg')

console.log('ORDER PARSE TESTS PASSED')
