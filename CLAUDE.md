# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

微信原生小程序：**新能源电车的能耗记录账本**（记录充电、里程、花费，统计百公里电耗与每公里成本）。

当前状态：**v1（R1–R5）与二期（历史记录编辑、Excel 导入/导出、拍照识别）已完成并通过测试**。AppID `wxf641bd4dfe019562`，云开发环境 `cloud1-d3g9916cz3b402499`；`ledger` 云函数已部署，`records` / `vehicles` 集合已创建。**OCR 当前受账号额度/权限限制**，调用会降级为手动输入，需在微信后台开通或购买 OCR 额度后才能真正识别。R6 真机适配与发布前检查待执行，清单见 `docs/v1-功能设计.md` §12。仓库还不是 git 仓库。

## 目录结构

```
project.config.json        # miniprogramRoot=miniprogram/，cloudfunctionRoot=cloudfunctions/
miniprogram/               # 小程序源码（构建产物不在此目录）
  app.js                   # 云开发初始化留到 R3
  app.json                 # 页面注册、tabBar（记录 / 统计）
  app.wxss                 # 全局设计变量与通用样式
  sitemap.json             # 全站 disallow，账本数据不参与索引
  package.json             # 小程序运行时依赖（TDesign）；npm 装在这里
  miniprogram_npm/         # build-npm 产物，勿手改
  node_modules/            # TDesign 等运行时依赖
  pages/list/index.*       # 记录首页：月份切换、月汇总、按日分组、点击编辑、左滑删除、FAB
  pages/stats/index.*      # 统计：指标卡 + 电耗/成本/花费构成三张图
  pages/import/index.*     # Excel 导入：选文件、默认类型、结果与错误行
  pages/export/index.*     # Excel 导出：全部/指定月份、打开保存、发送到聊天
  components/ec-canvas/    # 官方 echarts-for-weixin 组件（含 echarts.js，约 1MB）
  pages/add/index.*        # 记一笔/编辑：表单、校验、拍照识别、云函数保存
  utils/ledger.js          # 云函数调用封装（callFunction + code 判定）
cloudfunctions/
  ledger/                  # 唯一云函数：action 分发 + 全量口径计算
    index.js
    lib/ocr.js             # 从 OCR items 提取里程候选（纯函数，可单测）
    config.json            # openapi 权限：ocr.printedText
    package.json           # wx-server-sdk + xlsx
docs/v1-功能设计.md         # v1 行为与口径的权威说明（含二期与发布清单）
scripts/smoke.js           # 前端冒烟：编译、tab、表单校验
scripts/cloud-smoke.js     # 云端冒烟：计算口径、列表、编辑、删除、统计
scripts/import-smoke.js    # Excel 导入冒烟（默认合成样本，可传真实文件路径）
scripts/lib/fixture.js     # 测试用合成 Excel 生成器，不含真实数据
scripts/ocr-smoke.js       # OCR 调用冒烟（额度不足时打印 SKIPPED）
scripts/ocr-parse-test.js  # OCR 候选提取纯函数单测
scripts/prune-miniprogram-npm.js  # 裁剪 TDesign 未使用组件，控制主包体积
package.json               # 根目录仅含 devDependencies（自动化 SDK）
```

## 仓库内文档（先读这些，不要凭经验发挥）

- `docs/v1-功能设计.md` —— **v1 页面行为与统计口径的权威说明**：导航、字段与校验、计算口径、云函数契约、验收标准。实现前先读，冲突时以它为准。
- `微信小程序入门与AI搭建指南.md` —— 技术与产品决策来源：技术选型、v1 范围、数据模型、电耗公式、AI 协作方式、平台限制。
- `小游戏IAA立项调研-2026-11-20.md` —— 微信/抖音**小游戏**方向的独立调研，与本账本小程序无关。不要把它当成需求或架构依据，也不要因此引入 Cocos 等游戏技术栈。

## 已定的技术选型（不要擅自替换）

