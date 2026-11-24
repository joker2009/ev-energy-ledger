const ledger = require('../../utils/ledger')

const TYPE_OPTIONS = [
  { label: '快充', value: 'fast' },
  { label: '家充', value: 'home' },
  { label: '换电', value: 'swap' }
]

Page({
  data: {
    file: null,
    fileSizeText: '',
    defaultType: 'fast',
    typeOptions: TYPE_OPTIONS,
    importing: false,
    result: null,
    error: ''
  },

  onChooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) {
          wx.showToast({ title: '文件不能超过 5MB', icon: 'none' })
          return
        }
        this.setData({
          file: { path: file.path, name: file.name, size: file.size },
          fileSizeText: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          result: null,
          error: ''
        })
      },
      fail: (err) => {
        if (err && /cancel/.test(err.errMsg || '')) return
        wx.showToast({ title: '选择文件失败', icon: 'none' })
      }
    })
  },

  onTypeChange(e) {
    this.setData({ defaultType: e.detail.value })
  },

  async onImport() {
    if (!this.data.file) {
      wx.showToast({ title: '请先选择 Excel 文件', icon: 'none' })
      return
    }
    if (this.data.importing) return

    this.setData({ importing: true, result: null, error: '' })
    let fileID = ''

    try {
      const upload = await wx.cloud.uploadFile({
        cloudPath: `imports/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`,
        filePath: this.data.file.path
      })
      fileID = upload.fileID

      const result = await ledger.importRecords({
        fileID,
        defaultChargeType: this.data.defaultType
      })
      this.setData({ importing: false, result })
      wx.showToast({
        title: result.imported > 0 ? `导入 ${result.imported} 条` : '没有新增记录',
        icon: result.imported > 0 ? 'success' : 'none'
      })
    } catch (err) {
      this.setData({
        importing: false,
        error: err.message || '导入失败，请检查文件格式'
      })
    } finally {
      if (fileID) {
        wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      }
    }
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
