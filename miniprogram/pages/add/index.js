const ledger = require('../../utils/ledger')

const STORAGE_CHARGE_TYPE = 'ledger:lastChargeType'
const STORAGE_ODOMETER_TYPE = 'ledger:lastOdometerType'

const CHARGE_TYPES = ['home', 'fast', 'swap', 'none']
const ODOMETER_TYPES = ['total', 'trip']

const ODOMETER_TYPE_OPTIONS = [
  { label: '总里程', value: 'total' },
  { label: '单次行程', value: 'trip' }
]

const CHARGE_TYPE_OPTIONS = [
  { label: '家充', value: 'home' },
  { label: '快充', value: 'fast' },
  { label: '换电', value: 'swap' },
  { label: '未充电', value: 'none' }
]

const CHARGE_TYPE_LABELS = {
  home: '家充',
  fast: '快充',
  swap: '换电',
  none: '未充电'
}

const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

const formatDate = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const todayString = () => formatDate(new Date())

const isDecimal = (value, digits) =>
  new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`).test(String(value))

const normalizeDate = (value, fallback) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : formatDate(date)
}

const compressImage = (src) =>
  new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') {
      resolve(src)
      return
    }
    wx.compressImage({
      src,
      quality: 70,
      success: (res) => resolve(res.tempFilePath || src),
      fail: () => resolve(src)
    })
  })

Page({
  data: {
    today: '',
    datePickerVisible: false,
    form: {
      date: '',
      odometerType: 'total',
      odometer: '',
      chargeType: 'home',
      chargeKwh: '',
      chargeFee: '',
      socStart: '',
      socEnd: '',
      note: ''
    },
    odometerTypeOptions: ODOMETER_TYPE_OPTIONS,
    chargeTypeOptions: CHARGE_TYPE_OPTIONS,
    isCharging: true,
    hasAnyInput: false,
    errors: {},
    submitting: false,
    isEditing: false,
    loading: false,
    recognizing: false,
    orderImage: '',
    recognizedSummary: []
  },

  onLoad(options) {
    const editId = options && options.id ? String(options.id) : ''
    this.editId = editId

    if (editId) {
      this.setData({ isEditing: true })
      wx.setNavigationBarTitle({ title: '编辑记录' })
      this.loadRecord(editId)
      return
    }

    this.initNew()
  },

  initNew() {
    const lastChargeType = wx.getStorageSync(STORAGE_CHARGE_TYPE)
    const lastOdometerType = wx.getStorageSync(STORAGE_ODOMETER_TYPE)
    const chargeType = CHARGE_TYPES.includes(lastChargeType) ? lastChargeType : 'home'
    const odometerType = ODOMETER_TYPES.includes(lastOdometerType) ? lastOdometerType : 'total'
    const today = todayString()

    this.setData({
      today,
      'form.date': today,
      'form.chargeType': chargeType,
      'form.odometerType': odometerType,
      isCharging: chargeType !== 'none'
    })
  },

  async loadRecord(id) {
    this.setData({ loading: true })
    try {
      const data = await ledger.getRecord(id)
      const record = data.record
      this.setData({
        loading: false,
        today: todayString(),
        form: {
          date: record.date,
          odometerType: record.odometerType,
          odometer: String(record.odometer),
          chargeType: record.chargeType,
          chargeKwh: record.chargeType === 'none' ? '' : String(record.chargeKwh),
          chargeFee: String(record.chargeFee),
          socStart: record.socStart === null || record.socStart === undefined
            ? ''
            : String(record.socStart),
          socEnd: record.socEnd === null || record.socEnd === undefined
            ? ''
            : String(record.socEnd),
          note: record.note || ''
        },
        isCharging: record.chargeType !== 'none',
        hasAnyInput: true
      })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '记录加载失败', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 1200)
    }
  },

  openDatePicker() {
    this.setData({ datePickerVisible: true })
  },

  onDateCancel() {
    this.setData({ datePickerVisible: false })
  },

  onDateConfirm(e) {
    const date = normalizeDate(e.detail.value, this.data.today)
    this.setData({
      datePickerVisible: false,
      'form.date': date,
      'errors.date': ''
    })
  },

  onOdometerTypeChange(e) {
    const value = e.detail.value
    this.setData({ 'form.odometerType': value })
    wx.setStorageSync(STORAGE_ODOMETER_TYPE, value)
  },

  onChargeTypeChange(e) {
    const value = e.detail.value
    const isCharging = value !== 'none'
    const patch = {
      'form.chargeType': value,
      isCharging
    }
    if (!isCharging) {
      patch['form.chargeKwh'] = ''
      patch['errors.chargeKwh'] = ''
    }
    this.setData(patch)
    wx.setStorageSync(STORAGE_CHARGE_TYPE, value)
    this.refreshHasAnyInput()
  },

  onFieldInput(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    this.setData({
      [`form.${field}`]: value,
      [`errors.${field}`]: ''
    })
    this.refreshHasAnyInput()
  },

  onNoteChange(e) {
    this.setData({ 'form.note': e.detail.value })
    this.refreshHasAnyInput()
  },

  async onRecognizeOrder() {
    if (this.data.recognizing) return

    let media
    try {
      media = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed']
      })
    } catch (err) {
      const message = (err && (err.errMsg || err.message)) || ''
      if (!/cancel/i.test(message)) {
        wx.showToast({ title: '无法打开相机或相册', icon: 'none' })
      }
      return
    }

    const file = media.tempFiles && media.tempFiles[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      wx.showToast({ title: '图片不能超过 5MB', icon: 'none' })
      return
    }

    this.setData({
      recognizing: true,
      orderImage: file.tempFilePath,
      recognizedSummary: []
    })

    const uploadPath = await compressImage(file.tempFilePath)
    this.setData({ orderImage: uploadPath })
    let fileID = ''

    try {
      const upload = await wx.cloud.uploadFile({
        cloudPath: `orders/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
        filePath: uploadPath
      })
      fileID = upload.fileID

      const result = await ledger.recognizeChargeOrder({ fileID })
      const fields = result.fields || {}
      const patch = {}

      if (fields.date) patch['form.date'] = fields.date
      if (fields.odometer) patch['form.odometer'] = String(fields.odometer)
      if (fields.chargeKwh) patch['form.chargeKwh'] = String(fields.chargeKwh)
      if (fields.chargeFee !== undefined) patch['form.chargeFee'] = String(fields.chargeFee)
      if (fields.socStart !== undefined) patch['form.socStart'] = String(fields.socStart)
      if (fields.socEnd !== undefined) patch['form.socEnd'] = String(fields.socEnd)

      if (fields.chargeType) {
        patch['form.chargeType'] = fields.chargeType
        patch.isCharging = fields.chargeType !== 'none'
        if (fields.chargeType === 'none') patch['form.chargeKwh'] = ''
      }

      const note = [fields.station, fields.note].filter(Boolean).join(' | ').slice(0, 100)
      if (note) patch['form.note'] = note

      const summary = []
      if (fields.date) {
        summary.push({
          label: '日期',
          value: fields.time ? `${fields.date} ${fields.time}` : fields.date
        })
      }
      if (fields.chargeKwh) {
        summary.push({ label: '充电量', value: `${fields.chargeKwh} kWh` })
      }
      if (fields.chargeFee !== undefined) {
        summary.push({ label: '金额', value: `¥${Number(fields.chargeFee).toFixed(2)}` })
      }
      if (fields.socStart !== undefined) {
        summary.push({ label: 'SOC', value: `${fields.socStart}% → ${fields.socEnd}%` })
      }
      if (fields.chargeType) {
        summary.push({
          label: '类型',
          value: CHARGE_TYPE_LABELS[fields.chargeType] || fields.chargeType
        })
      }
      if (fields.station) summary.push({ label: '站点', value: fields.station })
      if (fields.note) summary.push({ label: '备注', value: fields.note })
      if (fields.odometer) {
        summary.push({ label: '总里程', value: `${fields.odometer} km` })
      } else if (summary.length > 0) {
        summary.push({ label: '总里程', value: '未识别，请手动填写' })
      }

      const count = Object.keys(fields).filter((key) => key !== 'time').length
      if (!count) {
        this.setData({ recognizedSummary: summary })
        wx.showToast({ title: '没识别到有效信息，请手动填写', icon: 'none' })
        return
      }

      this.setData(Object.assign({ recognizedSummary: summary }, patch))
      this.refreshHasAnyInput()
      wx.showToast({ title: `已识别 ${count} 项，请核对`, icon: 'none' })
    } catch (err) {
      const message = (err && (err.message || err.errMsg)) || '识别失败，请手动填写'
      console.error('[recognizeChargeOrder]', err)
      wx.showModal({
        title: '识别失败',
        content: message,
        showCancel: false
      })
    } finally {
      this.setData({ recognizing: false })
      if (fileID) {
        wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      }
    }
  },

  previewOrderImage() {
    if (!this.data.orderImage) return
    wx.previewImage({
      urls: [this.data.orderImage],
      current: this.data.orderImage
    })
  },

  refreshHasAnyInput() {
    const form = this.data.form
    const hasAnyInput = [
      'odometer',
      'chargeKwh',
      'chargeFee',
      'socStart',
      'socEnd',
      'note'
    ].some((key) => String(form[key] || '').trim() !== '')

    if (hasAnyInput !== this.data.hasAnyInput) {
      this.setData({ hasAnyInput })
    }
  },

  validateForm() {
    const { form, isCharging, today } = this.data
    const errors = {}

    if (!form.date) {
      errors.date = '请选择日期'
    } else if (form.date > today) {
      errors.date = '日期不能晚于今天'
    }

    const odometer = Number(form.odometer)
    if (String(form.odometer).trim() === '') {
      errors.odometer = '请填写里程读数'
    } else if (!isDecimal(form.odometer, 1)) {
      errors.odometer = '里程最多 1 位小数'
    } else if (!(odometer > 0)) {
      errors.odometer = '里程需大于 0'
    } else if (odometer > 2000000) {
      errors.odometer = '里程数值过大'
    }

    if (isCharging) {
      const kwh = Number(form.chargeKwh)
      if (String(form.chargeKwh).trim() === '') {
        errors.chargeKwh = '请填写充电量'
      } else if (!isDecimal(form.chargeKwh, 3)) {
        errors.chargeKwh = '充电量最多 3 位小数'
      } else if (!(kwh > 0)) {
        errors.chargeKwh = '充电量需大于 0'
      } else if (kwh > 200) {
        errors.chargeKwh = '充电量不能超过 200 kWh'
      }
    }

    const fee = Number(form.chargeFee)
    if (String(form.chargeFee).trim() === '') {
      errors.chargeFee = '请填写金额'
    } else if (!isDecimal(form.chargeFee, 2)) {
      errors.chargeFee = '金额最多 2 位小数'
    } else if (fee < 0) {
      errors.chargeFee = '金额不能为负'
    } else if (fee > 10000) {
      errors.chargeFee = '金额不能超过 10000 元'
    }

    const hasSoc = form.socStart !== '' || form.socEnd !== ''
    if (hasSoc) {
      const start = Number(form.socStart)
      const end = Number(form.socEnd)
      if (form.socStart === '' || form.socEnd === '') {
        errors.soc = '请同时填写起始与结束电量'
      } else if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start > 100 ||
        end < 0 ||
        end > 100
      ) {
        errors.soc = '电量需为 0–100 的整数'
      } else if (end <= start) {
        errors.soc = '结束电量需大于起始电量'
      }
    }

    return errors
  },

  scrollToField(field) {
    wx.pageScrollTo({
      selector: `#field-${field}`,
      duration: 300,
      fail: () => {}
    })
  },

  buildPayload() {
    const { form, isCharging } = this.data
    return {
      date: form.date,
      odometer: form.odometer,
      odometerType: form.odometerType,
      chargeKwh: isCharging ? form.chargeKwh : 0,
      chargeFee: form.chargeFee,
      chargeType: form.chargeType,
      socStart: form.socStart,
      socEnd: form.socEnd,
      note: form.note
    }
  },

  async onSubmit() {
    if (this.data.submitting) return

    const errors = this.validateForm()
    const firstField = Object.keys(errors)[0]

    if (firstField) {
      this.setData({ errors })
      wx.showToast({ title: errors[firstField], icon: 'none' })
      this.scrollToField(firstField)
      return
    }

    this.setData({ errors: {}, submitting: true })

    try {
      const payload = this.buildPayload()
      if (this.editId) {
        await ledger.updateRecord(this.editId, payload)
      } else {
        await ledger.addRecord(payload)
      }
      wx.showToast({ title: this.editId ? '已更新' : '已记录', icon: 'success' })
      setTimeout(() => {
        wx.navigateBack({ delta: 1 })
      }, 600)
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败，请重试', icon: 'none' })
      this.setData({ submitting: false })
    }
  }
})
