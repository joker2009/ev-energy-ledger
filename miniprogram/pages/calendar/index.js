const ledger = require('../../utils/ledger')

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAYS_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const TYPE_LABELS = {
  home: '家充',
  fast: '快充',
  swap: '换电',
  none: '未充电'
}

const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

const toMonthValue = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`

const toMonthLabel = (value) => {
  const [year, month] = value.split('-')
  return `${year}年${Number(month)}月`
}

const todayString = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const dateValue = (year, month, day) => {
  const date = new Date(year, month - 1, day)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const dateLabel = (value) => {
  const [year, month, day] = value.split('-').map(Number)
  return `${month}月${day}日 ${WEEKDAYS_FULL[new Date(year, month - 1, day).getDay()]}`
}

const trimNumber = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (Number.isInteger(num)) return String(num)
  return num.toFixed(1).replace(/\.0$/, '')
}

function buildCalendar(year, month, recordDates, today) {
  const first = new Date(year, month - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const prevDays = new Date(year, month - 1, 0).getDate()
  const cells = []

  for (let i = offset - 1; i >= 0; i -= 1) {
    const day = prevDays - i
    cells.push({
      day,
      date: dateValue(year, month - 1, day),
      inMonth: false,
      hasRecord: false,
      isToday: false
    })
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = dateValue(year, month, day)
    cells.push({
      day,
      date,
      inMonth: true,
      hasRecord: Boolean(recordDates[date]),
      isToday: date === today
    })
  }

  let nextDay = 1
  while (cells.length < 42) {
    cells.push({
      day: nextDay,
      date: dateValue(year, month + 1, nextDay),
      inMonth: false,
      hasRecord: false,
      isToday: false
    })
    nextDay += 1
  }

  return cells
}

Page({
  data: {
    monthValue: '',
    monthLabel: '',
    maxMonth: '',
    isCurrentMonth: true,
    weekdays: WEEKDAYS,
    days: [],
    summary: { count: '0', kwh: '0.0', fee: '¥0.00' },
    selectedDate: '',
    selectedDateLabel: '',
    selectedRecords: [],
    selectedSummary: { count: 0, kwh: '0.0', fee: '¥0.00' },
    loading: true,
    error: ''
  },

  requestId: 0,
  rawByDate: {},
  formattedByDate: {},

  onLoad() {
    const now = new Date()
    this.setData({ maxMonth: toMonthValue(now) })
    this.setMonth(now)
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  setMonth(date, shouldLoad) {
    const value = toMonthValue(date)
    const current = toMonthValue(new Date())
    this.setData({
      monthValue: value,
      monthLabel: toMonthLabel(value),
      isCurrentMonth: value >= current,
      selectedDate: '',
      selectedDateLabel: '',
      selectedRecords: [],
      selectedSummary: { count: 0, kwh: '0.0', fee: '¥0.00' }
    })
    if (shouldLoad) this.load()
  },

  shiftMonth(delta) {
    const [year, month] = this.data.monthValue.split('-').map(Number)
    const next = new Date(year, month - 1 + delta, 1)
    if (toMonthValue(next) > this.data.maxMonth) return
    this.setMonth(next, true)
  },

  onPrevMonth() {
    this.shiftMonth(-1)
  },

  onNextMonth() {
    if (this.data.isCurrentMonth) return
    this.shiftMonth(1)
  },

  onMonthChange(e) {
    const [year, month] = e.detail.value.slice(0, 7).split('-').map(Number)
    this.setMonth(new Date(year, month - 1, 1), true)
  },

  async load() {
    const requestId = this.requestId + 1
    this.requestId = requestId
    this.setData({ loading: true, error: '' })

    try {
      const data = await ledger.listRecords(this.data.monthValue)
      if (requestId !== this.requestId) return

      const records = data.records || []
      const [year, month] = this.data.monthValue.split('-').map(Number)
      const today = todayString()
      const recordDates = {}
      const rawByDate = {}
      const formattedByDate = {}

      records.forEach((record) => {
        recordDates[record.date] = true
        if (!rawByDate[record.date]) rawByDate[record.date] = []
        if (!formattedByDate[record.date]) formattedByDate[record.date] = []
        rawByDate[record.date].push(record)
        formattedByDate[record.date].push(this.formatRecord(record))
      })

      this.rawByDate = rawByDate
      this.formattedByDate = formattedByDate

      let selectedDate = this.data.selectedDate
      if (!selectedDate || selectedDate.slice(0, 7) !== this.data.monthValue) {
        selectedDate = this.pickInitialDate(year, month, recordDates, today)
      }
      const detail = this.dayDetail(selectedDate)

      this.setData({
        days: buildCalendar(year, month, recordDates, today),
        summary: this.formatSummary(data.summary),
        selectedDate,
        selectedDateLabel: dateLabel(selectedDate),
        selectedRecords: detail.records,
        selectedSummary: detail.summary,
        loading: false
      })
    } catch (err) {
      if (requestId !== this.requestId) return
      this.rawByDate = {}
      this.formattedByDate = {}
      this.setData({
        days: [],
        summary: { count: '0', kwh: '0.0', fee: '¥0.00' },
        selectedDate: '',
        selectedDateLabel: '',
        selectedRecords: [],
        selectedSummary: { count: 0, kwh: '0.0', fee: '¥0.00' },
        loading: false,
        error: err.message || '加载失败，请重试'
      })
    }
  },

  pickInitialDate(year, month, recordDates, today) {
    const prefix = `${year}-${pad(month)}`
    if (today.slice(0, 7) === prefix) return today
    const dates = Object.keys(recordDates).filter((date) => date.startsWith(prefix)).sort()
    return dates.length ? dates[dates.length - 1] : `${prefix}-01`
  },

  formatSummary(summary) {
    const count = summary && summary.recordCount ? summary.recordCount : 0
    return {
      count: String(count),
      kwh: Number((summary && summary.chargeKwh) || 0).toFixed(1),
      fee: `¥${Number((summary && summary.fee) || 0).toFixed(2)}`
    }
  },

  dayDetail(date) {
    const raw = this.rawByDate[date] || []
    const records = this.formattedByDate[date] || []
    const kwh = raw.reduce((sum, record) => sum + (Number(record.chargeKwh) || 0), 0)
    const fee = raw.reduce((sum, record) => sum + (Number(record.chargeFee) || 0), 0)
    return {
      records,
      summary: {
        count: raw.length,
        kwh: kwh.toFixed(1),
        fee: `¥${fee.toFixed(2)}`
      }
    }
  },

  formatRecord(record) {
    const charging = record.chargeType !== 'none'
    let segmentText = ''

    if (record.segmentKm) {
      segmentText = `本段 ${trimNumber(record.segmentKm)} km`
    } else if (record.prevOdometer === null || record.prevOdometer === undefined) {
      segmentText = '首条记录，无本段数据'
    } else {
      segmentText = '本段里程异常'
    }

    return {
      _id: record._id,
      typeLabel: TYPE_LABELS[record.chargeType] || '未知',
      typeClass: record.chargeType || 'none',
      kwhText: charging ? `${Number(record.chargeKwh || 0).toFixed(1)} kWh` : '未充电',
      feeText: `¥${Number(record.chargeFee || 0).toFixed(2)}`,
      odoText: record.odometerType === 'trip'
        ? `行程 ${trimNumber(record.odometer)} km`
        : `读数 ${trimNumber(record.odometer)} km`,
      segmentText,
      consumptionText: record.consumption === null || record.consumption === undefined
        ? ''
        : `本段电耗 ${Number(record.consumption).toFixed(1)} kWh/100km`,
      costText: record.costPerKm === null || record.costPerKm === undefined
        ? ''
        : `本段 ¥${Number(record.costPerKm).toFixed(2)}/km`
    }
  },

  onDayTap(e) {
    if (Number(e.currentTarget.dataset.inMonth) !== 1) return
    const date = e.currentTarget.dataset.date
    if (!date) return

    const detail = this.dayDetail(date)
    this.setData({
      selectedDate: date,
      selectedDateLabel: dateLabel(date),
      selectedRecords: detail.records,
      selectedSummary: detail.summary
    })
  },

  onRecordTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/add/index?id=${id}` })
  }
})
