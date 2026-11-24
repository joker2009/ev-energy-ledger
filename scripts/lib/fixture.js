const XLSX = require('xlsx')

const FIXTURE_MONTH = '2026-01'

const FIXTURE_ROWS = [
  ['测试 - 充电数据'],
  [
    '充电时间',
    '总里程(公里)',
    '充电前电量(%)',
    '充电后电量(%)',
    '充电度数(度)',
    '车端电量(度)',
    '充电金额(元)',
    '电费单价(元/度)',
    '备注'
  ],
  ['2026-01-05 09:30', '12000', '20', '100', '40.123', '0', '30.5', '0.7602', '测试充电站 A'],
  ['2026-01-12 18:10', '12350', '30', '90', '30.5', '0', '20', '0.6557', '家充测试'],
  ['2026-01-20 07:45', '12600', '10', '100', '35', '0', '25', '0.7143', '']
]

function buildFixtureBase64() {
  const sheet = XLSX.utils.aoa_to_sheet(FIXTURE_ROWS)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '充电数据')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  return buffer.toString('base64')
}

module.exports = { buildFixtureBase64, FIXTURE_MONTH }
