const ORDER_PROMPT = `你是充电记录信息提取助手。用户会提供 1-3 张图片，顺序不固定，可能包括：
A. 车辆仪表盘/中控屏照片：可能显示「总里程」「ODO」和 km，可能没有 SOC。
B. 充电订单截图：显示充电站、计费电量、充电时长、总费用、优惠券、实付款等。
C. 车辆消息/充电提醒列表：包含多条「开始充电提醒」「结束充电提醒」，每条有日期时间和当前电量百分比。

请先判断每张图片类型，再综合提取。只输出一个 JSON 对象，不要输出解释、Markdown 或任何额外文字。

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
  "note": "关键备注，最多300字或 null"
}

规则：
- odometer：从仪表盘/中控照片提取「总里程」或「ODO」后的 km 数字；忽略速度、温度、播放器、功率、档位等数字。
- chargeKwh：从订单截图提取「计费电量」「充电量」「度数」，单位 kWh。
- chargeFee：必须取实付金额，优先「实付款」「实际支付」；有优惠券、折扣、红包、退款时取抵扣后的实付，不要取「总费用」原价、电费+服务费合计、预付金额或退款金额；没有实付信息时才取总费用。
- station / chargeType：从订单截图提取站点；超充/快充/直流→fast，家充/家用→home，换电→swap，无法判断→null。
- socStart / socEnd（重要）：
  1. 从车辆消息/充电提醒列表中找到与订单匹配的那次充电。用订单上的「充电时长」和日期时间匹配：选择开始/结束时间差与订单时长最接近的一组「开始充电提醒 + 结束充电提醒」。
  2. 如果列表中有暂停/重启（例如结束在某个电量后又重新开始），只取与订单时长匹配的那一段的开始 SOC 和结束 SOC，不要用更早或更晚的其他会话。
  3. 没有订单时长时，取最近一次完成的充电会话。
  4. 找不到明确的开始/结束提醒则 null。
- date / time：取匹配到的充电会话的开始日期和时间；如果只有订单上的时间则用订单；没有明确年月日时 null，不要用手机状态栏时间或当前日期猜测。
- note：用不超过 300 字保留关键信息：充电时长、总费用、优惠券/折扣、实付款、匹配到的 SOC 区间（如 51%→100%）；站点单独放 station，不要重复；不要写订单号、手机号、账号、支付方式、车牌。
- 不要输出订单号、手机号、账号、支付方式、车牌号等隐私信息。
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

  const note = String(raw.note || '').trim().slice(0, 300)
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
  if (buffer.length >= 12 && buffer.slice(4, 8).toString() === 'ftyp') {
    const brand = buffer.slice(8, 12).toString()
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic'
    }
  }
  return 'image/jpeg'
}

module.exports = {
  ORDER_PROMPT,
  parseJsonObject,
  normalizeOrderFields,
  detectImageMime
}
