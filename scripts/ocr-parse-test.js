const assert = require('assert')
const { extractMileageCandidates } = require('../cloudfunctions/ledger/lib/ocr')

const values = (items) => extractMileageCandidates(items).map((item) => item.value)

assert.strictEqual(values([{ text: 'ODO' }, { text: '54321' }, { text: 'km' }])[0], 54321)
assert.ok(values([{ text: '总里程 12345 km' }]).includes(12345))
assert.ok(values([{ text: '123456' }]).includes(123456))
assert.deepStrictEqual(values([{ text: '100%' }, { text: '420 km' }, { text: '120' }]), [])
assert.deepStrictEqual(values([{ text: '12:34' }]), [])
assert.deepStrictEqual(values([{ text: 'ODO 54321 km' }, { text: '54321' }]), [54321])

const many = []
for (let i = 10000; i < 10010; i += 1) many.push({ text: String(i) })
assert.ok(extractMileageCandidates(many).length <= 6)

console.log('OCR PARSE TESTS PASSED')
