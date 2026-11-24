const ledger = require('../../utils/ledger')

const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

const SCOPE_OPTIONS = [
  { label: '全部记录', value: 'all' },
  { label: '指定月份', value: 'month' }
]

const monthLabelOf = (value) => {
  const [year, month] = value.split('-')
  return `${year}年${Number(month)}月`
}

Page({
  data: {
    scope: 'all',
    scopeOptions: SCOPE_OPTIONS,
    monthValue: '',
    monthLabel: '',
    maxMonth: '',
    exporting: false,
    result: null,
    error: ''
  },

  onLoad() {
    const now = new Date()
    const value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
    this.setData({
      monthValue: value,
      monthLabel: monthLabelOf(value),
      maxMonth: value
    })
  },

  onScopeChange(e) {
    this.setData({
      scope: e.detail.value,
      result: null,
      error: ''
    })
  },

  onMonthChange(e) {
    const value = e.detail.value.slice(0, 7)
    this.setData({
      monthValue: value,
      monthLabel: monthLabelOf(value),
      result: null
    })
  },

  async onExport() {
    if (this.data.exporting) return

    this.setData({ exporting: true, result: null, error: '' })
    let fileID = ''

    try {
      const exported = await ledger.exportRecords({
        month: this.data.scope === 'month' ? this.data.monthValue : ''
      })
      fileID = exported.fileID

      const download = await wx.cloud.downloadFile({ fileID })
      wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      fileID = ''

      this.setData({
        exporting: false,
        result: {
          count: exported.count,
          fileName: exported.fileName,
          filePath: download.tempFilePath
        }
      })
      wx.showToast({ title: `已导出 ${exported.count} 条`, icon: 'success' })
    } catch (err) {
      this.setData({
        exporting: false,
        error: err.message || '导出失败，请重试'
      })
      if (fileID) {
        wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      }
    }
  },

  openFile() {
    const result = this.data.result
    if (!result || !result.filePath) return

    wx.openDocument({
      filePath: result.filePath,
      fileType: 'xlsx',
      showMenu: true,
      fail: () => wx.showToast({ title: '打开失败，请重试', icon: 'none' })
    })
  },

  shareFile() {
    const result = this.data.result
    if (!result || !result.filePath) return

    if (typeof wx.shareFileMessage !== 'function') {
      this.openFile()
      return
    }

    wx.shareFileMessage({
      filePath: result.filePath,
      fileName: result.fileName,
      fail: (err) => {
        if (!/cancel/i.test((err && err.errMsg) || '')) {
          wx.showToast({ title: '发送失败，请重试', icon: 'none' })
        }
      }
    })
  }
})
