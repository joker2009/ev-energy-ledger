import * as echarts from '../../components/ec-canvas/echarts'

const ledger = require('../../utils/ledger')

const RANGE_SIX = 6
const RANGE_YEAR = 'year'
const RANGE_ALL = 0

const TYPE_META = [
  { key: 'home', name: '家充', color: '#00a870' },
  { key: 'fast', name: '快充', color: '#ed7b2f' },
  { key: 'swap', name: '换电', color: '#0052d9' },
  { key: 'none', name: '未充电', color: '#9ca3af' }
]

const trimNumber = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (Number.isInteger(num)) return String(num)
  return num.toFixed(1).replace(/\.0$/, '')
}

const monthLabel = (month, withYear) => {
  const year = month.slice(0, 4)
  const value = Number(month.slice(5, 7))
  return withYear ? `${year}/${value}` : `${value}月`
}

const lineOption = (labels, values, color, areaColor) => ({
  animationDuration: 300,
  grid: { top: 16, left: 8, right: 20, bottom: 8, containLabel: true },
  tooltip: { trigger: 'axis', confine: true },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: labels,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: '#e5e7eb' } },
    axisLabel: { color: '#9ca3af', fontSize: 10 }
  },
  yAxis: {
    type: 'value',
    splitLine: { lineStyle: { color: '#f0f1f3', type: 'dashed' } },
    axisLabel: { color: '#9ca3af', fontSize: 10 }
  },
  series: [{
    type: 'line',
    data: values,
    smooth: true,
    symbol: 'circle',
    symbolSize: 5,
    connectNulls: false,
    lineStyle: { color, width: 2 },
    itemStyle: { color },
    areaStyle: { color: areaColor }
  }]
})

const pieOption = (typeData) => ({
  animationDuration: 300,
  tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)', confine: true },
  legend: {
    bottom: 0,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: '#6b7280', fontSize: 11 }
  },
  series: [{
    type: 'pie',
    radius: ['46%', '68%'],
    center: ['50%', '44%'],
    avoidLabelOverlap: true,
    label: { show: false },
    labelLine: { show: false },
    data: typeData
  }]
})

