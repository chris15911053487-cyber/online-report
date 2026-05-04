# 语音识别日志设计

**目标**：在后台数据库记录每次语音识别的文字内容，方便排查语音指令未执行的问题。

**范围**：后端新增 `voice_logs` 表 + 日志写入逻辑，前端不改动。

---

## 数据库

### 新表 `voice_logs`

```sql
IF OBJECT_ID(N'dbo.voice_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.voice_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    recognized_text NVARCHAR(512) NOT NULL,
    matched_command NVARCHAR(128) NULL,
    is_success BIT NOT NULL DEFAULT (0),
    user_code NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_voice_logs_created ON dbo.voice_logs (created_at);
END;
```

字段说明：
- `recognized_text`：百度 ASR 返回的识别文字
- `matched_command`：匹配到的指令名称（如"返回主界面"），未匹配则为 NULL
- `is_success`：是否成功执行了指令
- `user_code`：当前登录用户（从 JWT 解析）
- `created_at`：记录时间

## 后端改动

### 1. 新建迁移脚本 `server/sql/migrate-voice-logs.sql`

包含上述建表 SQL。

### 2. 修改 `server/src/routes/speech.js`

识别成功后写入 `voice_logs` 表：
- 获取当前用户（从 JWT token 解析，但语音接口目前未要求认证 — 需要让前端在请求中带 token）
- 写入 `recognized_text`、`user_code`
- `matched_command` 和 `is_success` 暂不填（前端才知道匹配结果），或者后端也做一次匹配

**简化方案**：后端只记录 `recognized_text` 和 `user_code`，`matched_command` 和 `is_success` 由前端可选的后续请求更新，或暂时留空。

### 3. 修改 `server/scripts/init-db.js`

添加执行 `migrate-voice-logs.sql`。

## 前端

不变。语音流程保持：
1. 按住录音 → 松开 → 发送到 `/api/speech/recognize`
2. 收到文字 → `match(text)` → 执行指令

## 部署

Docker 需要重新构建以包含新的 SQL 迁移文件。
