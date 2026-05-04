# Voice Recognition Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every voice recognition result to a `voice_logs` database table so admins can query what Baidu ASR returned and debug why voice commands may not execute.

**Architecture:** New SQL migration file creates `voice_logs` table. Speech route writes a row after each Baidu ASR call. Frontend `voice.js` attaches JWT token so the backend knows which user spoke. `init-db.js` updated to run the new migration.

**Tech Stack:** SQL Server (mssql), Node.js (Fastify), vanilla JS frontend

---

### Task 1: Create SQL migration file

**Files:**
- Create: `server/sql/migrate-voice-logs.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
IF OBJECT_ID(N'dbo.voice_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.voice_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    recognized_text NVARCHAR(512) NOT NULL,
    user_code NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_voice_logs_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_voice_logs_created ON dbo.voice_logs (created_at);
END;
```

- [ ] **Step 2: Commit**

```bash
git add server/sql/migrate-voice-logs.sql
git commit -m "feat: add voice_logs migration SQL"
```

---

### Task 2: Register migration in init-db.js

**Files:**
- Modify: `server/scripts/init-db.js:29-46`

- [ ] **Step 1: Add the migration path and query execution**

Add after the `migrateXOnlineSign` line:

```js
const migrateVoiceLogs = path.join(__dirname, '..', 'sql', 'migrate-voice-logs.sql');
```

Add after `await pool.request().query(fs.readFileSync(migrateXOnlineSign, 'utf8'));`:

```js
await pool.request().query(fs.readFileSync(migrateVoiceLogs, 'utf8'));
```

- [ ] **Step 2: Commit**

```bash
git add server/scripts/init-db.js
git commit -m "feat: run migrate-voice-logs.sql in init-db"
```

---

### Task 3: Log recognition results in speech route

**Files:**
- Modify: `server/src/routes/speech.js`

- [ ] **Step 1: Add voice_logs insert after successful recognition**

Change the route handler to extract user from JWT (if present) and write a log row:

```js
const { recognize } = require('../baidu-asr');
const { getPool, sql } = require('../db');

async function speechRoutes(fastify) {
  fastify.post('/api/speech/recognize', async (request, reply) => {
    const { audio, format, rate } = request.body || {};

    if (!audio || typeof audio !== 'string') {
      return reply.code(400).send({ error: '缺少音频数据' });
    }

    // Try to extract user from JWT (optional — don't require auth for voice)
    let userCode = null;
    try {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const decoded = fastify.jwt.verify(token);
        userCode = decoded.user_code || null;
      }
    } catch (_) {
      // token invalid or expired — just log without user
    }

    try {
      const padding = (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0);
      const audioBytes = (audio.length / 4) * 3 - padding;

      const text = await recognize(audio, audioBytes, {
        format: format || 'wav',
        rate: rate || 16000,
      });

      // Log to voice_logs table (fire-and-forget — don't block response)
      const pool = await getPool();
      pool.request()
        .input('text', sql.NVarChar(512), text || '')
        .input('user_code', sql.NVarChar(64), userCode)
        .query(`INSERT INTO dbo.voice_logs (recognized_text, user_code) VALUES (@text, @user_code)`)
        .catch(err => fastify.log.error({ err }, 'Failed to insert voice_log'));

      return { text };
    } catch (err) {
      fastify.log.error({ err }, 'Baidu ASR failed');
      return reply.code(502).send({ error: err.message || '语音识别失败' });
    }
  });
}

module.exports = speechRoutes;
```

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/speech.js
git commit -m "feat: log voice recognition results to voice_logs table"
```

---

### Task 4: Send auth token from frontend voice.js

**Files:**
- Modify: `server/public/js/voice.js:211-222`

- [ ] **Step 1: Add Authorization header to the fetch call**

Change the `recognizeAudio` function to include the JWT token:

```js
function recognizeAudio(chunks, sampleRate, cb) {
    var wav = pcmChunksToWav(chunks, sampleRate || 16000);
    var base64 = arrayBufferToBase64(wav);

    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('online_report_token');
    if (token) headers.Authorization = 'Bearer ' + token;

    fetch('/api/speech/recognize', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ audio: base64, format: 'wav', rate: sampleRate || 16000 }),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (json.error) { cb(new Error(json.error)); return; }
        cb(null, json.text || '');
      })
      .catch(function (err) { cb(err); });
  }
```

- [ ] **Step 2: Commit**

```bash
git add server/public/js/voice.js
git commit -m "feat: send JWT token with voice recognition requests"
```

---

### Task 5: Apply migration to production database

- [ ] **Step 1: Run the migration on the deployed database**

```bash
cd server && node -e "
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const sql = require('mssql');
(async () => {
  const pool = await new sql.ConnectionPool({
    server: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    options: { encrypt: process.env.DB_ENCRYPT === 'true', trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false' }
  }).connect();
  await pool.request().query(fs.readFileSync(path.join(__dirname, 'sql', 'migrate-voice-logs.sql'), 'utf8'));
  console.log('voice_logs migration applied successfully');
  await pool.close();
})().catch(e => { console.error(e); process.exit(1); });
"
```

- [ ] **Step 2: Rebuild and restart Docker**

```bash
docker compose -f docker-compose.deploy.yml up -d --build
```

---

### Verification

After deployment, query the logs:

```sql
SELECT TOP 20 * FROM dbo.voice_logs ORDER BY created_at DESC;
```

Test the voice button — each recognition attempt should produce a new row in `voice_logs`.
