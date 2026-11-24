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
  "note": "其他与本次充电有关的简短备注或 null"
}

规则：
- 只提取与本次充电订单直接相关的数据。
- 不要输出订单号、手机号、账号、支付方式、车牌号等隐私信息。
- 电量单位 kWh（截图中“度”按 kWh 处理），金额单位元。
- 充电前/后电量只取 0-100 的百分比整数。
- 充电类型：家用/家充/慢充→home；快充/超充/直流/公共充电→fast；换电→swap；无法判断→null。
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
