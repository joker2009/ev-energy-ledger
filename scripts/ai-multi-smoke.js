const fs = require('fs')
const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const IMAGE_PATHS = [
  process.argv[2] || '/tmp/charge-start.png',
  process.argv[3] || '/tmp/charge-end.png',
  process.argv[4] || '/tmp/charge-order.png'
]

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
  for (const imagePath of IMAGE_PATHS) {
    if (!fs.existsSync(imagePath)) throw new Error(`找不到测试图片: ${imagePath}`)
  }
  const imagesBase64 = IMAGE_PATHS.map((imagePath) =>
    fs.readFileSync(imagePath).toString('base64')
  )

  const miniProgram = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    timeout: 60000
  })

  try {
    await miniProgram.reLaunch('/pages/list/index')
    await new Promise((resolve) => setTimeout(resolve, 500))

    const result = await callCloud(miniProgram, 'recognizeChargeOrder', { imagesBase64 })
    console.log('AI MULTI RESULT:', JSON.stringify(result))

    if (result.code === 0) {
      const fields = result.data.fields || {}
      assert.strictEqual(fields.socStart, 20, '起始 SOC 识别错误')
      assert.strictEqual(fields.socEnd, 100, '结束 SOC 识别错误')
      assert.strictEqual(fields.odometer, 12000, '总里程应优先取开始界面 12000')
      assert.ok(Math.abs(Number(fields.chargeKwh) - 40.12) < 0.05, '充电量识别错误')
      assert.ok(Math.abs(Number(fields.chargeFee) - 30.5) < 0.05, '金额应取实付 30.50')
      assert.strictEqual(fields.chargeType, 'fast', '充电类型识别错误')
      assert.ok(String(fields.station || '').includes('测试充电站'), '站点识别错误')
      assert.ok(!/预付|退款|优惠券|服务费/.test(fields.note || ''), '备注不应包含金额明细')
      console.log('AI MULTI SMOKE PASSED')
    } else if (/未配置|DEEPSEEK_API_KEY/i.test(result.message || '')) {
      console.log('AI MULTI SKIPPED: 云函数尚未配置 DEEPSEEK_API_KEY')
    } else {
      throw new Error(`多图识别失败: ${JSON.stringify(result)}`)
    }
  } finally {
    await miniProgram.close()
  }
}

main().catch((err) => {
  console.error('AI MULTI SMOKE FAILED:', err)
  process.exit(1)
})
