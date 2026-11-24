const fs = require('fs')
const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const IMAGE_PATH = process.argv[2] || '/tmp/charge-order.png'

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

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    throw new Error(`找不到测试图片: ${IMAGE_PATH}`)
  }
  const imageBase64 = fs.readFileSync(IMAGE_PATH).toString('base64')

  const miniProgram = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 60000
  })

  try {
    await miniProgram.reLaunch('/pages/list/index')
    await new Promise((resolve) => setTimeout(resolve, 500))

    const result = await callCloud(miniProgram, 'recognizeChargeOrder', { imageBase64 })
    console.log('AI RESULT:', JSON.stringify(result))

    if (result.code === 0) {
      const fields = result.data.fields || {}
      assert.strictEqual(fields.date, '2026-01-05', '日期识别错误')
      assert.ok(Math.abs(Number(fields.chargeKwh) - 40.12) < 0.05, '充电量识别错误')
      assert.ok(Math.abs(Number(fields.chargeFee) - 30.5) < 0.05, '金额识别错误')
      assert.strictEqual(fields.socStart, 20, 'SOC 起点识别错误')
      assert.strictEqual(fields.socEnd, 100, 'SOC 终点识别错误')
      assert.strictEqual(fields.odometer, 12000, '总里程识别错误')
      assert.strictEqual(fields.chargeType, 'fast', '充电类型识别错误')
      assert.ok(String(fields.station || '').includes('测试充电站'), '站点识别错误')
      console.log('AI ORDER SMOKE PASSED')
    } else if (/未配置|DEEPSEEK_API_KEY/i.test(result.message || '')) {
      console.log('AI ORDER SKIPPED: 云函数尚未配置 DEEPSEEK_API_KEY')
    } else {
      throw new Error(`订单识别失败: ${JSON.stringify(result)}`)
    }
  } finally {
    await miniProgram.close()
  }
}

main().catch((err) => {
  console.error('AI ORDER SMOKE FAILED:', err)
  process.exit(1)
})