- **原生小程序** + **微信云开发**（云函数 + 云数据库），不引入 uni-app / Taro。
- UI 用 **TDesign 小程序版**，图表用 **echarts-for-weixin**；不自造基础组件。
- 不搭独立后端/服务器、不做域名白名单配置，数据访问一律走云函数。
- 图表用官方 `echarts-for-weixin` 的 `ec-canvas`，已复制到 `miniprogram/components/ec-canvas`（未走 npm）。统计页用 `ec: { lazyLoad: true }`，数据返回后通过 `selectComponent().init()` 初始化并 `setOption`；不要通过 `setData` 传函数。
- `ec-canvas/echarts.js` 约 1MB，只在统计页引用；不要在其他页面 import 它。

## 云开发

- 环境 ID：`cloud1-d3g9916cz3b402499`，在 `miniprogram/app.js` 的 `wx.cloud.init` 中初始化。
- 只有一个云函数 `ledger`，通过 `event.action` 分发 `setup` / `ensureVehicle` / `addRecord` / `getRecord` / `updateRecord` / `listRecords` / `getStats` / `deleteRecord` / `importRecords` / `deleteImportBatch` / `exportRecords` / `recognizeMileage`。不要拆成多个函数：计算口径必须只有一份。
- 云函数以管理员权限运行，**每个查询都要手动过滤 `_openid`**；集合权限在控制台设为「仅创建者可读写」。
- `setup` 会创建 `records` / `vehicles` 集合并建默认车，部署后调用一次即可；数据库索引需在控制台手动建（`records`: `_openid + date`，`vehicles`: `_openid`）。集合权限也必须在控制台设为「仅创建者可读写」，创建 API 不会替用户设置权限。
- 部署：
  ```bash
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli" cloud functions deploy \
    --env cloud1-d3g9916cz3b402499 --names ledger \
    --project /Users/rkjiang/mycode/mywxapp --remote-npm-install
  ```
  改动 `cloudfunctions/ledger/index.js` 后必须重新部署，前端冒烟不会覆盖云端代码。
- 查看环境：工具「云开发」控制台，或 `cli cloud env list --project .`。

## 二期功能（已实现）

### 历史记录编辑

- 列表页点击记录卡片 → `/pages/add/index?id=<id>`，复用同一表单，标题改为「编辑记录」。
- 云函数 `getRecord` / `updateRecord`，校验 `_openid` 归属；保留原 `createdAt` / `importFingerprint`，派生值在读取时重算。
- 充电量允许最多 3 位小数（兼容导入模板），列表仍按 1 位展示。

### Excel 导入

- 入口：列表页「导入历史数据」→ `pages/import/index`。
- 客户端 `wx.chooseMessageFile` 选 `.xlsx/.xls` → 云存储 → `ledger.importRecords`。
- 优先读取「充电数据」工作表，自动定位表头。列映射：充电时间→`date`、总里程→`odometer`、充前/后电量→`socStart/socEnd`、充电度数→`chargeKwh`、充电金额→`chargeFee`、备注→`note`；其余列（车端电量、电费单价）忽略。
- 完整时间写入 `createdAt`，保留同一天多次充电的顺序；充电类型按备注推断（换电 / 家充·家冲 / 超充·快充·充电站等），推断不出用页面所选的默认类型。
- 去重：`importFingerprint = sha1(时间|里程|电量|金额)`，重复导入自动跳过。
- 返回 `{ totalRows, imported, skippedDuplicate, skippedInvalid, errors, insertedIds }`。支持 `fileBase64`（测试）与 `fileID`（生产）。
- 测试默认使用 `scripts/lib/fixture.js` 生成的合成 Excel，不包含真实车辆数据；真实文件可用 `npm run smoke:import -- <path>` 在本地临时验证，不要把真实数据提交进仓库。

### Excel 导出

- 入口：记录页「导出数据」→ `pages/export/index`；范围可选「全部记录」或「指定月份」。
- 云函数 `exportRecords` 用 `xlsx` 生成单 sheet「充电数据」，列与导入模板兼容，并额外包含「里程类型」「充电类型」，导出文件可再次导入且保留精度与同日顺序。
- 生产路径：生成后上传云存储 → 客户端 `wx.cloud.downloadFile` → 删除云端临时文件 → `wx.openDocument({ showMenu: true })` 打开/保存，或 `wx.shareFileMessage` 发送到聊天。
- 返回 `{ fileID, count, fileName }`；`returnBase64` 用于测试。
- 导入记录额外保存 `importBatch`；`deleteImportBatch` 可按批次删除，测试用它清理，未来也可做「撤销导入」。

