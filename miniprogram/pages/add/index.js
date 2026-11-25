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
      quality: 90,
      success: (res) => resolve(res.tempFilePath || src),
      fail: () => resolve(src)
    })
  })

const mergeOrderFields = (base, extra) => {
  const merged = Object.assign({}, base)
  const hasOrder = extra.chargeKwh !== undefined || extra.chargeFee !== undefined

  Object.keys(extra || {}).forEach((key) => {
    const value = extra[key]
    if (value === undefined || value === null || value === '') return

    if (key === 'note') {
      if (hasOrder || !merged.note) merged.note = value
      return
    }

    if (key === 'date' || key === 'time') {
      if (extra.socStart !== undefined || !merged[key]) merged[key] = value
      return
    }

    if (merged[key] === undefined || merged[key] === null || merged[key] === '') {
      merged[key] = value
    }
  })

  return merged
}

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
    orderImages: [],
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

    try {
      await getApp().requirePrivacy()
    } catch (err) {
      wx.showToast({ title: '需同意隐私保护指引后才能使用拍照识别', icon: 'none' })
      return
    }

    let media
    try {
      media = await wx.chooseMedia({
        count: 3,
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

    const files = (media.tempFiles || []).slice(0, 3)
    if (!files.length) return
    if (files.some((file) => file.size > 5 * 1024 * 1024)) {
      wx.showToast({ title: '单张图片不能超过 5MB', icon: 'none' })
      return
    }

    this.setData({
      recognizing: true,
      orderImages: files.map((file) => file.tempFilePath),
      recognizedSummary: []
    })

    const uploadPaths = await Promise.all(
      files.map((file) => compressImage(file.tempFilePath))
    )
    this.setData({ orderImages: uploadPaths })
    const uploadedFileIDs = []

    wx.showLoading({ title: '识别中', mask: true })

    try {
      for (let index = 0; index < uploadPaths.length; index += 1) {
        const upload = await wx.cloud.uploadFile({
          cloudPath: `orders/${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.jpg`,
          filePath: uploadPaths[index]
        })
        uploadedFileIDs.push(upload.fileID)
      }

      console.log('[recognizeChargeOrder] fileIDs', uploadedFileIDs)

      const result = await ledger.recognizeChargeOrder({ fileIDs: uploadedFileIDs })
      let fields = result.fields || {}
      console.log('[recognizeChargeOrder] multi result', result)

      if (
        uploadedFileIDs.length > 1 &&
        (!fields.chargeKwh || fields.socStart === undefined || fields.odometer === undefined)
      ) {
        const partials = await Promise.all(
          uploadedFileIDs.map((fileID) =>
            ledger.recognizeChargeOrder({ fileID }).catch((err) => {
              console.error('[recognizeChargeOrder] fallback failed', err)
              return null
            })
          )
        )

        partials.forEach((partial) => {
          if (partial && partial.fields) {
            fields = mergeOrderFields(fields, partial.fields)
          }
        })
        console.log('[recognizeChargeOrder] fallback fields', fields)
      }

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

      const note = [fields.station, fields.note].filter(Boolean).join(' | ').slice(0, 300)
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
        wx.showModal({
          title: '未识别到字段',
          content: '请确认图片清晰，且包含充电开始/结束提醒和订单截图；也可以先只上传订单截图重试。',
          showCancel: false
        })
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
      wx.hideLoading()
      this.setData({ recognizing: false })
      if (uploadedFileIDs.length) {
        wx.cloud.deleteFile({ fileList: uploadedFileIDs }).catch(() => {})
      }
    }
  },

  previewOrderImage(e) {
    const images = this.data.orderImages || []
    if (!images.length) return

    const current =
      (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.src) ||
      images[0]

    wx.previewImage({
      urls: images,
      current
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
