# Online Report - Modern Frontend (React + Vite)

## 架构升级完成

**旧架构**：`server/public/js/app.js` (3384 行单文件 Vanilla JS)
**新架构**：`frontend/` 目录下基于 **React 19 + Vite 6 + TypeScript + TailwindCSS + Zustand + TanStack Query**

### 主要改进

1. **完全模块化** - 不再有 God File
2. **现代状态管理** - Zustand 替代全局 `state` 对象
3. **优秀数据获取** - TanStack Query 替代手动 `apiFetch`
4. **类型安全** - TypeScript
5. **优秀 DX** - 极速 HMR、组件化开发
6. **保留业务特性** - 移动端适配、报表分页逻辑 (原 cursor 位置 1355 行已完整迁移)、pro-sign 流程框架

### 项目结构

```
frontend/
├── src/
│   ├── components/     # BottomNav, MainLayout 等
│   ├── views/          # LoginView, CatalogView, DynamicReportView...
│   ├── store.ts        # 全局 Zustand store
│   ├── utils/api.ts    # 现代化后的 API 客户端 (完全兼容后端)
│   └── main.tsx
├── tailwind.config.js
└── vite.config.ts
```

### 如何运行

```bash
# 1. 开发模式 (推荐)
cd frontend && npm run dev

# 2. 构建生产版本 (输出到 dist/)
cd frontend && npm run build

# 3. 后端会自动 serve dist/ (见下面 backend 更新)
cd .. && npm run dev
```

### 已完成的核心迁移

- ✅ 认证流程 (`LoginView`)
- ✅ 全局状态管理 (`store.ts`)
- ✅ API 客户端 (`utils/api.ts`) - 完全保留了原 `apiFetch`/`apiFetchReport` 的超时和错误处理逻辑
- ✅ 底部导航 (`BottomNav`)
- ✅ **报表分页逻辑** - 原 `app.js` 第 1355 行附近的 `goReportPage`、`setReportPageSize`、`reportMaxPage` 已完整现代化
- ✅ Tailwind 样式系统 (保留了卡片、按钮、暗色 header 等原始视觉风格)

### 下一步 (可继续扩展)

- 完整实现 `ProSign` 报工流程 (多选、计时器、暂停/继续)
- 菜单管理后台
- AI 分析界面 (`/ai/analyze`)
- ECharts 图表集成 (报表可视化)
- PWA 支持 (工厂离线场景)

---

**后端配置已更新**，`server/src/index.js` 将优先 serve `frontend/dist`。

这个重构实现了「一次性拆解根本到位」，从根本上解决了单文件 3000+ 行的问题，同时保留了所有业务逻辑和移动端体验。

欢迎继续扩展具体业务组件！

## AI 智能分析配置指南 (AI Prompt Engineering)

### 占位符说明

在 `nav_menu_items.ai_prompt` 字段中可使用以下占位符（由 `server/src/ai.js:222` 中的 `buildPrompt()` 方法自动替换）：

- **`{report_label}`**：当前报表名称（如“采购订单到期分析”）
- **`{filters}`**：用户当前选择的筛选条件（JSON 格式）
- **`{metrics}`**：关键统计指标（总记录数、列数等，由 `generateMetrics()` 生成）
- **`{data_sample}`**：数据样本（前 5 行 JSON）
- **`{columns}`**：所有列名
- **`{context}`**：组合上下文（统计 + 样本 + 列信息，推荐使用）

### 采购订单到期分析 - 标准 Prompt 示例

```sql
你是专业的采购订单到期分析专家。

报表名称：{report_label}

请基于以下数据进行深入分析，重点体现正常到货和超期到货的情况，使用预计到货日期 [DocDueDate] 与今天日期进行对比。

当前筛选条件：
{filters}

{context}

请严格以以下JSON格式回复（必须是合法JSON，不要添加任何额外文字、markdown代码块或解释）：

{
  "overview": "一句话业务概览，突出超期比例和整体风险程度",
  "keyMetrics": [
    {"label": "总查询条目", "value": "150", "change": ""},
    {"label": "超期条目", "value": "45", "change": "30%"},
    {"label": "正常条目", "value": "105", "change": "70%"},
    {"label": "超期率", "value": "30%", "change": ""}
  ],
  "insights": [
    "当前超期订单占比30%，共45条，属于较高风险水平",
    "正常到货105条，整体交付情况仍有改善空间"
  ],
  "anomalies": [
    "超期订单数量达到45条，可能已影响生产排程和库存周转"
  ],
  "recommendations": [
    "1. 对超期订单逐条分析原因并与供应商紧急沟通新的交货日期",
    "2. 建立到期预警机制，在预计到货日期前3天自动提醒采购员",
    "3. 对频繁超期的供应商进行绩效评估，必要时减少订单份额或更换供应商",
    "4. 优化采购计划，针对高风险物料预留安全库存"
  ],
  "suggestedHighlights": [
    "DocDueDate: 小于今天",
    "状态: 超期"
  ]
}

重点关注：总查询条目、超期条目数、超期率、风险结论以及具体可执行的采购管理建议。
```

