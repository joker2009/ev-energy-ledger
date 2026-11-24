const call = (action, payload = {}) =>
  new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'ledger',
      data: { action, payload },
      success: (res) => {
        const result = res.result || {}
        if (result.code === 0) {
          resolve(result.data)
          return
        }
        reject(new Error(result.message || '服务异常'))
      },
      fail: (err) => {
        reject(new Error((err && err.errMsg) || '网络异常，请稍后重试'))
      }
    })
  })

module.exports = {
  call,
  setup: () => call('setup'),
  ensureVehicle: () => call('ensureVehicle'),
  addRecord: (payload) => call('addRecord', payload),
  getRecord: (_id) => call('getRecord', { _id }),
  updateRecord: (_id, payload) => call('updateRecord', Object.assign({ _id }, payload)),
  importRecords: (payload) => call('importRecords', payload),
  deleteImportBatch: (importBatch) => call('deleteImportBatch', { importBatch }),
  recognizeChargeOrder: (payload) => call('recognizeChargeOrder', payload),
  exportRecords: (payload) => call('exportRecords', payload),
  listRecords: (month) => call('listRecords', { month }),
  getStats: (months) => call('getStats', { months }),
  deleteRecord: (_id) => call('deleteRecord', { _id })
}