### 拍照识别里程

- 记一笔页「📷 拍照识别里程」→ `wx.chooseMedia` → 云存储 → `ledger.recognizeMileage`。
- 云函数调用 `cloud.openapi.ocr.printedText`（`config.json` 声明权限），从 OCR items 提取 4–7 位数字；带 `km` / `ODO` / `总里程` 上下文的优先，最多返回 6 个候选，多个时用 ActionSheet 让用户选。
- **额度或权限不足时返回业务错误，页面 toast 并允许手动输入**。当前账号实测返回「OCR 今日额度已用完」，需在微信后台开通或购买额度。
- 隐私保护指引需补充相机/相册与图片上传云存储的说明。

## v1 范围（严格守住）

三个页面，跑通「录入 → 存储 → 统计」闭环：

1. **记一笔**：里程表读数、日期、充电量 (kWh)、金额、充电类型（家充/快充/换电）、备注
2. **列表**：月份切换 + 当月明细 + 月汇总（里程、电耗、花费）
3. **统计**：百公里电耗趋势、每公里成本、家充 vs 快充花费占比

二期已实现历史记录编辑、Excel 导入、拍照识别里程。保养、行程记录、多车管理、分享、自动同步里程仍属 v2，不要提前实现。需求一多，生成代码会互相矛盾。

## 数据模型

```js
vehicles: { _id, name, model, batteryKwh, plateNo }

records: {
  _id, _openid, vehicleId, date, odometer, odometerType,  // total | trip
  chargeKwh, chargeFee, chargeType,                       // home | fast | swap | none
  socStart, socEnd, note,
  createdAt, updatedAt, source,                           // source: manual | import
  importFingerprint, importBatch                          // 仅导入记录：去重指纹 / 批次
}
```

- `chargeKwh` 最多 3 位小数；`chargeFee` 2 位；里程 1 位。
- 手工记录的 `createdAt` 是服务端时间；导入记录的 `createdAt` 是原始充电时间（东八区），用于保留同日顺序。

核心公式（不要写成别的口径）：

```
本段电耗 = 本次充电量 ÷ 本次充电对应行驶里程 × 100
```

- `odometerType` 为 `total` 时，本段里程由相邻两条记录的读数差得出；为 `trip` 时直接取记录值。
- **第一条记录没有「上一段」**，里程/电耗必须按 null 处理，不能算出除零或负数。

## 小程序平台硬约束（AI 写代码的高频错误点）

- 只用小程序原生 API：**禁止** `document` / `window` / `axios`，禁止 Vue 的 `v-model`、`@click`。
- 状态统一走 `data` + `this.setData()`。
- 新增页面必须同时注册进 `app.json` 的 `pages` 数组。
- `wx.request` 必须 https 且域名在小程序后台白名单内；**云函数调用不受此限**，所以业务数据一律通过云函数读写。
- 云数据库权限设为「**仅创建者可读写**」，不要设为所有人可读（涉及车辆与消费数据）。
- 里程无法自动同步：国内车企不开放个人 API，电车 OBD 也不通。v1 手动录入，二期已加拍照 OCR 识别（`cloud.openapi.ocr.printedText`），额度不足时手动输入。
- 个人主体**不能开通微信支付**；ICP 备案是上架硬门槛（1–2 周），不要等到发布才办。

## 本地开发

微信开发者工具已安装：`/Applications/wechatwebdevtools.app`（Apple 芯片版）。项目需在工具内用正式 AppID 打开，后端选「微信云开发」。

开发者工具 CLI 可用于无界面操作：