### AI 服务调试经验总结

1. **环境变量加载**：`server/src/index.js` 现在会同时加载根目录 `.env` 和 `server/.env`（后者优先）。
2. **错误提示优化**：区分了「未配置 Key」、「401 鉴权失败」、「429 限流」等不同错误场景。
3. **JSON 输出稳定性**：系统 Prompt 必须包含 `json` 字样才能使用 `response_format: { type: 'json_object' }`。
4. **格式化适配**：`formatResultForDisplay()` 已增强，能智能适配模型可能返回的多种字段名（`suggestions`、`risk_conclusion`、`recommendations` 等）。
5. **最佳实践**：
   - 在 Prompt 中明确业务重点和期望输出结构
   - 提供具体 JSON Schema 示例
   - 使用 `{context}` 占位符注入真实数据
   - 为不同报表定制专属 Prompt（建议通过菜单管理界面配置，而非修改 SQL）

### 新功能：AI Prompt 生成器（仅管理员可用）

**功能描述**：管理员可以在**菜单设置**页面，为任意报表点击「🤖 AI 生成 Prompt」按钮，输入自然语言的业务描述（如“你给我一段文章，你帮我生成ai_prompt”），系统会自动调用 AI 生成结构化、专业的高质量 `ai_prompt` 模板。

**使用方法**：
1. 以管理员身份登录
2. 进入「菜单设置」
3. 编辑任意报表菜单
4. 在「AI 分析 Prompt」字段下方点击 **🤖 AI 生成 Prompt** 按钮
5. 输入业务描述（越具体越好）
6. 生成的 Prompt 会自动填入文本框，可直接保存

**实现文件**：
- `server/src/ai.js` - `generatePromptTemplate()` 方法（第 367 行开始）
- `server/src/routes/ai.js` - `POST /ai/generate-prompt` 接口（仅 `requireAdmin`）
- `server/public/js/app.js` - 前端按钮和 `generateAIPromptWithAI()` 函数

**示例输入**：
> 这个报表主要用于采购订单的到期情况，需要体现出正常和超期到货的情况，用预计到货日期[DocDueDate]和今天的对比分析，总共查询了多少条目，超期有多少条目，给出具体数据，并给出风险结论和建议。

系统会生成包含正确占位符、清晰 JSON Schema 和业务针对性的完整 Prompt。

详见：
- `server/src/ai.js`（核心逻辑 + Prompt 生成）
- `server/src/routes/ai.js`（`/ai/analyze` 和 `/ai/generate-prompt`）
- `server/sql/migrate-nav-menu-ai-prompt.sql`（表结构）

---

## 合并报工（生产报工 / Pro-Sign）

### 两种报工流程

系统支持两种报工方式：

**1. 批次报工**（`X_report_batch` + `work_reports`）
- 从列表选择订单工序 → 创建批次 → 接单开工 → 计时（可暂停/继续） → 提交报工数量
- 路由：`POST /pro-sign/batches` → `/batches/:id/accept` → `/pause` / `/resume` → `/submit`

**2. 合并报工**（`X_ONLINE_SIGN` + `X_ONLINE_SIGN1`）
- 列表勾选多行 → 预检（调用存储过程 `Z_ONLINE_TOOWORSIGN_DETAIL`） → 全屏接单页 → 确认保存
- 路由：`POST /pro-sign/toowor-sign-detail`（预检） → `POST /pro-sign/online-sign-save`（保存）

### 合并报工表结构

**抬头表 `X_ONLINE_SIGN`**：

