const fs = require('fs')
const path = require('path')
const assert = require('assert')
const automator = require('miniprogram-automator')

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT_PATH = path.resolve(__dirname, '..')
const IMAGE_PATH = process.argv[2] || '/tmp/odo.png'

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

    const missing = await callCloud(miniProgram, 'recognizeMileage', {})
    assert.strictEqual(missing.code, 400, '缺少图片时应返回 400')
    console.log('PASS 缺少图片参数校验')

    const result = await callCloud(miniProgram, 'recognizeMileage', { imageBase64 })
    console.log('OCR RESULT:', JSON.stringify(result))

    if (result.code === 0) {
      const candidates = result.data.candidates || []
      assert.ok(
        candidates.some((item) => item.value === 54321),
        `未识别出 54321，候选：${JSON.stringify(candidates)}`
      )
      console.log('OCR SMOKE PASSED: 已识别测试图里程 54321')
    } else if (/未开通|权限|额度|permission|quota|scope|auth/i.test(result.message || '')) {
      console.log(`OCR SKIPPED: ${result.message}`)
    } else {
      throw new Error(`OCR 调用失败: ${JSON.stringify(result)}`)
    }
  } finally {
    await miniProgram.close()
  }
}

main().catch((err) => {
  console.error('OCR SMOKE FAILED:', err)
  process.exit(1)
})