Page({
  data: {
    range: RANGE_SIX,
    rangeLabel: '近6个月',
    currentMonth: '',
    availableYears: [],
    year: '',
    yearLabel: '',
    yearIndex: -1,
    metrics: {
      consumption: '—',
      costPerKm: '—',
      distance: '—'
    },
    totalsView: {
      fee: '¥0.00',
      kwh: '0.0',
      count: '0'
    },
    hasConsumption: false,
    hasCost: false,
    hasTypeFee: false,
    hasChartData: false,
    loading: true,
    error: '',
    ecConsumption: { lazyLoad: true },
    ecCost: { lazyLoad: true },
    ecType: { lazyLoad: true }
  },

  charts: {},
  pending: {},
  statsData: null,
  requestId: 0,
  pageReady: false,

  onReady() {
    this.pageReady = true
    this.renderCharts()
  },

  onUnload() {
    this.disposeCharts()
  },

  disposeCharts() {
    Object.keys(this.charts).forEach((key) => {
      const chart = this.charts[key]
      if (chart && chart.dispose) chart.dispose()
    })
    this.charts = {}
    this.pending = {}
  },

  onShow() {
    this.load()
  },

  onRangeChange(e) {
    const raw = e.currentTarget.dataset.value
    const range = raw === 'year' ? RANGE_YEAR : Number(raw)
    if (range === this.data.range) return

    const patch = { range }

    if (range === RANGE_YEAR) {
      const currentYear =
        (this.data.currentMonth || '').slice(0, 4) ||
        String(new Date().getFullYear())
      let year = this.data.year

      if (!year || !this.data.availableYears.includes(year)) {
        year = this.data.availableYears.includes(currentYear)
          ? currentYear
          : (this.data.availableYears[0] || currentYear)
      }

      patch.year = year
      patch.yearLabel = `${year}年`
      patch.yearIndex = this.data.availableYears.indexOf(year)
    }

    this.setData(patch, () => this.load())
  },

  onYearPrev() {
    const index = this.data.yearIndex
    if (index < 0 || index >= this.data.availableYears.length - 1) return
    const year = this.data.availableYears[index + 1]
    this.setData({
      year,
      yearLabel: `${year}年`,
      yearIndex: index + 1
    })
    this.load()
  },

  onYearNext() {
    const index = this.data.yearIndex
    if (index <= 0) return
    const year = this.data.availableYears[index - 1]
    this.setData({
      year,
      yearLabel: `${year}年`,
      yearIndex: index - 1
    })
    this.load()
  },

  async load() {
    const requestId = this.requestId + 1
    this.requestId = requestId
    this.setData({ loading: true, error: '' })

    try {
      const isYear = this.data.range === RANGE_YEAR
      const payload = isYear
        ? { year: Number(this.data.year) }
        : { months: Number(this.data.range) }

      const data = await ledger.getStats(payload)
      if (requestId !== this.requestId) return

      this.statsData = data
      const months = data.months || []
      const availableYears = data.availableYears || []
      let year = this.data.year

      if (isYear && (!year || !availableYears.includes(year))) {
        const currentYear =
          (data.currentMonth || '').slice(0, 4) ||
          String(new Date().getFullYear())
        year = availableYears.includes(currentYear)
          ? currentYear
          : (availableYears[0] || currentYear)
      }

      const byType = data.byType || {}
      const hasConsumption = months.some(
        (item) => item.consumption !== null && item.consumption !== undefined
      )
      const hasCost = months.some(
        (item) => item.costPerKm !== null && item.costPerKm !== undefined
      )
      const hasTypeFee = TYPE_META.some(
        (meta) => byType[meta.key] && byType[meta.key].fee > 0
      )

      this.setData({
        currentMonth: data.currentMonth || '',
        availableYears,
        year,
        yearLabel: year ? `${year}年` : '',
        yearIndex: availableYears.indexOf(year),
        metrics: this.formatMetrics(data.totals || {}),
        totalsView: this.formatTotals(data.totals || {}),
        hasConsumption,
        hasCost,
        hasTypeFee,
        hasChartData: hasConsumption || hasCost || hasTypeFee,
        loading: false
      }, () => {
        if (this.pageReady) wx.nextTick(() => this.renderCharts())
      })
    } catch (err) {
      if (requestId !== this.requestId) return
      this.disposeCharts()
      this.statsData = null
      this.setData({
        metrics: { consumption: '—', costPerKm: '—', distance: '—' },
        totalsView: { fee: '¥0.00', kwh: '0.0', count: '0' },
        hasConsumption: false,
        hasCost: false,
        hasTypeFee: false,
        hasChartData: false,
        loading: false,
        error: err.message || '加载失败，请重试'
      })
    }
  },

  formatMetrics(totals) {
    return {
      consumption: totals.consumption === null || totals.consumption === undefined
        ? '—'
        : Number(totals.consumption).toFixed(1),
      costPerKm: totals.costPerKm === null || totals.costPerKm === undefined
        ? '—'
        : Number(totals.costPerKm).toFixed(2),
      distance: totals.distanceKm ? trimNumber(totals.distanceKm) : '—'
    }
  },

  formatTotals(totals) {
    return {
      fee: `¥${Number(totals.fee || 0).toFixed(2)}`,
      kwh: Number(totals.chargeKwh || 0).toFixed(1),
      count: String(totals.recordCount || 0)
    }
  },

  buildOptions(data) {
    const months = data.months || []
    const labels = months.map((item) =>
      monthLabel(item.month, this.data.range === RANGE_ALL)
    )
    const consumptionValues = months.map((item) =>
      item.consumption === null || item.consumption === undefined ? null : item.consumption
    )
    const costValues = months.map((item) =>
      item.costPerKm === null || item.costPerKm === undefined ? null : item.costPerKm
    )

    const byType = data.byType || {}
    const typeData = TYPE_META
      .map((meta) => ({
        name: meta.name,
        value: Number((byType[meta.key] && byType[meta.key].fee) || 0),
        itemStyle: { color: meta.color }
      }))
      .filter((item) => item.value > 0)

    return {
      consumption: lineOption(labels, consumptionValues, '#00a870', 'rgba(0, 168, 112, 0.08)'),
      cost: lineOption(labels, costValues, '#ed7b2f', 'rgba(237, 123, 47, 0.09)'),
      type: pieOption(typeData)
    }
  },

  renderCharts() {
    if (!this.pageReady || !this.statsData) return
    const options = this.buildOptions(this.statsData)
    this.mountChart('consumption', '#consumption-chart', options.consumption, this.data.hasConsumption)
    this.mountChart('cost', '#cost-chart', options.cost, this.data.hasCost)
    this.mountChart('type', '#type-chart', options.type, this.data.hasTypeFee)
  },

  mountChart(key, selector, option, visible) {
    if (!visible) {
      this.pending[key] = false
      if (this.charts[key]) {
        this.charts[key].dispose()
        delete this.charts[key]
      }
      return
    }

    const component = this.selectComponent(selector)
    if (!component || this.pending[key]) return

    if (this.charts[key]) {
      this.charts[key].setOption(option, true)
      return
    }

    this.pending[key] = true
    component.init((canvas, width, height, dpr) => {
      const chart = echarts.init(canvas, null, {
        width,
        height,
        devicePixelRatio: dpr
      })
      canvas.setChart(chart)
      chart.setOption(option)
      this.charts[key] = chart
      this.pending[key] = false
      return chart
    })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add/index' })
  }
})