```bash
DEVTOOLS="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"

"$DEVTOOLS" open --project .        # 打开项目
"$DEVTOOLS" build-npm --project .   # 安装 TDesign/echarts 后必须构建 npm
"$DEVTOOLS" preview --project .     # 生成预览二维码（真机调试）
"$DEVTOOLS" upload --project .      # 上传体验版/发布版本
```

- 首次使用 CLI 需在工具「设置 → 安全设置」开启服务端口，或提供 `--token`。已被关闭时 CLI 会提示确认；不要用管道输入 `y` 绕过这个安全确认，让用户自己开启。
- 引入或升级运行时依赖（TDesign/echarts）时，在 `miniprogram/` 目录下 `npm install`，再执行 `build-npm --project .`，否则小程序端解析不到包。`miniprogram_npm/` 是产物，不要手改。
- 当前使用 TDesign 1.18.0；页面按需在各自 json 的 `usingComponents` 里注册，路径形如 `tdesign-miniprogram/input/input`。
- **主包有 2MB 限制**。`build-npm` 会生成 TDesign 全部组件（约 5MB），必须执行 `npm run prune:npm`，脚本只保留 `scripts/prune-miniprogram-npm.js` 白名单中的组件及其依赖。当前裁剪后 TDesign 约 0.53MB，加上 ECharts 约 0.97MB，主包源码约 1.57MB。
- 新增 TDesign 组件时，同步把它加到裁剪脚本的 `KEEP` 列表，否则下次裁剪会被删掉；`config-provider`、`common`、`mixins`、`icon` 等公共依赖不要删。
- 开发者工具 CLI 的 `preview` 在当前版本有二维码输出路径 bug；验证体积请用 GUI「预览/上传」，或直接看「详情 → 本地代码」。

### 自动化冒烟

```bash
npm install            # 首次，安装根目录的自动化 SDK
npm test               # OCR 候选提取纯函数单测（不启动工具）
npm run smoke          # 前端：编译、tab、表单校验（不需要云环境）
npm run smoke:cloud    # 云端：计算口径、列表、编辑、删除、统计图表
npm run smoke:import   # Excel 导入：默认合成样本，可传真实文件路径
npm run smoke:export   # Excel 导出：全部/指定月份、内容校验、云端上传下载
npm run smoke:ocr      # OCR：默认读 /tmp/odo.png，额度不足时打印 SKIPPED
npm run prune:npm      # build-npm 后裁剪 TDesign 未使用组件（控制主包 <2MB）
```

- `scripts/smoke.js` 校验编译、记录/统计 tab、「+」进入记一笔、表单默认值与校验；生成 `/tmp/mywxapp-list.png`、`/tmp/mywxapp-add.png`。
- `scripts/cloud-smoke.js` 需要 `ledger` 已部署：用 2000-01 的历史记录做隔离，验证本段里程/电耗/成本、月度汇总、统计接口，再走表单提交、列表渲染、编辑、左滑删除、图表初始化，并清理测试数据；生成统计页截图。
- `scripts/import-smoke.js` 读取合成 xlsx 的 base64 调 `importRecords`，验证 3 条导入、字段映射、3 位小数、原始顺序、重复导入去重、导入后编辑，最后按导入批次清理。传自定义文件：`npm run smoke:import -- /path/to/file.xlsx`（仅本地使用，不要提交真实数据）。
- `scripts/export-smoke.js` 导入合成样本后用 `exportRecords` 的 `returnBase64` 解析工作簿，校验全部/指定月份的标题、列、精度、时分与文件名，再验证云端上传、下载和清理，最后按批次删除测试数据。
- `scripts/ocr-smoke.js` 先校验缺少图片返回 400，再用测试图调用 OCR；若账号无额度会明确打印 `OCR SKIPPED`。测试图可用 headless Chrome 生成。
- 所有 automator 脚本都通过 `miniProgram.evaluate` 访问 `getCurrentPages()` 调用页面方法（`page.callMethod` 在当前基础库不可用）。

## 协作方式

用户偏好**按文件派活、每轮只改一个文件**，并给出可验证的验收标准（例如「表单必填拦截生效」「云开发控制台能看到数据」）。改动前说明要改哪个文件、为什么；不要一次重构多个页面。
