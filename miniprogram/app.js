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
  }
})
