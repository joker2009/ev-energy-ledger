const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const XLSX = require('xlsx')
const { extractMileageCandidates } = require('./lib/ocr')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const RECORDS = 'records'
const VEHICLES = 'vehicles'
const MAX_LIMIT = 100
const CHINA_OFFSET = 8 * 60 * 60 * 1000
const CHARGE_TYPES = ['home', 'fast', 'swap', 'none']
const ODOMETER_TYPES = ['total', 'trip']

const HEADER_ALIASES = {
  date: ['充电时间', '时间', '日期', '发生时间'],
  odometer: ['总里程', '里程', '里程表读数'],
  odometerType: ['里程类型'],
  chargeType: ['充电类型'],
  socStart: ['充电前电量', '起始电量', '充电前soc', 'soc开始'],
  socEnd: ['充电后电量', '结束电量', '充电后soc', 'soc结束'],
  chargeKwh: ['充电度数', '充电量', '电量', '度数'],
  chargeFee: ['充电金额', '金额', '费用', '花费'],
  note: ['备注', '说明']
}

const FIELD_LABELS = {
  date: '充电时间',
  odometer: '总里程',
  chargeKwh: '充电度数',
  chargeFee: '充电金额'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const DECIMAL_RE = {
  1: /^\d+(\.\d)?$/,
  2: /^\d+(\.\d{1,2})?$/,
  3: /^\d+(\.\d{1,3})?$/
}

let collectionsReady = false

const ok = (data) => ({ code: 0, data })
const fail = (code, message) => ({ code, message })

const badRequest = (message) => {
  const err = new Error(message)
  err.code = 400
  throw err
}

const forbidden = (message) => {
  const err = new Error(message)
  err.code = 403
  throw err
}

const chinaToday = () => new Date(Date.now() + CHINA_OFFSET).toISOString().slice(0, 10)

const chinaMonth = () => new Date(Date.now() + CHINA_OFFSET).toISOString().slice(0, 7)

const round = (value, digits) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const toTime = (value) => {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (err) {
    // 集合已存在时直接忽略；其他错误交给后续实际读写暴露。
  }
}

async function ensureCollections() {
  if (collectionsReady) return
  await Promise.all([ensureCollection(RECORDS), ensureCollection(VEHICLES)])
  collectionsReady = true
}

async function getVehicle(openid) {
  const res = await db.collection(VEHICLES).where({ _openid: openid }).limit(1).get()
  return res.data[0] || null
}

async function ensureVehicle(openid) {
  await ensureCollections()
  const existing = await getVehicle(openid)
  if (existing) return existing

  const doc = {
    _openid: openid,
    name: '我的车',
    model: '',
    batteryKwh: null,
    plateNo: '',
    createdAt: db.serverDate()
  }
  const res = await db.collection(VEHICLES).add({ data: doc })
  return Object.assign({ _id: res._id }, doc)
}

async function fetchRecords(openid) {
  const countRes = await db.collection(RECORDS).where({ _openid: openid }).count()
  const total = countRes.total || 0
  if (total === 0) return []

  const pages = Math.ceil(total / MAX_LIMIT)
  const tasks = []
  for (let i = 0; i < pages; i += 1) {
    tasks.push(
      db
        .collection(RECORDS)
        .where({ _openid: openid })
        .skip(i * MAX_LIMIT)
        .limit(MAX_LIMIT)
        .get()
    )
  }
  const results = await Promise.all(tasks)
  return results.reduce((all, res) => all.concat(res.data), [])
}

function sortRecords(records) {
  return records.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const timeA = toTime(a.createdAt)
    const timeB = toTime(b.createdAt)
    if (timeA !== timeB) return timeA - timeB
    return String(a._id).localeCompare(String(b._id))
  })
}

/**
 * 派生值不落库：每次读取时按日期顺序重算本段里程与电耗。
 * total 记录只与上一条 total 记录做差；trip 记录直接取自身读数。
 */
