const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const TEST_MONTH = '2000-01'
const TEST_NOTE = 'SMOKE-CALC'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeout = 12000, interval = 400) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await check()
    if (value) return value
    await sleep(interval)
  }
  return null
}

const pad = (n) => (n < 10 ? `0${n}` : `${n}`)
const currentMonth = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
}

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

async function cleanupTestRecords(miniProgram) {
  for (const month of [TEST_MONTH, currentMonth()]) {
    const data = assertOk(
      await callCloud(miniProgram, 'listRecords', { month }),
      '清理查询'
    )
    for (const record of data.records) {
      if (String(record.note || '').startsWith('SMOKE-')) {
        assertOk(await callCloud(miniProgram, 'deleteRecord', { _id: record._id }), '清理删除')
      }
    }
  }
}

async function main() {
  const miniProgram = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 60000
  })

  const consoleErrors = []
  if (typeof miniProgram.on === 'function') {
    miniProgram.on('console', (msg) => {
      if (msg.type === 'error') consoleErrors.push(msg.args.join(' '))
    })
    miniProgram.on('exception', (err) => consoleErrors.push(String(err)))
  }

  try {
    await miniProgram.reLaunch('/pages/list/index')
    await sleep(500)

    assertOk(await callCloud(miniProgram, 'setup'), '初始化云环境')
    console.log('PASS 云函数 setup：集合与默认车辆就绪')

    const aiMissing = await callCloud(miniProgram, 'recognizeChargeOrder', {})
    assert.strictEqual(aiMissing.code, 400, '订单识别缺少图片时应返回 400')
    console.log('PASS 订单识别参数校验')

    await cleanupTestRecords(miniProgram)

    // ---------- 计算口径：两条 2000 年的隔离记录 ----------
    const first = assertOk(
      await callCloud(miniProgram, 'addRecord', {
        date: `${TEST_MONTH}-01`,
        odometer: 1000,
        odometerType: 'total',
        chargeKwh: 40,
        chargeFee: 30,
        chargeType: 'home',
        note: `${TEST_NOTE}-A`
      }),
      '新增记录 A'
    )
    assert.strictEqual(first.segmentKm, null, '首条 total 记录不应有本段里程')
    assert.strictEqual(first.consumption, null, '首条记录不应有电耗')

    const second = assertOk(
      await callCloud(miniProgram, 'addRecord', {
        date: `${TEST_MONTH}-02`,
        odometer: 1350,
        odometerType: 'total',
        chargeKwh: 45,
        chargeFee: 60,
        chargeType: 'fast',
        note: `${TEST_NOTE}-B`
      }),
      '新增记录 B'
    )
    assert.strictEqual(second.segmentKm, 350, '本段里程应为 350')
    assert.strictEqual(second.consumption, 12.9, '本段电耗应为 12.9')
    assert.strictEqual(second.costPerKm, 0.17, '本段成本应为 0.17')
    console.log('PASS 本段里程 / 电耗 / 成本计算')

    const monthly = assertOk(
      await callCloud(miniProgram, 'listRecords', { month: TEST_MONTH }),
      '查询测试月'
    )
    assert.strictEqual(monthly.summary.recordCount, 2, '测试月应有 2 条记录')
    assert.strictEqual(monthly.summary.distanceKm, 350, '月里程应为 350')
    assert.strictEqual(monthly.summary.chargeKwh, 85, '月充电量应为 85')
    assert.strictEqual(monthly.summary.fee, 90, '月花费应为 90')
    assert.strictEqual(monthly.summary.consumption, 12.9, '月电耗应为 12.9')
    assert.strictEqual(monthly.summary.costPerKm, 0.17, '月成本应为 0.17')
    console.log('PASS 月度汇总口径')

    const stats = assertOk(await callCloud(miniProgram, 'getStats', { months: 0 }), '统计')
    const testMonth = stats.months.find((item) => item.month === TEST_MONTH)
    assert.ok(testMonth, '全量统计应包含测试月')
    assert.strictEqual(testMonth.consumption, 12.9, '统计页测试月电耗应为 12.9')
    assert.strictEqual(testMonth.costPerKm, 0.17, '统计页测试月成本应为 0.17')
    console.log('PASS 统计接口')

    const yearStats = assertOk(
      await callCloud(miniProgram, 'getStats', { year: 2000 }),
      '年度统计'
    )
    assert.strictEqual(yearStats.year, '2000', '年度统计年份错误')
    assert.strictEqual(yearStats.months.length, 12, '年度统计应返回 12 个月')
    assert.ok(yearStats.availableYears.includes('2000'), 'availableYears 缺少 2000')
    const testYearMonth = yearStats.months.find((item) => item.month === '2000-01')
    assert.ok(testYearMonth, '年度统计缺少 2000-01')
    assert.strictEqual(testYearMonth.consumption, 12.9, '年度统计 1 月电耗应为 12.9')
    console.log('PASS 年度统计接口')

    // ---------- 表单真实提交 ----------
    const addPage = await miniProgram.navigateTo('/pages/add/index')
    await sleep(400)
    await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.onChargeTypeChange({ detail: { value: 'home' } })
      page.setData({
        'form.odometer': '999999',
        'form.chargeKwh': '10',
        'form.chargeFee': '10',
        'form.note': 'SMOKE-UI'
      })
      page.refreshHasAnyInput()
    })

    const submitState = await miniProgram.evaluate(async function () {
      const page = getCurrentPages().slice(-1)[0]
      await page.onSubmit()
      return { submitting: page.data.submitting, errors: page.data.errors }
    })
    assert.strictEqual(submitState.submitting, true, '提交后应进入 loading')
    assert.deepStrictEqual(submitState.errors, {}, '提交时不应有校验错误')
    await sleep(1000)

    const afterSubmit = await miniProgram.currentPage()
    assert.strictEqual(String(afterSubmit.path).replace(/^\//, ''), 'pages/list/index', '保存后应返回列表')
    console.log('PASS 表单提交并返回列表')

    await sleep(1200)
    const listMonth = (await afterSubmit.data()).monthValue
    const rendered = await waitFor(async () => {
      const data = await afterSubmit.data()
      if (data.loading || data.error) return null
      const records = (data.groups || []).reduce(
        (all, group) => all.concat(group.records),
        []
      )
      return records.find((item) => String(item.odoText).includes('999999')) || null
    })
    assert.ok(rendered, '列表应渲染刚提交的记录')
    assert.strictEqual(rendered.kwhText, '10.0 kWh', '列表充电量展示错误')
    assert.strictEqual(rendered.feeText, '¥10.00', '列表金额展示错误')
    console.log('PASS 列表渲染本月记录')

    const uiRecord = await waitFor(async () => {
      const current = assertOk(
        await callCloud(miniProgram, 'listRecords', { month: listMonth }),
        '查询本月'
      )
      return current.records.find((item) => item.note === 'SMOKE-UI') || null
    })
    assert.ok(uiRecord, '表单提交的记录应写入云数据库')
    assert.strictEqual(uiRecord.odometer, 999999, '写入的里程应一致')
    console.log('PASS 云数据库写入')

    const detail = assertOk(
      await callCloud(miniProgram, 'getRecord', { _id: uiRecord._id }),
      '读取单条记录'
    )
    assert.strictEqual(detail.record.note, 'SMOKE-UI', '读取记录备注不一致')

    const editPage = await miniProgram.navigateTo(`/pages/add/index?id=${uiRecord._id}`)
    const editReady = await waitFor(async () => {
      const data = await editPage.data()
      if (data.loading) return null
      return data.form.odometer === '999999' ? data : null
    })
    assert.ok(editReady, '编辑页未正确回填')
    assert.strictEqual(editReady.isEditing, true, '编辑页应进入编辑模式')
    assert.strictEqual(editReady.form.chargeFee, '10', '编辑页金额回填错误')

    const editSubmit = await miniProgram.evaluate(async function () {
      const page = getCurrentPages().slice(-1)[0]
      page.setData({
        'form.chargeFee': '11',
        'form.note': 'SMOKE-UI-EDIT'
      })
      await page.onSubmit()
      return { errors: page.data.errors }
    })
    assert.deepStrictEqual(editSubmit.errors, {}, '编辑提交不应有校验错误')
    await sleep(1000)

    const afterEdit = await miniProgram.currentPage()
    assert.strictEqual(
      String(afterEdit.path).replace(/^\//, ''),
      'pages/list/index',
      '编辑保存后应返回列表'
    )
    const updated = await waitFor(async () => {
      const current = assertOk(
        await callCloud(miniProgram, 'listRecords', { month: listMonth }),
        '编辑后查询'
      )
      return current.records.find(
        (item) => item._id === uiRecord._id && item.note === 'SMOKE-UI-EDIT'
      ) || null
    })
    assert.ok(updated, '编辑后的记录未写入云数据库')
    assert.strictEqual(updated.chargeFee, 11, '编辑后的金额不一致')

    const listUpdated = await waitFor(async () => {
      const data = await afterEdit.data()
      if (data.loading || data.error) return null
      const records = (data.groups || []).reduce(
        (all, group) => all.concat(group.records),
        []
      )
      return records.find((item) => item.feeText === '¥11.00') || null
    })
    assert.ok(listUpdated, '列表未刷新编辑后的金额')
    console.log('PASS 历史记录编辑')

    await miniProgram.mockWxMethod('showModal', { confirm: true })
    await miniProgram.evaluate(function (id) {
      const page = getCurrentPages().slice(-1)[0]
      page.onSwipeClick({ currentTarget: { dataset: { id } } })
    }, uiRecord._id)

    const deleted = await waitFor(async () => {
      const afterDelete = assertOk(
        await callCloud(miniProgram, 'listRecords', { month: listMonth }),
        '删除后查询'
      )
      return !afterDelete.records.some((item) => item._id === uiRecord._id)
    })
    await miniProgram.restoreWxMethod('showModal')
    assert.ok(deleted, '左滑删除后记录仍存在')
    console.log('PASS 左滑删除')

    await miniProgram.switchTab('/pages/stats/index')
    await sleep(1500)
    await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.onRangeChange({ currentTarget: { dataset: { value: '0' } } })
    })
    await sleep(2000)

    const statsView = await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      const testMonth = (page.statsData && page.statsData.months ? page.statsData.months : [])
        .find((item) => item.month === '2000-01')
      return {
        error: page.data.error,
        hasConsumption: page.data.hasConsumption,
        hasCost: page.data.hasCost,
        testMonth,
        chartReady: Boolean(page.charts && page.charts.consumption)
      }
    })
    assert.ok(!statsView.error, `统计页加载失败: ${statsView.error}`)
    assert.ok(statsView.hasConsumption, '统计页应显示电耗趋势')
    assert.ok(statsView.testMonth, '全量统计应包含测试月')
    assert.strictEqual(statsView.testMonth.consumption, 12.9, '统计页测试月电耗应为 12.9')
    assert.strictEqual(statsView.testMonth.costPerKm, 0.17, '统计页测试月成本应为 0.17')
    assert.ok(statsView.chartReady, 'ECharts 实例未初始化')
    console.log('PASS 统计页图表数据与初始化')

    const screenshotPath = '/tmp/mywxapp-stats.png'
    await miniProgram.screenshot({ path: screenshotPath })
    console.log('SCREENSHOT', screenshotPath)

    await miniProgram.pageScrollTo(900)
    await sleep(800)
    const pieScreenshotPath = '/tmp/mywxapp-stats-pie.png'
    await miniProgram.screenshot({ path: pieScreenshotPath })
    console.log('SCREENSHOT', pieScreenshotPath)

    await cleanupTestRecords(miniProgram)

    if (consoleErrors.length > 0) {
      console.error('控制台错误:', consoleErrors)
      process.exitCode = 1
    } else {
      console.log('CLOUD SMOKE PASSED: setup + 计算口径 + 列表渲染 + 表单提交 + 编辑 + 左滑删除 + 统计图表')
    }
  } finally {
    await miniProgram.close()
  }
}

main().catch(async (err) => {
  console.error('CLOUD SMOKE FAILED:', err)
  process.exit(1)
})
