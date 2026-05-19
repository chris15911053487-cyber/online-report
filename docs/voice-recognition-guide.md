# 浏览器语音控制功能 — 技术指南

基于浏览器 `getUserMedia` + 百度短语音识别（ASR）实现的语音指令控制系统。用户点击按钮说话，识别结果匹配预定义关键词后触发页面操作。

---

## 1. 架构概览

```
┌──────────────────────────────────────────────────┐
│  前端 (voice.js)                                   │
│                                                    │
│  点击按钮 → getUserMedia 录音 (PCM)                 │
│          → 封装 WAV → base64                        │
│          → POST /api/speech/recognize              │
│          → 收到文字 → match(关键词) → click(DOM元素) │
│                                                    │
│  调试通道：POST /api/speech/debug (记录各阶段日志)    │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  后端 (speech.js + baidu-asr.js)                   │
│                                                    │
│  /api/speech/recognize                             │
│    → 保存 debug-audio.wav 到 public/               │
│    → 调用百度 ASR REST API                         │
│    → 写入识别结果到 voice_logs 表                   │
│    → 返回 { text: "识别文字" }                      │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  百度 ASR API                                      │
│  https://vop.baidu.com/server_api                  │
│  dev_pid: 1537 (普通话，带标点)                     │
│  支持格式: pcm / wav / amr / m4a                    │
│  支持采样率: 8000 / 16000                           │
└──────────────────────────────────────────────────┘
```

---

## 2. 前提条件

### 2.1 HTTPS（必须）

`getUserMedia` 仅在安全上下文（Secure Context）中可用：

| 环境 | 是否可用 |
|------|---------|
| `https://域名` | 可用 |
| `http://localhost` | 可用（浏览器白名单） |
| `http://192.168.x.x` | 不可用 |
| `http://域名` | 不可用 |

> 部署到服务器后必须配置 HTTPS 才能使用语音功能。建议使用 Nginx 反向代理 + Let's Encrypt 免费证书。

### 2.2 百度 AI 开放平台账号