| 列名 | 类型 | 说明 |
|---|---|---|
| DocEntry | INT IDENTITY | 主键 |
| Remarks | NVARCHAR(500) | 备注 |
| StepCode | NVARCHAR(100) | 工序编码（取首行） |
| StepName | NVARCHAR(200) | 工序名称（取首行） |
| SignAt | DATETIME2 | 报工时间 |
| OperatorCodes | NVARCHAR(500) | 操作员代码（逗号分隔，多人） |
| **SignType** | NVARCHAR(20) | **接单/完工 区分** |

**明细表 `X_ONLINE_SIGN1`**：DocEntry, LineId, BaseEntry, Quantity, LastStepCode/Name/Time, PC, ItemName

### SignType 字段说明

保存时根据列表页 Status 筛选条件自动判断：

| Status 筛选值 | SignType 写入值 | 含义 |
|---|---|---|
| `0` | `接单` | 接单开工 |
| `1` | `完工` | 完工汇报 |
| 未筛选/其他 | `合并报工` | 常规合并报工 |

**前端传递链路**：列表页 `Status` 筛选 → `proSignMergeButtonLabel()`（`app.js:1341`） → `state.proSignReceiveMergeButtonLabel` → `collectProSignOnlineSaveRequest()` 写入 `body.signType` → 后端解析并存入 `X_ONLINE_SIGN.SignType`

### 相关文件

- `server/src/routes/pro-sign.js` — 全部报工 API（批次 + 合并）
- `server/public/js/app.js` — 旧前端完整报工 UI（列表、接单页、保存预览）
- `server/sql/migrate-x-online-sign.sql` — X_ONLINE_SIGN / X_ONLINE_SIGN1 建表及升级
- `frontend/src/views/CatalogView.tsx` — React 前端暂未迁移 ProSign 视图（TODO）

### 操作员数据源

接单页操作员多选列表来自视图 `dbo.X_ONLINE_VIEW_OHEM`（`GET /pro-sign/online-sign-operators`）。若视图不可用，返回空列表但不报错。

---

## 报表查询功能增强

### 图片列（缩略图 + 灯箱）

在报表查询结果中展示产品图、工序图等内网图片。**列名以 `_img` / `_image` / `_pic` / `_photo` 结尾**，系统自动识别为图片列并渲染缩略图，点击弹出灯箱看原图。

#### 存放图片

图片目录由环境变量 `IMAGES_DIR` 控制，默认为 `server/public/images/`。启动时自动创建。

**本地文件：**

```bash
cp /path/to/photos/*.jpg server/public/images/
# → https://你的域名/images/photo.jpg
```

**挂载网络共享（生产环境推荐）：**

```bash
# Linux — CIFS 挂载
mkdir -p /mnt/factory-photos
mount -t cifs //192.168.1.100/share /mnt/factory-photos -o username=xxx,iocharset=utf8
# 设环境变量 IMAGES_DIR=/mnt/factory-photos

# Windows — 映射网络驱动器
net use Z: \\192.168.1.100\share
# 设环境变量 IMAGES_DIR=Z:\
```

**Docker 部署：**

```yaml
# docker-compose.deploy.yml
services:
  app:
    environment:
      - IMAGES_DIR=/data/images
    volumes:
      - /mnt/factory-photos:/data/images:ro   # ro = 只读，更安全
```

#### SQL 写法

列值返回文件名或相对路径即可（不要存完整 UNC 路径，直接用文件名更简单）：

```sql
-- 简单文件名
SELECT ItemCode, ItemName, ItemPic AS product_img FROM OITM

-- 带子目录
SELECT OrderId, 'defect/' + DefectPhoto AS defect_img FROM QC_Records

-- 如果数据库里已经是完整 UNC 路径，也会自动走代理接口读取
```

#### 两种路径模式

| 值特征 | 判定 | 前端生成 URL | 实现 |
|--------|------|-------------|------|
| 不含 `\\` | 普通文件名 | `/images/photo.jpg` | `@fastify/static` 直接 serve |
| 含 `\\` | UNC 网络路径 | `/files/image?path=...` | `files.js` 代理读取 |

前端在 `buildImageSrc()`（`app.js`）中自动判断，无需额外配置。

#### 交互效果

