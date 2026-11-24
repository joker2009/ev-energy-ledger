const fs = require('fs')
const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')
const { buildFixtureBase64, FIXTURE_MONTH } = require('./lib/fixture')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const CUSTOM_SAMPLE_PATH = process.argv[2]
const IMPORT_BATCH = `SMOKE-IMPORT-${Date.now()}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callCloud(miniProgram, action, payload = {}) {
  return miniProgram.evaluate(
    async function (actionName, actionPayload) {
      const res = await wx.cloud.callFunction({
        name: 'ledger',
        data: { action: actionName, payload: actionPayload }
      })
      return res.result
    },
    action,
    payload
  )
}

function assertOk(result, label) {
  assert.ok(result && result.code === 0, `${label} 失败: ${JSON.stringify(result)}`)
  return result.data
}

async function main() {
  if (CUSTOM_SAMPLE_PATH && !fs.existsSync(CUSTOM_SAMPLE_PATH)) {
    throw new Error(`找不到样本文件: ${CUSTOM_SAMPLE_PATH}`)
  }

  const fileBase64 = CUSTOM_SAMPLE_PATH
    ? fs.readFileSync(CUSTOM_SAMPLE_PATH).toString('base64')
    : buildFixtureBase64()
  const miniProgram = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 60000
  })

  let insertedIds = []

  try {
    await miniProgram.reLaunch('/pages/list/index')
    await sleep(500)
    assertOk(await callCloud(miniProgram, 'setup'), '初始化云环境')

    const imported = assertOk(
      await callCloud(miniProgram, 'importRecords', {
        fileBase64,
        defaultChargeType: 'fast',
        importBatch: IMPORT_BATCH
      }),
      '导入样本'
    )
    insertedIds = imported.insertedIds || []

    assert.strictEqual(imported.sheetName, '充电数据', '应读取充电数据工作表')
    assert.strictEqual(imported.totalRows, 3, '应读取 3 行数据')
    assert.strictEqual(imported.imported, 3, '应导入 3 条')
    assert.strictEqual(imported.skippedDuplicate, 0, '首次导入不应有重复')
    assert.strictEqual(imported.skippedInvalid, 0, '首次导入不应有无效行')
    assert.strictEqual(insertedIds.length, 3, '应返回 3 个记录 ID')
    assert.strictEqual(imported.importBatch, IMPORT_BATCH, '导入批次号不一致')
    console.log('PASS 合成样本导入 3 条')

    const monthData = assertOk(
      await callCloud(miniProgram, 'listRecords', { month: FIXTURE_MONTH }),
      `查询 ${FIXTURE_MONTH}`
    )
    const importedMonth = monthData.records.filter((record) => insertedIds.includes(record._id))
    assert.strictEqual(importedMonth.length, 3, '测试月应导入 3 条')

    const first = importedMonth[0]
    const second = importedMonth[1]
    const third = importedMonth[2]
    assert.strictEqual(first.date, '2026-01-05', '首条日期错误')
    assert.strictEqual(first.chargeKwh, 40.123, '3 位小数充电量应保留')
    assert.strictEqual(first.chargeType, 'fast', '备注应推断为快充')
    assert.strictEqual(first.socStart, 20, 'SOC 起点错误')
    assert.strictEqual(first.socEnd, 100, 'SOC 终点错误')
    assert.strictEqual(second.chargeType, 'home', '家充备注应推断为 home')
    assert.strictEqual(second.segmentKm, 350, '第二条本段里程应为 350')
    assert.strictEqual(second.consumption, 8.7, '第二条本段电耗应为 8.7')
    assert.strictEqual(second.costPerKm, 0.06, '第二条本段成本应为 0.06')
    assert.strictEqual(third.segmentKm, 250, '第三条本段里程应为 250')
    assert.strictEqual(third.consumption, 14, '第三条本段电耗应为 14')
    assert.strictEqual(third.costPerKm, 0.1, '第三条本段成本应为 0.10')
    assert.ok(
      new Date(first.createdAt).getTime() < new Date(second.createdAt).getTime() &&
        new Date(second.createdAt).getTime() < new Date(third.createdAt).getTime(),
      '导入记录应保留原始时间顺序'
    )
    console.log('PASS 导入数据映射与计算口径')

    const duplicate = assertOk(
      await callCloud(miniProgram, 'importRecords', {
        fileBase64,
        defaultChargeType: 'fast',
        importBatch: IMPORT_BATCH
      }),
      '重复导入'
    )
    assert.strictEqual(duplicate.imported, 0, '重复导入不应新增')
    assert.strictEqual(duplicate.skippedDuplicate, 3, '重复导入应跳过 3 条')
    assert.strictEqual(duplicate.totalRows, 3, '重复导入仍应读取 3 行')
    console.log('PASS 重复导入去重')

    const detail = assertOk(
      await callCloud(miniProgram, 'getRecord', { _id: first._id }),
      '读取导入记录'
    )
    assert.strictEqual(detail.record.chargeKwh, 40.123, '编辑前应保留 3 位小数')

    assertOk(
      await callCloud(
        miniProgram,
        'updateRecord',
        Object.assign({ _id: first._id }, detail.record, { note: 'SMOKE-IMPORT-EDIT' })
      ),
      '编辑导入记录'
    )
    const edited = assertOk(
      await callCloud(miniProgram, 'getRecord', { _id: first._id }),
      '编辑后读取'
    )
    assert.strictEqual(edited.record.note, 'SMOKE-IMPORT-EDIT', '备注未更新')
    assert.strictEqual(edited.record.chargeKwh, 40.123, '编辑后充电量精度丢失')
    console.log('PASS 导入记录可编辑且保留精度')

    console.log('IMPORT SMOKE PASSED')
  } finally {
    const cleanup = await callCloud(miniProgram, 'deleteImportBatch', {
      importBatch: IMPORT_BATCH
    }).catch(() => null)
    if (cleanup && cleanup.code === 0) {
      console.log(`CLEANED ${cleanup.data.deleted} imported test records`)
    }
    await miniProgram.close()
  }
}

main().catch((err) => {
  console.error('IMPORT SMOKE FAILED:', err)
  process.exit(1)
})