function computeRecords(rawRecords) {
  const records = sortRecords(rawRecords)
  let lastTotal = null

  return records.map((record) => {
    const item = Object.assign({}, record)
    let segmentKm = null
    let prevOdometer = null

    if (record.odometerType === 'trip') {
      const km = Number(record.odometer)
      if (km > 0 && km <= 2000) segmentKm = km
    } else {
      if (lastTotal) {
        prevOdometer = Number(lastTotal.odometer)
        const km = Number(record.odometer) - prevOdometer
        if (km > 0 && km <= 2000) segmentKm = km
      }
      lastTotal = record
    }

    const chargeKwh = Number(record.chargeKwh) || 0
    const chargeFee = Number(record.chargeFee) || 0

    item.segmentKm = segmentKm
    item.prevOdometer = prevOdometer
    item.consumption = segmentKm && chargeKwh > 0 ? round((chargeKwh / segmentKm) * 100, 1) : null
    item.costPerKm = segmentKm ? round(chargeFee / segmentKm, 2) : null
    item.segmentValid = Boolean(segmentKm)
    return item
  })
}

function summarize(records) {
  let distanceKm = 0
  let chargeKwh = 0
  let fee = 0
  let energyKwh = 0
  let energyKm = 0
  let costFee = 0
  let costKm = 0

  records.forEach((record) => {
    const kwh = Number(record.chargeKwh) || 0
    const recordFee = Number(record.chargeFee) || 0
    chargeKwh += kwh
    fee += recordFee

    if (record.segmentKm) {
      distanceKm += record.segmentKm
      if (kwh > 0) {
        energyKwh += kwh
        energyKm += record.segmentKm
      }
      costFee += recordFee
      costKm += record.segmentKm
    }
  })

  return {
    recordCount: records.length,
    distanceKm: round(distanceKm, 1),
    chargeKwh: round(chargeKwh, 1),
    fee: round(fee, 2),
    consumption: energyKm > 0 ? round((energyKwh / energyKm) * 100, 1) : null,
    costPerKm: costKm > 0 ? round(costFee / costKm, 2) : null
  }
}

function recentMonthKeys(count) {
  const now = new Date(Date.now() + CHINA_OFFSET)
  const keys = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    keys.push(date.toISOString().slice(0, 7))
  }
  return keys
}

function toClientRecord(record) {
  return {
    _id: record._id,
    date: record.date,
    odometer: record.odometer,
    odometerType: record.odometerType,
    chargeKwh: record.chargeKwh,
    chargeFee: record.chargeFee,
    chargeType: record.chargeType,
    socStart: record.socStart,
    socEnd: record.socEnd,
    note: record.note,
    createdAt: record.createdAt,
    segmentKm: record.segmentKm,
    prevOdometer: record.prevOdometer,
    consumption: record.consumption,
    costPerKm: record.costPerKm,
    segmentValid: record.segmentValid
  }
}

function toClientVehicle(vehicle) {
  if (!vehicle) return null
  const copy = Object.assign({}, vehicle)
  delete copy._openid
  return copy
}

function toEditableRecord(record) {
  return {
    _id: record._id,
    date: record.date,
    odometer: record.odometer,
    odometerType: record.odometerType,
    chargeKwh: record.chargeKwh,
    chargeFee: record.chargeFee,
    chargeType: record.chargeType,
    socStart: record.socStart,
    socEnd: record.socEnd,
    note: record.note,
    createdAt: record.createdAt
  }
}

