const ledger = require('../../utils/ledger')

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const TYPE_LABELS = {
  home: '家充',
  fast: '快充',
  swap: '换电',
  none: '未充电'
}

const EMPTY_SUMMARY = () => ({
  distance: '—',
  consumption: '—',
  fee: '—'
})

const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

const toMonthValue = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`

const toMonthLabel = (value) => {
  const [year, month] = value.split('-')
  return `${year}年${Number(month)}月`
}

const trimNumber = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (Number.isInteger(num)) return String(num)
  return num.toFixed(1).replace(/\.0$/, '')
}

const dateLabel = (value) => {
  const [year, month, day] = value.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()]
  return `${month}月${day}日 ${weekday}`
}

const toTime = (value) => {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

Page({
  data: {
    monthValue: '',
    monthLabel: '',
    maxMonth: '',
    isCurrentMonth: true,
    vehicleName: '',
    summary: EMPTY_SUMMARY(),
    groups: [],
    recordCount: 0,
    loading: true,
    error: '',
    swipeActions: [
      {
        text: '删除',
        icon: { name: 'delete', size: '36rpx' },
        className: 'swipe-delete',
        style:
          'width: 128rpx; height: calc(100% - 16rpx); margin: 8rpx 12rpx 8rpx 0; padding: 0; border-radius: 20rpx; background: #fff1f0; color: #d54941;'
      }
    ]
  },

  requestId: 0,
  rawRecords: [],

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
      isCurrentMonth: value >= current
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

      this.rawRecords = data.records || []
      this.setData({
        vehicleName: (data.vehicle && data.vehicle.name) || '',
        summary: this.formatSummary(data.summary),
        groups: this.formatGroups(this.rawRecords),
        recordCount: this.rawRecords.length,
        loading: false
      })
    } catch (err) {
      if (requestId !== this.requestId) return
      this.rawRecords = []
      this.setData({
        summary: EMPTY_SUMMARY(),
        groups: [],
        recordCount: 0,
        loading: false,
        error: err.message || '加载失败，请重试'
      })
    }
  },

  formatSummary(summary) {
    if (!summary || !summary.recordCount) return EMPTY_SUMMARY()
    return {
      distance: summary.distanceKm > 0 ? `${trimNumber(summary.distanceKm)} km` : '—',
      consumption: summary.consumption === null || summary.consumption === undefined
        ? '—'
        : Number(summary.consumption).toFixed(1),
      fee: `¥${Number(summary.fee || 0).toFixed(2)}`
    }
  },

  formatGroups(records) {
    const sorted = records.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return toTime(b.createdAt) - toTime(a.createdAt)
    })

    const groups = []
    sorted.forEach((record) => {
      let group = groups[groups.length - 1]
      if (!group || group.date !== record.date) {
        group = { date: record.date, label: dateLabel(record.date), records: [] }
        groups.push(group)
      }
      group.records.push(this.formatRecord(record))
    })
    return groups
  },

  formatRecord(record) {
    const charging = record.chargeType !== 'none'
    let segmentText = ''

    if (record.segmentKm) {
      segmentText = `本段 ${trimNumber(record.segmentKm)} km`
    } else if (record.prevOdometer === null || record.prevOdometer === undefined) {
      segmentText = '首条记录，无本段数据'
    } else {
      segmentText = '本段里程异常，不计入统计'
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

  onEdit(e) {
    const id = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : ''
    if (!id) return
    wx.navigateTo({ url: `/pages/add/index?id=${id}` })
  },

  onSwipeClick(e) {    const id = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : ''
    if (!id) return

    const record = this.rawRecords.find((item) => item._id === id)
    wx.showModal({
      title: '删除记录',
      content: record
        ? `确定删除 ${record.date} 的这条记录吗？删除后不可恢复。`
        : '删除后不可恢复，确定继续？',
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (res.confirm) this.deleteRecord(id)
      }
    })
  },

  async deleteRecord(id) {
    wx.showLoading({ title: '删除中', mask: true })
    try {
      await ledger.deleteRecord(id)
      wx.hideLoading()
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '删除失败', icon: 'none' })
    }
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add/index' })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/index' })
  },

  goExport() {
    wx.navigateTo({ url: '/pages/export/index' })
  }
})
