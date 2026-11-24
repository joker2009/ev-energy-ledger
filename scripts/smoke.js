const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const normalize = (p) => String(p || '').replace(/^\//, '')

async function main() {
  const miniProgram = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 60000
  })

  const errors = []
  if (typeof miniProgram.on === 'function') {
    miniProgram.on('console', (msg) => {
      if (msg.type === 'error') errors.push(msg.args.join(' '))
    })
    miniProgram.on('exception', (err) => errors.push(String(err)))
  }

  try {
    // ---------- R1: 导航骨架 ----------
    const listPage = await miniProgram.reLaunch('/pages/list/index')
    await sleep(800)
    assert.strictEqual(normalize(listPage.path), 'pages/list/index', '首页路径不正确')
    const listData = await listPage.data()
    assert.ok(listData.monthLabel, '月份标题未渲染')
    assert.ok(Array.isArray(listData.groups), '记录分组应为数组')
    assert.ok(!listData.error, `记录页加载报错: ${listData.error}`)
    console.log(`PASS 记录页: ${listData.monthLabel}`)
    const listShot = '/tmp/mywxapp-list.png'
    await miniProgram.screenshot({ path: listShot })
    console.log('SCREENSHOT', listShot)

    const importPage = await miniProgram.navigateTo('/pages/import/index')
    await sleep(500)
    assert.strictEqual(normalize(importPage.path), 'pages/import/index', '未进入导入页')
    const importShot = '/tmp/mywxapp-import.png'
    await miniProgram.screenshot({ path: importShot })
    console.log('SCREENSHOT', importShot)
    await miniProgram.navigateBack()
    await sleep(400)
    console.log('PASS 导入页')

    const exportPage = await miniProgram.navigateTo('/pages/export/index')
    await sleep(500)
    assert.strictEqual(normalize(exportPage.path), 'pages/export/index', '未进入导出页')
    const exportShot = '/tmp/mywxapp-export.png'
    await miniProgram.screenshot({ path: exportShot })
    console.log('SCREENSHOT', exportShot)
    await miniProgram.navigateBack()
    await sleep(400)
    console.log('PASS 导出页')

    const statsPage = await miniProgram.switchTab('/pages/stats/index')
    await sleep(1000)
    assert.strictEqual(normalize(statsPage.path), 'pages/stats/index', '统计 tab 未切换')
    const statsData = await statsPage.data()
    assert.ok(statsData.metrics, '统计指标未初始化')
    assert.ok(!statsData.error, `统计页加载报错: ${statsData.error}`)
    console.log('PASS 统计 tab')

    await miniProgram.switchTab('/pages/list/index')
    await sleep(300)
    const addPage = await miniProgram.navigateTo('/pages/add/index')
    await sleep(400)
    assert.strictEqual(normalize(addPage.path), 'pages/add/index', '未进入记一笔')
    console.log('PASS 「+」进入记一笔')
    const addShot = '/tmp/mywxapp-add.png'
    await miniProgram.screenshot({ path: addShot })
    console.log('SCREENSHOT', addShot)

    // ---------- R2: 表单默认值与校验 ----------
    await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.onChargeTypeChange({ detail: { value: 'home' } })
    })
    const formData = await addPage.data()
    assert.match(formData.form.date, /^\d{4}-\d{2}-\d{2}$/, '日期默认值格式错误')
    assert.strictEqual(formData.form.odometerType, 'total', '里程类型默认值错误')
    assert.strictEqual(formData.form.chargeType, 'home', '充电类型默认值错误')
    assert.strictEqual(formData.isCharging, true, '默认应为充电状态')
    assert.strictEqual(formData.hasAnyInput, false, '空表单时保存按钮应置灰')
    console.log('PASS 表单默认值')

    let formErrors = await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      return page.validateForm()
    })
    assert.ok(formErrors.odometer, '空表单应拦截里程')
    assert.ok(formErrors.chargeKwh, '空表单应拦截充电量')
    assert.ok(formErrors.chargeFee, '空表单应拦截金额')
    console.log('PASS 空表单必填拦截')

    formErrors = await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.setData({
        'form.odometer': '10350',
        'form.chargeKwh': '45',
        'form.chargeFee': '60',
        'form.socStart': '20',
        'form.socEnd': '90'
      })
      return page.validateForm()
    })
    assert.deepStrictEqual(formErrors, {}, `合法表单不应报错: ${JSON.stringify(formErrors)}`)
    console.log('PASS 合法表单通过校验')

    formErrors = await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.setData({
        'form.odometer': '10350.55',
        'form.chargeKwh': '250',
        'form.chargeFee': '-1',
        'form.socEnd': '10'
      })
      return page.validateForm()
    })
    assert.ok(formErrors.odometer, '里程小数位应拦截')
    assert.ok(formErrors.chargeKwh, '充电量上限应拦截')
    assert.ok(formErrors.chargeFee, '负数金额应拦截')
    assert.ok(formErrors.soc, 'SOC 结束小于开始应拦截')
    console.log('PASS 非法值拦截')

    const noneData = await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.onChargeTypeChange({ detail: { value: 'none' } })
      return {
        isCharging: page.data.isCharging,
        chargeKwh: page.data.form.chargeKwh,
        errors: page.validateForm()
      }
    })
    assert.strictEqual(noneData.isCharging, false, '未充电应关闭充电量')
    assert.strictEqual(noneData.chargeKwh, '', '未充电应清空充电量')
    assert.ok(!noneData.errors.chargeKwh, '未充电时不应要求充电量')
    console.log('PASS 「未充电」联动')

    await miniProgram.evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      page.onChargeTypeChange({ detail: { value: 'home' } })
    })

    await miniProgram.navigateBack()
    await sleep(300)
    const backPage = await miniProgram.currentPage()
    assert.strictEqual(normalize(backPage.path), 'pages/list/index', '返回列表失败')
    console.log('PASS 返回列表')

    if (errors.length > 0) {
      console.error('控制台错误:', errors)
      process.exitCode = 1
    } else {
      console.log('SMOKE PASSED: R1 导航 + R2 表单校验')
    }
  } finally {
    await miniProgram.close()
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