function normalizeRecord(payload) {
  const date = String(payload.date || '')
  if (!DATE_RE.test(date)) badRequest('日期格式不正确')
  if (date < '2000-01-01') badRequest('日期不能早于 2000-01-01')
  if (date > chinaToday()) badRequest('日期不能晚于今天')

  const odometerType = String(payload.odometerType || 'total')
  if (!ODOMETER_TYPES.includes(odometerType)) badRequest('里程类型不正确')

  const odometerText = String(payload.odometer)
  const odometer = Number(odometerText)
  if (odometerText.trim() === '' || !DECIMAL_RE[1].test(odometerText)) {
    badRequest('里程最多 1 位小数')
  }
  if (!(odometer > 0) || odometer > 2000000) badRequest('里程读数无效')

  const chargeType = String(payload.chargeType || 'home')
  if (!CHARGE_TYPES.includes(chargeType)) badRequest('充电类型不正确')

  let chargeKwh = 0
  if (chargeType !== 'none') {
    const kwhText = String(payload.chargeKwh)
    chargeKwh = Number(kwhText)
    if (kwhText.trim() === '' || !DECIMAL_RE[3].test(kwhText)) badRequest('充电量最多 3 位小数')
    if (!(chargeKwh > 0) || chargeKwh > 200) badRequest('充电量需在 0–200 kWh 之间')
  }

  const feeText = String(payload.chargeFee)
  const chargeFee = Number(feeText)
  if (feeText.trim() === '' || !DECIMAL_RE[2].test(feeText)) badRequest('金额最多 2 位小数')
  if (chargeFee < 0 || chargeFee > 10000) badRequest('金额需在 0–10000 元之间')

  const socStart = payload.socStart === '' || payload.socStart === null || payload.socStart === undefined
    ? null
    : Number(payload.socStart)
  const socEnd = payload.socEnd === '' || payload.socEnd === null || payload.socEnd === undefined
    ? null
    : Number(payload.socEnd)

  if (socStart !== null || socEnd !== null) {
    if (socStart === null || socEnd === null) badRequest('请同时填写起始与结束电量')
    if (
      !Number.isInteger(socStart) ||
      !Number.isInteger(socEnd) ||
      socStart < 0 ||
      socStart > 100 ||
      socEnd < 0 ||
      socEnd > 100
    ) {
      badRequest('电量需为 0–100 的整数')
    }
    if (socEnd <= socStart) badRequest('结束电量需大于起始电量')
  }

  const note = String(payload.note || '').slice(0, 100)

  return {
    date,
    odometer,
    odometerType,
    chargeKwh,
    chargeFee,
    chargeType,
    socStart,
    socEnd,
    note
  }
}

async function addRecord(openid, payload) {
  await ensureCollections()
  const record = normalizeRecord(payload)
  const vehicle = await ensureVehicle(openid)

  const res = await db.collection(RECORDS).add({
    data: Object.assign({}, record, {
      _openid: openid,
      vehicleId: vehicle._id,
      createdAt: db.serverDate()
    })
  })

  const all = computeRecords(await fetchRecords(openid))
  const created = all.find((item) => item._id === res._id) || null

  return {
    _id: res._id,
    segmentKm: created ? created.segmentKm : null,
    prevOdometer: created ? created.prevOdometer : null,
    consumption: created ? created.consumption : null,
    costPerKm: created ? created.costPerKm : null
  }
}

async function getRecord(openid, payload) {
  const id = String(payload._id || '')
  if (!id) badRequest('缺少记录 ID')

  const res = await db.collection(RECORDS).doc(id).get().catch(() => null)
  if (!res || !res.data) forbidden('记录不存在')
  if (res.data._openid !== openid) forbidden('无权限查看该记录')

  return { record: toEditableRecord(res.data) }
}

async function updateRecord(openid, payload) {
  const id = String(payload._id || '')
  if (!id) badRequest('缺少记录 ID')

  const existing = await db.collection(RECORDS).doc(id).get().catch(() => null)
  if (!existing || !existing.data) forbidden('记录不存在')
  if (existing.data._openid !== openid) forbidden('无权限修改该记录')

  const record = normalizeRecord(payload)
  await db.collection(RECORDS).doc(id).update({
    data: Object.assign({}, record, { updatedAt: db.serverDate() })
  })

  return { _id: id }
}

async function listRecords(openid, payload) {
  const month = String(payload.month || '')
  if (!MONTH_RE.test(month)) badRequest('月份格式不正确')

  const all = computeRecords(await fetchRecords(openid))
  const monthly = all.filter((record) => record.date.slice(0, 7) === month)
  const vehicle = await getVehicle(openid)

  return {
    month,
    vehicle: toClientVehicle(vehicle),
    summary: summarize(monthly),
    records: monthly.map(toClientRecord)
  }
}

