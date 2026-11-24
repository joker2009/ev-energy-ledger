const fs = require('fs')
const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')
const XLSX = require('xlsx')
const { buildFixtureBase64, FIXTURE_MONTH } = require('./lib/fixture')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const CUSTOM_SAMPLE_PATH = process.argv[2]
const IMPORT_BATCH = `SMOKE-EXPORT-${Date.now()}`

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

function readSheet(base64) {
  const workbook = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer' })
  assert.deepStrictEqual(workbook.SheetNames, ['充电数据'], '导出工作表名称错误')
  return XLSX.utils.sheet_to_json(workbook.Sheets['充电数据'], {
    header: 1,
    defval: ''
  })
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
    await new Promise((resolve) => setTimeout(resolve, 500))
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
    assert.strictEqual(imported.imported, 3, '合成样本应导入 3 条')
    assert.strictEqual(imported.importBatch, IMPORT_BATCH, '导入批次号不一致')

    const allExport = assertOk(
      await callCloud(miniProgram, 'exportRecords', { returnBase64: true }),
      '导出全部'
    )
    assert.ok(allExport.count >= 3, '全部导出数量不足')
    assert.match(allExport.fileName, /^电耗账本-全部-\d{4}-\d{2}-\d{2}\.xlsx$/, '全部导出文件名错误')

    const rows = readSheet(allExport.base64)
    assert.strictEqual(rows[0][0], '电耗账本 - 充电数据', '标题行错误')
    assert.strictEqual(rows[1][2], '里程类型', '缺少里程类型列')
    assert.strictEqual(rows[1][3], '充电类型', '缺少充电类型列')
    assert.strictEqual(rows.length, 2 + allExport.count, '导出行数与记录数不一致')

    const target = rows.find((row) => Number(row[1]) === 12000)
    assert.ok(target, '导出中找不到 12000 记录')
    assert.strictEqual(target[0], '2026-01-05 09:30', '导入时间未保留时分')
    assert.strictEqual(target[2], '总里程', '里程类型导出错误')
    assert.strictEqual(target[3], '快充', '充电类型导出错误')
    assert.strictEqual(Number(target[6]), 40.123, '充电量导出精度错误')
    assert.strictEqual(Number(target[8]), 30.5, '金额导出错误')
    assert.strictEqual(Number(target[9]), 0.7602, '单价导出错误')
    assert.strictEqual(target[10], '测试充电站 A', '备注导出错误')
    console.log('PASS 全部导出内容')

    const monthExport = assertOk(
      await callCloud(miniProgram, 'exportRecords', {
        month: FIXTURE_MONTH,
        returnBase64: true
      }),
      '导出指定月份'
    )
    assert.ok(monthExport.count >= 3, '测试月导出数量不足')
    assert.strictEqual(
      monthExport.fileName,
      `电耗账本-${FIXTURE_MONTH}.xlsx`,
      '月份导出文件名错误'
    )

    const monthRows = readSheet(monthExport.base64)
    assert.strictEqual(monthRows.length, 2 + monthExport.count, '月份导出行数错误')
    const dates = monthRows.slice(2).map((row) => String(row[0]).slice(0, 10))
    assert.ok(dates.includes('2026-01-05'), '测试月导出缺少 01-05')
    assert.ok(dates.includes('2026-01-12'), '测试月导出缺少 01-12')
    assert.ok(dates.includes('2026-01-20'), '测试月导出缺少 01-20')
    console.log('PASS 指定月份导出')

    const uploaded = assertOk(
      await callCloud(miniProgram, 'exportRecords', { month: FIXTURE_MONTH }),
      '生成云端导出文件'
    )
    assert.ok(uploaded.fileID, '未返回云端文件 ID')
    assert.ok(uploaded.count >= 3, '云端文件导出数量不足')

    const downloaded = await miniProgram.evaluate(async function (fileID) {
      const res = await wx.cloud.downloadFile({ fileID })
      return { path: res.tempFilePath, statusCode: res.statusCode }
    }, uploaded.fileID)
    assert.ok(downloaded.path, '导出文件下载失败')

    await miniProgram.evaluate(async function (fileID) {
      await wx.cloud.deleteFile({ fileList: [fileID] })
    }, uploaded.fileID)
    console.log('PASS 云端文件上传、下载与清理')

    console.log('EXPORT SMOKE PASSED')
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
  console.error('EXPORT SMOKE FAILED:', err)
  process.exit(1)
})