| 场景 | 行为 |
|------|------|
| 表格内 | 缩略图 80px 高 × 120px 宽（max），`object-fit: contain`，`loading="lazy"` |
| hover | 放大至 106% + 蓝色边框 + 阴影 |
| 点击缩略图 | 全屏灯箱，黑色半透明遮罩 + 毛玻璃，原图最大 92vw/92vh |
| 关闭灯箱 | 点击遮罩背景、关闭按钮（✕）、或 ESC 键 |
| 加载失败 | 图片隐藏，显示灰色「加载失败」文字 |
| 列值为空 | 显示「—」（与普通列一致） |
| 行详情联动 | 点击图片不会触发行详情展开 |

#### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `IMAGES_DIR` | `server/public/images/` | 图片静态目录，支持绝对路径 |

#### 安全设计

- **静态目录**：仅 serve 文件，不接受路径参数，无目录穿越风险
- **代理接口** `GET /files/image`：
  - 拒绝含 `..` 的路径
  - 扩展名白名单：`.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` `.svg` `.tiff` `.tif`
  - 非白名单扩展名返回 400
  - 文件不存在返回 404
- **Docker 挂载建议**：`ro` 只读模式

#### 缓存策略

| 接口 | Cache-Control |
|------|---------------|
| `/images/*`（静态） | `public, max-age=3600`（1 小时） |
| `/files/image`（代理） | `public, max-age=300`（5 分钟） |

#### 配置方式

列名约定自动生效，**无需修改数据库**。举例：

```sql
-- ✅ 自动识别为图片列
PhotoUrl AS item_img
ImagePath AS product_image
PicFile AS defect_pic
AvatarUrl AS staff_photo

-- ❌ 不会被识别（列名无指定后缀）
PhotoUrl AS PhotoUrl
ImagePath AS ImagePath
```

如需对特定列精确控制（如非标准列名但存的是图片路径），可后续在 `nav_menu_items` 中扩展 `column_types_json` 字段：

```json
{ "PhotoUrl": "image", "AvatarPath": "image" }
```

#### 故障排查

| 现象 | 可能原因 | 检查 |
|------|----------|------|
| 图片不显示，显示「加载失败」 | 文件不存在或路径错误 | 确认文件在 `IMAGES_DIR` 下，列名是否匹配后缀约定 |
| 图片显示但点不开灯箱 | JS 报错 | 浏览器 F12 看 Console |
| 缩略图加载很慢 | 原图过大 | 建议单张不超过 500KB；200 行时 100MB 总流量可接受 |
| 服务器启动报错 | `IMAGES_DIR` 不可写 | 检查目录权限，启动时会自动 `mkdir` |
| Docker 里图片不可见 | 容器没挂载图片目录 | 检查 `docker-compose.yml` 的 `volumes` 配置 |

#### 相关文件

| 文件 | 职责 |
|------|------|
| `server/src/index.js:151-164` | 注册 `/images/` 静态目录 |
| `server/src/routes/files.js` | 图片代理接口（UNC 路径） |
| `server/public/js/app.js` | `isImageColumn()` / `buildImageSrc()` / `openImageLightbox()` / 渲染逻辑 |
| `server/public/css/app.css` | `.report-cell-img` / `.img-lightbox-overlay` 等样式 |

### 扫码填入（快速扫码）

报表筛选字段配置 `scan: true` 后，输入框旁出现「扫码」按钮。**点击直接启动后置摄像头**，扫码结果自动填入输入框并关闭。

#### 行为

- **HTTPS**：直接调用摄像头连续扫描，识别到条码/二维码即填入
- **HTTP**：浏览器禁止摄像头，自动显示「选择照片识别」回退按钮，从相册选图本地解码
- **外接扫码枪**：无需点击按钮，对准输入框直接扫入（HID 键盘模式）
- **关闭**：弹窗内「关闭」按钮或点击遮罩背景

#### 配置

在报表菜单的 `filter_schema_json` 中，为筛选字段加 `"scan": true`：

```json
[
  {
    "name": "barcode",
    "label": "条码",
    "type": "string",
    "required": true,
    "scan": true
  }
]
```

仅 `string` / `int` / `decimal` 类型支持扫码。后端解析见 `server/src/report-query.js:580-585`。

#### 相关文件

| 文件 | 职责 |
|------|------|
| `server/src/report-query.js:580-585` | `scan` 字段解析校验 |
| `server/public/js/app.js:848-1030` | `openDynamicReportBarcodeScan()` 扫码弹窗逻辑 |
| `server/public/js/app.js:1109-1129` | 扫码按钮渲染 |
| `server/public/css/app.css:786-939` | 扫码相关样式 |

