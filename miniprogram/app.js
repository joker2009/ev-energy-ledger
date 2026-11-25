App({
  globalData: {
    cloudEnv: 'cloud1-d3g9916cz3b402499'
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请升级微信开发者工具或基础库版本')
      return
    }
    wx.cloud.init({
      env: this.globalData.cloudEnv,
      traceUser: true
    })
  },

  /**
   * 调用拍照/相册、选择文件等隐私接口前先调用。
   * 这里不注册 wx.onNeedPrivacyAuthorization，保留微信官方隐私弹窗兜底；
   * 用户已同意过隐私保护指引时直接 resolve。
   */
  requirePrivacy() {
    return new Promise((resolve, reject) => {
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        resolve()
        return
      }
      wx.requirePrivacyAuthorize({ success: resolve, fail: reject })
    })
  }
})