async function getStats(openid, payload) {
  const months = Number(payload.months)
  const wanted = Number.isFinite(months) && months > 0 ? Math.min(Math.floor(months), 24) : 0

  const all = computeRecords(await fetchRecords(openid))
  const currentMonth = chinaMonth()

  const keys = wanted
    ? recentMonthKeys(wanted)
    : Array.from(new Set(all.map((record) => record.date.slice(0, 7)))).sort()

  const monthSet = new Set(keys)
  const inRange = all.filter((record) => monthSet.has(record.date.slice(0, 7)))

  const monthly = keys.map((month) => {
    const records = inRange.filter((record) => record.date.slice(0, 7) === month)
    const summary = summarize(records)
    return Object.assign({ month }, summary)
  })

  const byType = {}
  CHARGE_TYPES.forEach((type) => {
    byType[type] = { kwh: 0, fee: 0 }
  })
  inRange.forEach((record) => {
    const bucket = byType[record.chargeType] || byType.none
    bucket.kwh += Number(record.chargeKwh) || 0
    bucket.fee += Number(record.chargeFee) || 0
  })
  CHARGE_TYPES.forEach((type) => {
    byType[type].kwh = round(byType[type].kwh, 1)
    byType[type].fee = round(byType[type].fee, 2)
  })

  return {
    currentMonth,
    months: monthly,
    totals: summarize(inRange),
    byType
  }
}