1. 注册 [百度 AI 开放平台](https://ai.baidu.com/)
2. 创建应用 → 领取"短语音识别"接口
3. 获取 `API Key` 和 `Secret Key`

---

## 3. 配置清单

### 3.1 环境变量（.env）

```bash
# 语音功能总开关（默认 true，设为 false 关闭）
VOICE_ENABLED=true

# 百度 ASR 密钥（必须）
BAIDU_ASR_API_KEY=你的API_KEY
BAIDU_ASR_SECRET_KEY=你的SECRET_KEY
```

### 3.2 数据库表（voice_logs）

用于记录调试日志和识别结果：

```sql
CREATE TABLE dbo.voice_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    recognized_text NVARCHAR(512),    -- 识别文本 或 调试标签
    user_code NVARCHAR(64),           -- 操作用户
    created_at DATETIME DEFAULT GETDATE()
);
```

### 3.3 前端引入方式

voice.js 通过 HTML `<script>` 标签加载，有两种注入方式：

**方式一：HTML 中静态写入**（推荐，确保构建产物中包含）

```html
<body>
  ...
  <script src="/js/voice.js"></script>
</body>
```

**方式二：后端 onSend 钩子动态注入**（兜底方案）

```javascript
// 在 HTTP 响应中注入 meta 标签和 script 标签
fastify.addHook('onSend', async (_request, _reply, payload) => {
  const str = typeof payload === 'string' ? payload : payload.toString('utf-8');
  if (str.includes('</head>') && str.includes('</body>')) {
    let result = str;
    if (!result.includes('name="voice-enabled"')) {
      result = result.replace('</head>',
        '<meta name="voice-enabled" content="' + (voiceEnabled ? 'true' : 'false') + '">\n</head>');
    }
    if (voiceEnabled && !result.includes('/js/voice.js')) {
      result = result.replace('</body>',
        '<script src="/js/voice.js"></script>\n</body>');
    }
    return result;
  }
  return payload;
});
```

> 注意防重复注入：检查 HTML 中是否已存在 `name="voice-enabled"` 和 `/js/voice.js`

### 3.4 多静态根目录适配

如果项目同时存在 SPA 构建产物（如 Vite `dist/`）和传统静态目录（`public/`），需要确保 voice.js 始终可访问：

```javascript
// 在 @fastify/static 之前注册兜底路由
if (voiceEnabled) {
  const voiceJsPath = path.join(__dirname, '..', 'public', 'js', 'voice.js');
  fastify.get('/js/voice.js', async (_, reply) => {
    try {
      await fsp.access(voiceJsPath);
      return reply.type('application/javascript').send(fs.createReadStream(voiceJsPath));
    } catch {
      return reply.code(404).send('Not Found');
    }
  });
}
```

> 如果使用 Vite，推荐同时在 `frontend/public/js/` 下放一份 voice.js，构建时自动复制到 `dist/`

---

## 4. voice.js 核心设计

### 4.1 功能开关（双重检查）

```javascript
// 第一层：服务端环境变量 VOICE_ENABLED=false 时不加载
var voiceMeta = document.querySelector('meta[name="voice-enabled"]');
if (voiceMeta && voiceMeta.content === 'false') return;

// 第二层：仅在移动端显示（电脑端不出现语音按钮）
var isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
if (!isMobile) return;
```

这两行决定语音按钮是否渲染，后续所有逻辑都不会执行。

### 4.2 交互模式：点击切换

```javascript
btnEl.addEventListener('click', function (e) {
  e.preventDefault();
  e.stopPropagation();

  if (state === 'processing') return;        // 识别中，忽略
  if (state === 'recording') {               // 正在录 → 停止并识别
    stopAndRecognize();
    return;
  }
  // idle → 开始录音
  state = 'recording';
  startRecording(function (err, rec) { ... });
});
```

| 状态 | 含义 | 按钮行为 |
|------|------|---------|
| `idle` | 空闲 | 点击开始录音 |
| `recording` | 录音中 | 点击停止并提交识别 |
| `processing` | 识别中 | 忽略点击（防重复提交） |

> 为什么不使用按住说话（pointerdown/pointerup）？手机浏览器会在用户按住时不断触发 `pointercancel` 事件（用于手势检测），导致录音不可靠。

### 4.3 指令注册与匹配

```javascript
var commands = [];

// 注册指令：关键词数组 + 回调
function addCmd(keywords, handler) {
  commands.push({ keywords: keywords, handler: handler });
}

// 匹配算法：计算每个指令的关键词命中数，取最高分
function match(text) {
  var bestScore = 0, best = null;
  for (var i = 0; i < commands.length; i++) {
    var score = 0;
    for (var j = 0; j < commands[i].keywords.length; j++) {
      if (text.indexOf(commands[i].keywords[j]) !== -1) score++;
    }
    if (score > bestScore) { bestScore = score; best = commands[i]; }
  }
  return bestScore >= 1 ? best : null;
}

// 示例：注册"返回主页"指令
addCmd(['返回', '主界面', '目录', '首页', '主页'], function () {
  var btn = document.querySelector('[data-nav-tab="catalog"]')
         || document.querySelector('[data-root-tab="catalog"]');
  if (btn) btn.click();
});
```

**指令回调通过操作 DOM 触发页面行为**，例如：
- 点击导航栏按钮 → SPA 切换视图
- 点击退出按钮 → 触发登出逻辑

> 重要：voice.js 和业务页面的 DOM 解耦，只通过 `data-*` 属性和 `id` 选择器通信。业务组件需要提供对应的选择器。

### 4.4 录音与编码

```javascript
// 关键参数
var ctx = new AudioContext({ sampleRate: 16000 });  // 百度仅支持 8000/16000
var processor = ctx.createScriptProcessor(4096, 1, 1); // 缓冲区 4096，单声道

// AudioContext → ScriptProcessor → 静音 GainNode → destination
// 必须连接 GainNode（即使静音），否则部分浏览器不触发 onaudioprocess
var silenceGain = ctx.createGain();
silenceGain.gain.value = 0;
processor.connect(silenceGain);
silenceGain.connect(ctx.destination);

// 录音数据收集
processor.onaudioprocess = function (e) {
  var inCh = e.inputBuffer.getChannelData(0);
  var outCh = e.outputBuffer.getChannelData(0);
  for (var i = 0; i < inCh.length; i++) { outCh[i] = inCh[i]; } // 数据直通
  chunks.push(new Float32Array(inCh));
};
```

PCM → WAV 编码在前端完成（44 字节 WAV 头 + PCM 数据），然后 base64 传输。

### 4.5 安全保护

| 机制 | 说明 |
|------|------|
| 最长录音 10 秒 | `setTimeout` 超时自动停止 |
| 识别超时 15 秒 | 防止 `processing` 状态卡死 |
| `processing` 态屏蔽点击 | 防止重复提交 |
| 每次新建 AudioContext | 避免复用导致的状态异常 |

---

## 5. 后端 ASR 调用

### 5.1 Token 管理

```javascript
// 百度 OAuth token 缓存，过期前 1 分钟自动刷新
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const url = `https://aip.baidubce.com/oauth/2.0/token?...`;
  const res = await fetch(url);
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000;
  return cachedToken;
}
```

### 5.2 识别请求

```javascript
const body = JSON.stringify({
  format: 'wav',          // 或 pcm
  rate: 16000,            // 或 8000
  channel: 1,             // 单声道
  cuid: 'online-report-web',
  token: accessToken,
  speech: base64Audio,    // base64 编码的音频数据
  len: audioBytes,        // 原始字节数（解码前长度）
  dev_pid: 1537,          // 1537 = 普通话(带标点)，1536 = 普通话(无标点)
});
```

### 5.3 调试设施

| 设施 | 说明 |
|------|------|
| `voice_logs` 表 | 记录每次识别的文本、用户、调试标签 |
| `debug-audio.wav` | 最近一次录音保存到 `public/` 目录，可直接播放验证音质 |
| `/api/speech/debug` | 前端各阶段写入调试标签（`[START]`、`[REC_OK]`、`[AUDIO]`、`[ASR_FAIL]` 等） |

---

## 6. 常见问题

### 6.1 getUserMedia 返回 false / 麦克风不可用

- **原因**：非 HTTPS 环境
- **排查**：打开 `chrome://webrtc-internals/` 查看 getUserMedia 日志
- **确认**：手机 Chrome 从 Chrome 61+ 开始要求 HTTPS