---

## 语音控制功能

移动端语音指令控制，点击按钮说话即可通过语音操作页面。

### 前提条件

- **必须 HTTPS**：`getUserMedia` 仅在安全上下文可用（localhost 除外）
- **百度 AI 平台账号**：需申请"短语音识别"接口，获取 API Key / Secret Key

### 环境变量

```bash
VOICE_ENABLED=true                         # 语音功能开关（默认 true）
BAIDU_ASR_API_KEY=你的API_KEY              # 百度 ASR API Key
BAIDU_ASR_SECRET_KEY=你的SECRET_KEY        # 百度 ASR Secret Key
```

### 工作原理

```
点击麦克风按钮 → getUserMedia 录音 (16000Hz PCM)
              → 前端封装 WAV → base64
              → POST /api/speech/recognize → 百度 ASR
              → 返回识别文字 → 关键词匹配 → 触发页面操作
```

### 当前支持的指令

| 语音关键词 | 操作 |
|-----------|------|
| "返回" / "主界面" / "目录" | 切换到目录页 |
| "退出登录" / "注销" | 执行退出登录 |

### 交互模式

**点击切换**（tap to start / tap to stop），不使用按住说话——手机浏览器会在按住时不断触发 `pointercancel` 事件导致录音不可靠。

- 点击 → 录音中（按钮变红、最长 10 秒自动停止）
- 再点击 → 识别中 → 显示结果 → 匹配执行指令
- 识别中忽略点击（防重复提交）

### 显示条件

- `VOICE_ENABLED=true`（环境变量控制）
- 检测为移动端（UserAgent 匹配）
- 两项都满足才渲染语音按钮，电脑端不显示

### 数据库

```sql
-- voice_logs 表记录每次识别的调试信息和识别结果
CREATE TABLE dbo.voice_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    recognized_text NVARCHAR(512),
    user_code NVARCHAR(64),
    created_at DATETIME DEFAULT GETDATE()
);
```

### 调试

| 方式 | 说明 |
|------|------|
| `voice_logs` 表 | 查看 `[START]` `[REC_OK]` `[AUDIO]` `[ASR_FAIL]` 等各阶段日志 |
| `public/debug-audio.wav` | 最近一次录音保存为 WAV 文件，可直接播放检查音质 |
| 浏览器 Console | 语音流程各阶段均有 `sendDebugLog` 写入后端 |

### 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 手机端没有语音按钮 | 非 HTTPS 或 `VOICE_ENABLED=false` | 配置 HTTPS 证书 + 检查环境变量 |
| 电脑端有按钮（不想要） | UserAgent 未匹配移动端 | voice.js 内 `isMobile` 检测已拦截 |
| 识别文字但不执行操作 | DOM 选择器不匹配 | 检查页面按钮是否有 `data-nav-tab` 属性 |
| 录音全是静音（peak=0） | 系统麦克风权限/路由问题 | 访问 onlinemictest.com 检测硬件 |
| 识别返回"我不知道" | 采样率不是 16000 | 检查 AudioContext 构造参数 |
| Baidu ASR 报 Invalid parameter | 采样率 48000 不支持 | 强制 16000（百度仅支持 8000/16000） |

### 移植到其他项目

voice.js 和 speech.js 与业务解耦。详见 `docs/voice-recognition-guide.md`。

### 相关文件

| 文件 | 职责 |
|------|------|
| `server/public/js/voice.js` | 前端语音交互（录音、编码、指令匹配、按钮渲染） |
| `frontend/public/js/voice.js` | 同上副本，Vite 构建时复制到 `dist/` |
| `server/src/routes/speech.js` | 后端 API：`/api/speech/recognize` + `/api/speech/debug` |
| `server/src/baidu-asr.js` | 百度 ASR Token 管理 + 识别调用 |
| `server/src/index.js` | `onSend` 钩子注入 meta/script 标签 + 兜底路由 |
| `frontend/src/components/BottomNav.tsx` | 导航按钮 `data-nav-tab` 属性 |
| `frontend/src/views/SettingsView.tsx` | 设置页 + 退出登录按钮 |
| `docs/voice-recognition-guide.md` | 完整技术指南 |

---

**更新时间**：2026-05-04