async function deleteRecord(openid, payload) {
  const id = String(payload._id || '')
  if (!id) badRequest('缺少记录 ID')

  const existing = await db.collection(RECORDS).doc(id).get().catch(() => null)
  if (!existing || !existing.data) forbidden('记录不存在')
  if (existing.data._openid !== openid) forbidden('无权限删除该记录')

  await db.collection(RECORDS).doc(id).remove()
  return { deleted: true, _id: id }
}

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`)

function normalizeHeader(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[（(].*$/, '')
    .toLowerCase()
}

function resolveColumns(headers) {
  const normalized = headers.map(normalizeHeader)
  const columns = {}

  Object.keys(HEADER_ALIASES).forEach((field) => {
    const index = normalized.findIndex((header) => HEADER_ALIASES[field].includes(header))
    if (index >= 0) columns[field] = index
  })

  return columns
}

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 20)
  for (let i = 0; i < limit; i += 1) {
    const columns = resolveColumns(rows[i] || [])
    const matched = ['date', 'odometer', 'chargeKwh', 'chargeFee']
      .filter((field) => columns[field] !== undefined).length
    if (matched >= 2) return { index: i, columns }
  }
  return null
}

function validYmd(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false
  const check = new Date(Date.UTC(year, month - 1, day))
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  )
}

function buildChinaDate(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second))
}

function parseDateTime(value) {
  if (value instanceof Date) {
    const year = value.getFullYear()
    const month = value.getMonth() + 1
    const day = value.getDate()
    if (!validYmd(year, month, day)) return null
    return {
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      occurredAt: buildChinaDate(
        year,
        month,
        day,
        value.getHours(),
        value.getMinutes(),
        value.getSeconds()
      )
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed || !validYmd(parsed.y, parsed.m, parsed.d)) return null
    return {
      date: `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`,
      occurredAt: buildChinaDate(
        parsed.y,
        parsed.m,
        parsed.d,
        parsed.H || 0,
        parsed.M || 0,
        Math.floor(parsed.S || 0)
      )
    }
  }

  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!validYmd(year, month, day)) return null

  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    occurredAt: buildChinaDate(
      year,
      month,
      day,
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    )
  }
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const text = String(value || '').replace(/[,\s]/g, '')
  if (!text) return NaN
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

function inferChargeType(note, fallback) {
  const text = String(note || '')
  if (/换电/.test(text)) return 'swap'
  if (/家充|家冲/.test(text)) return 'home'
  if (/超充|快充|充电站|充电桩/.test(text)) return 'fast'
  return fallback
}

async function importRecords(openid, payload) {
  await ensureCollections()
  const vehicle = await ensureVehicle(openid)
  const defaultChargeType = ['home', 'fast', 'swap'].includes(payload.defaultChargeType)
    ? payload.defaultChargeType
    : 'fast'
  const importBatch = payload.importBatch
    ? String(payload.importBatch).slice(0, 64)
    : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`

  let buffer
  if (payload.fileBase64) {
    const base64 = String(payload.fileBase64)
    if (base64.length > 8 * 1024 * 1024) badRequest('文件超过 6MB 限制')
    buffer = Buffer.from(base64, 'base64')
  } else if (payload.fileID) {
    const downloaded = await cloud.downloadFile({ fileID: String(payload.fileID) })
    buffer = downloaded.fileContent
  } else {
    badRequest('缺少导入文件')
  }

  let workbook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  } catch (err) {
    badRequest('无法解析 Excel 文件，请确认是 .xlsx/.xls')
  }

  const sheetName = workbook.SheetNames.includes('充电数据')
    ? '充电数据'
    : workbook.SheetNames[0]
  if (!sheetName) badRequest('Excel 中没有工作表')

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false
  })

  const header = findHeaderRow(rows)
  if (!header) {
    badRequest('未找到表头，请确认包含「充电时间」「总里程」「充电度数」「充电金额」等列')
  }

  const missing = ['date', 'odometer', 'chargeKwh', 'chargeFee']
    .filter((field) => header.columns[field] === undefined)
  if (missing.length) {
    badRequest(`表头缺少必要列：${missing.map((field) => FIELD_LABELS[field]).join('、')}`)
  }

  const existing = await fetchRecords(openid)
  const fingerprints = new Set(
    existing.map((record) => record.importFingerprint).filter(Boolean)
  )

  const today = chinaToday()
  const toInsert = []
  const errors = []
  let totalRows = 0
  let skippedDuplicate = 0

  for (let i = header.index + 1; i < rows.length; i += 1) {
    const row = rows[i] || []
    if (row.every((cell) => String(cell === null || cell === undefined ? '' : cell).trim() === '')) {
      continue
    }
    totalRows += 1
    const rowNumber = i + 1

    const parsedDate = parseDateTime(row[header.columns.date])
    if (!parsedDate) {
      errors.push({ row: rowNumber, message: '充电时间无法解析' })
      continue
    }
    if (parsedDate.date < '2000-01-01' || parsedDate.date > today) {
      errors.push({ row: rowNumber, message: '充电时间超出允许范围' })
      continue
    }

    const odometer = parseNumber(row[header.columns.odometer])
    if (!(odometer > 0 && odometer <= 2000000)) {
      errors.push({ row: rowNumber, message: '总里程无效' })
      continue
    }

    const chargeKwh = parseNumber(row[header.columns.chargeKwh])
    if (!(chargeKwh > 0 && chargeKwh <= 200)) {
      errors.push({ row: rowNumber, message: '充电度数无效' })
      continue
    }

    const chargeFee = parseNumber(row[header.columns.chargeFee])
    if (!(chargeFee >= 0 && chargeFee <= 10000)) {
      errors.push({ row: rowNumber, message: '充电金额无效' })
      continue
    }

    let socStart = header.columns.socStart === undefined
      ? null
      : parseNumber(row[header.columns.socStart])
    let socEnd = header.columns.socEnd === undefined
      ? null
      : parseNumber(row[header.columns.socEnd])

    if (
      !Number.isInteger(socStart) ||
      socStart < 0 ||
      socStart > 100 ||
      !Number.isInteger(socEnd) ||
      socEnd < 0 ||
      socEnd > 100 ||
      socEnd <= socStart
    ) {
      socStart = null
      socEnd = null
    }

    const note = header.columns.note === undefined
      ? ''
      : String(row[header.columns.note] || '').trim().slice(0, 100)
    const rawOdometerType = header.columns.odometerType === undefined
      ? ''
      : String(row[header.columns.odometerType] || '')
    const odometerType = /行程|trip/i.test(rawOdometerType) ? 'trip' : 'total'
    const rawChargeType = header.columns.chargeType === undefined
      ? ''
      : String(row[header.columns.chargeType] || '').trim()
    const chargeTypeMap = { 家充: 'home', 快充: 'fast', 换电: 'swap', 未充电: 'none' }
    const chargeType = chargeTypeMap[rawChargeType] || inferChargeType(note, defaultChargeType)
    const normalizedOdometer = Math.round(odometer * 10) / 10
    const normalizedKwh = Math.round(chargeKwh * 1000) / 1000
    const normalizedFee = Math.round(chargeFee * 100) / 100
    const fingerprint = crypto
      .createHash('sha1')
      .update([
        parsedDate.occurredAt.toISOString(),
        normalizedOdometer,
        normalizedKwh,
        normalizedFee
      ].join('|'))
      .digest('hex')

    if (fingerprints.has(fingerprint)) {
      skippedDuplicate += 1
      continue
    }
    fingerprints.add(fingerprint)

    toInsert.push({
      rowNumber,
      data: {
        _openid: openid,
        vehicleId: vehicle._id,
        date: parsedDate.date,
        odometer: normalizedOdometer,
        odometerType,
        chargeKwh: normalizedKwh,
        chargeFee: normalizedFee,
        chargeType,
        socStart,
        socEnd,
        note,
        createdAt: parsedDate.occurredAt,
        updatedAt: parsedDate.occurredAt,
        source: 'import',
        importFingerprint: fingerprint,
        importBatch
      }
    })
  }

  let imported = 0
  const insertedIds = []
  const batchSize = 10
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const res = await db.collection(RECORDS).add({ data: item.data })
        insertedIds.push(res._id)
        return true
      } catch (err) {
        errors.push({ row: item.rowNumber, message: `写入失败：${err.message || '未知错误'}` })
        return false
      }
    }))
    imported += results.filter(Boolean).length
  }

  return {
    sheetName,
    totalRows,
    imported,
    skippedDuplicate,
    skippedInvalid: errors.length,
    errors: errors.slice(0, 20),
    insertedIds,
    importBatch
  }
}