### 6.2 ScriptProcessor 收到全零数据（peak=0.0000）

即使音轨正常（`enabled=true, muted=false, readyState=live`），`onaudioprocess` 中的采样值全为 0。

可能原因：
- 操作系统麦克风权限未授予浏览器
- 系统声音设置中选择了错误的输入设备
- 浏览器音频路由异常

排查步骤：
1. 访问 `https://www.onlinemictest.com/` 测试麦克风硬件
2. 检查系统偏好设置 → 隐私与安全性 → 麦克风 → 浏览器是否授权
3. 检查 `debug-audio.wav` 文件是否有声音

### 6.3 Baidu ASR 返回 "我不知道" 或识别不准确

- WAV 采样率必须是 8000 或 16000（强制在 AudioContext 构造时指定）
- 确认 `len` 参数等于 base64 解码前的原始字节数
- `dev_pid` 要与语种匹配：1537（普通话）、1737（英语）、1637（粤语）

### 6.4 手机端录音快速取消

- **不要**使用 `pointerdown`/`pointerup` 做按住说话
- 手机浏览器会触发 `pointercancel`（手势检测）
- 使用点击切换模式（tap to start / tap to stop）

### 6.5 指令无法触发操作

- 检查 DOM 选择器是否在页面中存在（voice.js 通过 `data-*` 属性或 `id` 查找元素）
- React/Vue 等框架需要确保组件渲染了对应的 DOM 属性
- 查看 `voice_logs` 表中识别的文字是否包含关键词
- 兼容新旧选择器：`document.querySelector('[data-nav-tab="xxx"]') || document.querySelector('[data-root-tab="xxx"]')`

---

## 7. 接入检查清单

- [ ] 服务器配置 HTTPS（或开发环境用 localhost）
- [ ] `.env` 中设置 `BAIDU_ASR_API_KEY`、`BAIDU_ASR_SECRET_KEY`
- [ ] `.env` 中设置 `VOICE_ENABLED=true`（或省略，默认 true）
- [ ] 创建 `voice_logs` 表
- [ ] HTML 中包含 `<script src="/js/voice.js">`（或通过 onSend 钩子注入）
- [ ] voice.js 文件在静态根目录下可访问（含 SPA 构建产物的兜底）
- [ ] 业务页面中导航按钮有 `data-nav-tab` 属性
- [ ] 业务页面中退出按钮有 `id="btn-settings-logout"`
- [ ] 部署后手机 HTTPS 访问测试：按钮出现 → 点击录音 → 说话 → 再点击 → 查看操作是否执行
- [ ] 查询 `voice_logs` 确认链路日志完整

---

## 8. 移植到其他项目

voice.js 和 speech.js 设计为与具体业务解耦。移植步骤：

1. **后端**：复制 `baidu-asr.js`、`speech.js` 两个文件，修改 JWT 字段名（`decoded.username`）、日志表名
2. **前端**：复制 `voice.js`，修改 `addCmd()` 中的关键词和 DOM 选择器以匹配目标页面
3. **页面**：给需要语音操作的 DOM 元素加 `data-nav-tab` 属性或 `id`
4. **配置**：设置环境变量，注册路由

voice.js 的指令系统通过 `addCmd(keywords, handler)` 扩展，无需改动 core 代码。


---

## 9. 语音动作模板（带参数操作菜单）

> 关键词匹配只能"导航"到菜单页。**语音动作模板**让语音可以「打开 129 号订单」「客户海尔的订单」这类**带参数**的操作：自动跳转到目标菜单 → 预填筛选条件 → 自动触发查询。

### 9.1 数据来源

每个菜单（`nav_menu_items` 表）新增字段 `voice_actions_json`，存储 JSON 数组：

