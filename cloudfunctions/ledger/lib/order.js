const ORDER_PROMPT = `你是充电订单信息提取助手。请从用户提供的充电订单截图中提取字段，只输出一个 JSON 对象，不要输出解释、Markdown 或任何额外文字。

JSON 结构：
{
  "date": "YYYY-MM-DD 或 null",
  "time": "HH:mm 或 null",
  "odometer": 数字或 null,
  "chargeKwh": 数字或 null,
  "chargeFee": 数字或 null,
  "socStart": 数字或 null,
  "socEnd": 数字或 null,
  "chargeType": "home" | "fast" | "swap" | "none" 或 null,
  "station": "充电站名称或 null",
  "note": "充电时长、站点补充等非金额备注，或 null"
}

规则：
- 用户可能一次上传 1-3 张图片，顺序不固定，可能包括：充电开始界面（起始 SOC，可能带总里程）、充电结束界面（结束 SOC，可能带总里程）、充电订单截图（电量/实付金额/站点/时间）。请根据图片内容判断类型并综合提取。
- socStart 取开始界面的起始/充电前电量；socEnd 取结束界面的结束/充电后电量；只有一个订单截图时 SOC 返回 null。
- odometer 取开始或结束界面的总里程/ODO；两张都有时优先开始界面，开始没有则用结束界面；订单截图没有里程时返回 null。
- chargeKwh / chargeFee / date / time / station / chargeType 取充电订单截图。
- 只提取与本次充电订单直接相关的数据。
- 不要输出订单号、手机号、账号、支付方式、车牌号等隐私信息。
- 电量单位 kWh（截图中“度”按 kWh 处理），金额单位元。
- 金额规则（非常重要）：chargeFee 必须取用户实际支付的金额，优先「实付款」「实际支付」「实付金额」「支付金额」；如果订单有优惠券、折扣、红包、余额抵扣、退款，必须使用抵扣后的实付金额。不要取「电费+服务费」的原价合计、优惠前总费用、预付款或退款金额；如果图片只显示总费用且没有实付/优惠信息，才取总费用。
- note 只保留充电时长、停车/占位费等非金额补充；不要包含预付款、退款、优惠券、电费/服务费拆分等金额信息。
- 充电前/后电量只取 0-100 的百分比整数。
- 充电类型：家用/家充/慢充→home；快充/超充/直流/公共充电→fast；换电→swap；无法判断→null。
- 如果截图中没有明确的年月日，date 必须为 null，不要用手机状态栏时间或当前日期猜测。
- 总里程只提取明确的 ODO/总里程数字，没有则 null。
- 不确定的字段一律 null，不要猜测。`

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const text = String(value || '').replace(/[,\s]/g, '')
  if (!text) return NaN
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

function parseJsonObject(text) {
  if (!text) return null
  const cleaned = String(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    return null
  }
}

function normalizeOrderFields(raw, today) {
  if (!raw || typeof raw !== 'object') return {}

  const fields = {}

  const date = String(raw.date || '').trim().replace(/\//g, '-')
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '2000-01-01' && date <= today) {
    fields.date = date
  }

  const timeMatch = String(raw.time || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (timeMatch) {
    const hour = Number(timeMatch[1])
    const minute = Number(timeMatch[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      fields.time = `${hour < 10 ? `0${hour}` : hour}:${minute < 10 ? `0${minute}` : minute}`
    }
  }

  const odometer = toNumber(raw.odometer)
  if (odometer > 0 && odometer <= 2000000) {
    fields.odometer = Math.round(odometer * 10) / 10
  }

  const chargeKwh = toNumber(raw.chargeKwh)
  if (chargeKwh > 0 && chargeKwh <= 200) {
    fields.chargeKwh = Math.round(chargeKwh * 1000) / 1000
  }

  const chargeFee = toNumber(raw.chargeFee)
  if (chargeFee >= 0 && chargeFee <= 10000) {
    fields.chargeFee = Math.round(chargeFee * 100) / 100
  }

  const socStart = toNumber(raw.socStart)
  const socEnd = toNumber(raw.socEnd)
  if (
    Number.isInteger(socStart) &&
    Number.isInteger(socEnd) &&
    socStart >= 0 &&
    socStart <= 100 &&
    socEnd >= 0 &&
    socEnd <= 100 &&
    socEnd > socStart
  ) {
    fields.socStart = socStart
    fields.socEnd = socEnd
  }

  const chargeType = String(raw.chargeType || '').trim()
  if (['home', 'fast', 'swap', 'none'].includes(chargeType)) {
    fields.chargeType = chargeType
  }

  const station = String(raw.station || '').trim().slice(0, 60)
  if (station) fields.station = station

  const note = String(raw.note || '').trim().slice(0, 100)
  if (note) fields.note = note

  return fields
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 4) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.slice(0, 3).toString() === 'GIF') return 'image/gif'
  if (
    buffer.slice(0, 4).toString() === 'RIFF' &&
    buffer.slice(8, 12).toString() === 'WEBP'
  ) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

module.exports = {
  ORDER_PROMPT,
  parseJsonObject,
  normalizeOrderFields,
  detectImageMime
}