async function deleteImportBatch(openid, payload) {
  const importBatch = String(payload.importBatch || '')
  if (!importBatch) badRequest('缺少导入批次')

  let deleted = 0
  while (true) {
    const res = await db
      .collection(RECORDS)
      .where({ _openid: openid, importBatch })
      .remove()
    const removed = (res.stats && res.stats.removed) || 0
    deleted += removed
    if (!removed) break
  }

  return { deleted, importBatch }
}

async function recognizeMileage(openid, payload) {
  const params = { type: 'photo' }
  let temporaryFileID = ''

  try {
    if (payload.imageBase64) {
      const base64 = String(payload.imageBase64)
      if (base64.length > 8 * 1024 * 1024) badRequest('图片超过 6MB 限制')

      const upload = await cloud.uploadFile({
        cloudPath: `ocr/temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
        fileContent: Buffer.from(base64, 'base64')
      })
      temporaryFileID = upload.fileID

      const temp = await cloud.getTempFileURL({ fileList: [temporaryFileID] })
      const file = temp.fileList && temp.fileList[0]
      if (!file || !file.tempFileURL) badRequest('图片地址获取失败')
      params.imgUrl = file.tempFileURL
    } else if (payload.fileID) {
      const temp = await cloud.getTempFileURL({ fileList: [String(payload.fileID)] })
      const file = temp.fileList && temp.fileList[0]
      if (!file || !file.tempFileURL) badRequest('图片地址获取失败')
      params.imgUrl = file.tempFileURL
    } else {
      badRequest('缺少图片')
    }

    let result
    try {
      result = await cloud.openapi.ocr.printedText(params)
    } catch (err) {
      const message = String((err && (err.errMsg || err.message)) || '')
      if (/permission|scope|auth|未授权|权限/i.test(message)) {
        badRequest('OCR 能力未开通或没有权限，请手动输入里程')
      }
      if (/quota|limit|额度/i.test(message)) {
        badRequest('OCR 今日额度已用完，请手动输入里程')
      }
      throw err
    }

    const items = result.items || []
    return {
      candidates: extractMileageCandidates(items),
      rawText: items.map((item) => item.text).filter(Boolean).join(' ')
    }
  } finally {
    if (temporaryFileID) {
      await cloud.deleteFile({ fileList: [temporaryFileID] }).catch(() => {})
    }
  }
}

function chinaDateTimeString(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const china = new Date(date.getTime() + CHINA_OFFSET)
  return `${china.getUTCFullYear()}-${pad2(china.getUTCMonth() + 1)}-${pad2(china.getUTCDate())} ${pad2(china.getUTCHours())}:${pad2(china.getUTCMinutes())}`
}

function formatExportTime(record) {
  if (record.source === 'import' && record.createdAt) {
    const full = chinaDateTimeString(record.createdAt)
    if (full) return full
  }
  return record.date
}

async function exportRecords(openid, payload) {
  const month = payload.month ? String(payload.month) : ''
  if (month && !MONTH_RE.test(month)) badRequest('月份格式不正确')

  const all = sortRecords(await fetchRecords(openid))
  const records = month ? all.filter((record) => record.date.slice(0, 7) === month) : all
  if (!records.length) badRequest('所选范围没有可导出的记录')

  const chargeTypeLabels = {
    home: '家充',
    fast: '快充',
    swap: '换电',
    none: '未充电'
  }

  const rows = [
    ['能耗账本 - 充电数据'],
    [
      '充电时间', '总里程(公里)', '里程类型', '充电类型', '充电前电量(%)',
      '充电后电量(%)', '充电度数(度)', '车端电量(度)', '充电金额(元)',
      '电费单价(元/度)', '备注'
    ]
  ]

  records.forEach((record) => {
    const kwh = Number(record.chargeKwh) || 0
    const fee = Number(record.chargeFee) || 0
    const unitPrice = kwh > 0 ? Number((fee / kwh).toFixed(4)) : ''

    rows.push([
      formatExportTime(record),
      Number(record.odometer),
      record.odometerType === 'trip' ? '行程' : '总里程',
      chargeTypeLabels[record.chargeType] || '未充电',
      record.socStart === null || record.socStart === undefined ? '' : record.socStart,
      record.socEnd === null || record.socEnd === undefined ? '' : record.socEnd,
      Math.round(kwh * 1000) / 1000,
      0,
      Math.round(fee * 100) / 100,
      unitPrice,
      record.note || ''
    ])
  })

  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!cols'] = [
    { wch: 20 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 36 }
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '充电数据')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })

  const fileName = month
    ? `能耗账本-${month}.xlsx`
    : `能耗账本-全部-${chinaToday()}.xlsx`

  if (payload.returnBase64) {
    return { count: records.length, fileName, base64: buffer.toString('base64') }
  }

  const upload = await cloud.uploadFile({
    cloudPath: `exports/ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`,
    fileContent: buffer
  })

  return { fileID: upload.fileID, count: records.length, fileName }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return fail(401, '无法识别用户身份')

  const action = event.action
  const payload = event.payload || {}

  try {
    switch (action) {
      case 'setup': {
        await ensureCollections()
        const vehicle = await ensureVehicle(OPENID)
        return ok({ vehicle: toClientVehicle(vehicle) })
      }
      case 'ensureVehicle':
        return ok({ vehicle: toClientVehicle(await ensureVehicle(OPENID)) })
      case 'addRecord':
        return ok(await addRecord(OPENID, payload))
      case 'getRecord':
        return ok(await getRecord(OPENID, payload))
      case 'updateRecord':
        return ok(await updateRecord(OPENID, payload))
      case 'importRecords':
        return ok(await importRecords(OPENID, payload))
      case 'deleteImportBatch':
        return ok(await deleteImportBatch(OPENID, payload))
      case 'recognizeMileage':
        return ok(await recognizeMileage(OPENID, payload))
      case 'exportRecords':
        return ok(await exportRecords(OPENID, payload))
      case 'listRecords':
        return ok(await listRecords(OPENID, payload))
      case 'getStats':
        return ok(await getStats(OPENID, payload))
      case 'deleteRecord':
        return ok(await deleteRecord(OPENID, payload))
      default:
        return fail(400, '未知操作')
    }
  } catch (err) {
    const code = err && err.code ? err.code : 500
    return fail(code, (err && err.message) || '服务异常')
  }
}