```json
[
  {
    "patterns": ["{n}号订单", "订单{n}", "单号{n}"],
    "fill":     { "DocEntry": "{n}" },
    "autoQuery": true
  },
  {
    "patterns": ["客户{t}的订单", "{t}的订单"],
    "fill":     { "CardName": "{t}" },
    "autoQuery": true
  }
]
```

| 字段 | 说明 |
|---|---|
| `patterns` | 触发模板（数组）。占位符：`{n}` 数字、`{t}` 任意非空文本、`{d}` 日期文本。每条最多 200 字 |
| `fill` | 命中后预填的筛选条件。键须与该菜单 `filter_schema` 中的 `name` 一致；值含占位符 |
| `autoQuery` | 命中后是否自动跑查询，默认 `true` |
| `label` | 可选的展示标签 |

后端 `serializeVoiceActions()` 会清洗：丢弃空 patterns、无效字段、过长内容；最多 50 条。坏 JSON 在保存时直接 400。

### 9.2 配置入口

**菜单设置 → 任一报表菜单 → 「语音动作模板」** 文本框，粘贴 JSON 数组即可。新增菜单也支持在添加表单中配置。

### 9.3 端到端流程

```
用户说「打开 129 号订单」
  ↓ 百度 ASR
text = "打开129号订单"
  ↓ voice.js execVoiceText
tryVoiceActionTemplates(text)
  ↓ 遍历 window.__voiceMenus 各菜单 voiceActions
  ↓ 命中 patterns 中某条
  ↓ 用占位符捕获生成 filters = { DocEntry: "129" }
window.__voiceNavigate(routeKey, filters, { autoQuery: true })
  ↓ store.openMenu(menu, { prefilledFilters, autoQuery })
  ↓ React 切到 dynamic-report
DynamicReportView：optionsReady 后合并 prefilledFilters → setFormValues → runQuery
```

未命中模板 → 回退到原有关键词匹配（打开菜单页）。

### 9.4 占位符与匹配规则

- pattern 与文本都会过 `normalizeVoiceText`（去标点 / 去"打开/进入"前缀 / 小写 / ASR 误听替换），保证两侧一致
- `{n}` → 正则 `(\d+)`
- `{t}` / `{d}` → 正则 `(.+?)`（非贪婪）
- 整体用 `^...$` 锚定，必须**完整匹配**才算命中，避免误触
- 同 pattern 中 `{n}`/`{t}`/`{d}` 出现多次时，`fill` 模板里的占位符**只取该类型的第一组捕获**
- 多个菜单/动作命中时，按 `window.__voiceMenus` 顺序「先到先得」

### 9.5 fill 字段约束

- `fill` 的键必须能在该菜单的 `filter_schema` 中找到对应字段（大小写不敏感）
- 找不到的字段会被前端忽略（不会报错），便于跨菜单复制配置
- 如需让"接单/完工"等 Status 自动选中，可写 `{ "Status": "0" }`（值取自该字段 `options[].code`）

### 9.6 内置钩子

```js
// 由前端 store.ts 挂载
window.__voiceMenus  = NavMenuItem[]   // 含每个菜单的 voiceActions
window.__voiceNavigate(routeKey, filters, { autoQuery }) => boolean
```

ReactNative WebView 内的原生宿主，也可通过 `__voiceNavigate` 触发同等行为（无需经过 `__voiceExec` 关键词匹配）。

### 9.7 配置示例

**生产订单（按单号查）**

```json
[
  {
    "patterns": ["{n}号订单", "订单{n}", "单号{n}"],
    "fill":     { "DocEntry": "{n}" }
  }
]
```

**生产报工（按状态切分段）**

```json
[
  { "patterns": ["接单列表", "待接单"],   "fill": { "Status": "0" } },
  { "patterns": ["完工列表", "待完工"],   "fill": { "Status": "1" } },
  { "patterns": ["恢复列表", "暂停的"],   "fill": { "Status": "8" } }
]
```

**采购订单（按客户查）**

```json
[
  {
    "patterns": ["客户{t}的订单", "{t}的订单"],
    "fill":     { "CardName": "{t}" }
  }
]
```

### 9.8 排障

| 现象 | 排查 |
|---|---|
| 没跳转，仍按关键词打开菜单 | 模板未命中。`voice_logs` 看识别文字；用 normalize 后的文本对照模板 |
| 跳过去了但筛选项没填 | `fill` 键名与 `filter_schema[].name` 不一致；或字段不存在 |
| 跳过去了筛选填了但没自动查 | 模板里 `autoQuery` 设了 `false`，或菜单类型不是 `report` |
| 保存模板时 400 | JSON 格式错误 / patterns 数组为空 / 不是数组 |

