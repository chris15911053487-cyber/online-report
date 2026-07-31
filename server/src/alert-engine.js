/**
 * 警报引擎核心模块
 *
 * 职责：
 * 1. 执行规则 SQL，判断是否触发
 * 2. 去重（cooldown + sent_keys）
 * 3. 渲染卡片并调用 alert-dingtalk 发送
 * 4. 写入推送日志
 *
 * 支持两种触发方式：
 * - cron: 定时执行 SQL，有结果即触发
 * - event: 外部调用 triggerEvent()，传入事件数据
 */
const { getPool, sql } = require('./db');
const { sendAlertCard, buildCardFromRule } = require('./alert-dingtalk');

const pino = require('pino');
const log = pino({ name: 'alert-engine' });

// ==================== 规则加载 ====================

/**
 * 加载所有启用的定时规则
 */
async function loadCronRules() {
  const pool = await getPool();
  const rs = await pool.request().query(
    `SELECT * FROM dbo.alert_rules WHERE trigger_type = 'cron' AND enabled = 1 ORDER BY sort_order, id`
  );
  return rs.recordset || [];
}

/**
 * 加载匹配指定事件名的所有启用规则
 */
async function loadEventRules(eventName) {
  const pool = await getPool();
  const rs = await pool.request()
    .input('ev', sql.VarChar(64), eventName)
    .query(`SELECT * FROM dbo.alert_rules WHERE trigger_type = 'event' AND event_name = @ev AND enabled = 1 ORDER BY sort_order, id`);
  return rs.recordset || [];
}

/**
 * 根据 ID 加载单条规则
 */
async function loadRuleById(ruleId) {
  const pool = await getPool();
  const rs = await pool.request()
    .input('id', sql.Int, ruleId)
    .query('SELECT * FROM dbo.alert_rules WHERE id = @id');
  return rs.recordset?.[0] || null;
}

// ==================== 规则评估（SQL 执行） ====================

/**
 * 执行规则的检查 SQL，返回结果行
 * SQL 支持 @_loginUser 等占位符（注入为系统用户 SYSTEM）
 */
async function evaluateRuleSql(rule) {
  if (!rule.sql_template) return [];

  const pool = await getPool();
  const request = pool.request();

  // 注入常用参数（与 report-query 约定一致）
  const systemUser = process.env.ALERT_SYSTEM_USER || 'SYSTEM';
  request.input('_loginUser', sql.NVarChar(64), systemUser);
  request.input('_loginDisplayName', sql.NVarChar(128), systemUser);
  request.input('UserCode', sql.NVarChar(64), systemUser);
  request.input('UserId', sql.NVarChar(64), systemUser);
  request.input('UserName', sql.NVarChar(128), systemUser);

  try {
    const rs = await request.query(rule.sql_template);
    return rs.recordset || [];
  } catch (err) {
    log.error({ err: err.message, ruleId: rule.id, ruleName: rule.name }, '规则 SQL 执行失败');
    throw err;
  }
}

// ==================== 去重逻辑 ====================

/**
 * 过滤掉冷却期内已发送过的数据行
 * @param {number} ruleId - 规则 ID
 * @param {object[]} rows - 数据行
 * @param {string} keyColumn - 去重键列名
 * @param {number} cooldownMinutes - 冷却时间（分钟）
 * @returns {Promise<object[]>} 过滤后的新行
 */
async function filterByCooldown(ruleId, rows, keyColumn, cooldownMinutes) {
  if (!keyColumn || cooldownMinutes <= 0 || rows.length === 0) return rows;

  const pool = await getPool();

  // 获取该规则的已发送记录
  const rs = await pool.request()
    .input('rid', sql.Int, ruleId)
    .input('cd', sql.Int, cooldownMinutes)
    .query(
      `SELECT item_key FROM dbo.alert_sent_keys
       WHERE rule_id = @rid
         AND last_sent_at > DATEADD(MINUTE, -@cd, DATEADD(HOUR, 8, SYSUTCDATETIME()))`
    );

  const sentKeys = new Set((rs.recordset || []).map((r) => String(r.item_key)));

  return rows.filter((row) => {
    const key = extractKey(row, keyColumn);
    return key && !sentKeys.has(key);
  });
}

/**
 * 记录已发送的键（MERGE upsert）
 */
async function recordSentKeys(ruleId, rows, keyColumn) {
  if (!keyColumn || rows.length === 0) return;

  const pool = await getPool();
  for (const row of rows) {
    const key = extractKey(row, keyColumn);
    if (!key) continue;
    await pool.request()
      .input('rid', sql.Int, ruleId)
      .input('key', sql.NVarChar(512), key)
      .query(
        `MERGE dbo.alert_sent_keys AS t
         USING (SELECT @rid AS rule_id, @key AS item_key) AS s
           ON t.rule_id = s.rule_id AND t.item_key = s.item_key
         WHEN MATCHED THEN UPDATE SET last_sent_at = DATEADD(HOUR, 8, SYSUTCDATETIME())
         WHEN NOT MATCHED THEN INSERT (rule_id, item_key, last_sent_at)
           VALUES (@rid, @key, DATEADD(HOUR, 8, SYSUTCDATETIME()));`
      );
  }
}

function extractKey(row, keyColumn) {
  const val = row[keyColumn];
  if (val == null) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val).trim();
}

// ==================== 日志记录 ====================

async function createAlertLog(ruleId, ruleName, triggerType, eventName) {
  const pool = await getPool();
  const rs = await pool.request()
    .input('rid', sql.Int, ruleId)
    .input('rn', sql.NVarChar(128), ruleName)
    .input('tt', sql.VarChar(16), triggerType)
    .input('ev', sql.VarChar(64), eventName || null)
    .query(
      `INSERT INTO dbo.alert_logs (rule_id, rule_name, trigger_type, event_name, status)
       VALUES (@rid, @rn, @tt, @ev, 'pending');
       SELECT SCOPE_IDENTITY() AS id`
    );
  return rs.recordset[0].id;
}

async function updateAlertLog(logId, status, targetCount, sentCount, webhookCount, cardTitle, cardBody, dataSnapshot, errorMsg) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, logId)
    .input('s', sql.VarChar(16), status)
    .input('tc', sql.Int, targetCount)
    .input('sc', sql.Int, sentCount)
    .input('wc', sql.Int, webhookCount)
    .input('ct', sql.NVarChar(256), cardTitle || null)
    .input('cb', sql.NVarChar(sql.MAX), cardBody || null)
    .input('ds', sql.NVarChar(sql.MAX), dataSnapshot || null)
    .input('err', sql.NVarChar(1000), errorMsg || null)
    .query(
      `UPDATE dbo.alert_logs SET
         status = @s, target_count = @tc, sent_count = @sc, webhook_count = @wc,
         card_title = @ct, card_body = @cb, data_snapshot = @ds, error_message = @err,
         finished_at = DATEADD(HOUR, 8, SYSUTCDATETIME())
       WHERE id = @id`
    );
}

// ==================== 核心执行：评估 + 发送 ====================

/**
 * 执行单条定时规则的完整流程：SQL评估 → 去重 → 渲染 → 发送 → 日志
 * @param {object} rule - alert_rules 行
 * @returns {Promise<{triggered: boolean, sentCount: number}>}
 */
async function executeRule(rule) {
  const logId = await createAlertLog(rule.id, rule.name, 'cron', null);

  try {
    // 1. 执行 SQL 获取数据
    const rows = await evaluateRuleSql(rule);
    if (!rows || rows.length === 0) {
      await updateAlertLog(logId, 'skipped', 0, 0, 0, null, null, null, '无触发数据');
      return { triggered: false, sentCount: 0 };
    }

    // 2. 去重过滤
    const filteredRows = await filterByCooldown(rule.id, rows, rule.key_column, rule.cooldown_minutes || 60);
    if (filteredRows.length === 0) {
      await updateAlertLog(logId, 'skipped', 0, 0, 0, null, null, null, '所有数据在冷却期内');
      return { triggered: false, sentCount: 0 };
    }

    // 3. 构建卡片
    const card = buildCardFromRule(rule, filteredRows);

    // 4. 发送
    const result = await sendAlertCard(rule, card);

    // 5. 记录已发送键
    await recordSentKeys(rule.id, filteredRows, rule.key_column);

    // 6. 更新日志
    const dataSnapshot = JSON.stringify(filteredRows.slice(0, 5)).slice(0, 4000);
    const status = result.errors.length > 0 ? (result.usersSent > 0 || result.webhooksSent > 0 ? 'sent' : 'failed') : 'sent';
    const errorMsg = result.errors.length > 0 ? result.errors.join('; ').slice(0, 1000) : null;

    await updateAlertLog(
      logId, status, result.usersSent, result.usersSent, result.webhooksSent,
      card.title, card.markdown?.slice(0, 4000), dataSnapshot, errorMsg
    );

    log.info({
      ruleId: rule.id, name: rule.name,
      rows: filteredRows.length, usersSent: result.usersSent, webhooksSent: result.webhooksSent,
    }, '警报已触发并发送');

    return { triggered: true, sentCount: result.usersSent + result.webhooksSent };
  } catch (err) {
    await updateAlertLog(logId, 'failed', 0, 0, 0, null, null, null, String(err.message).slice(0, 1000));
    log.error({ err: err.message, ruleId: rule.id }, '警报执行失败');
    return { triggered: false, sentCount: 0 };
  }
}

/**
 * 事件触发入口：外部业务逻辑调用此方法触发警报
 * @param {string} eventName - 事件名称（如 'pro-sign-complete', 'order-create'）
 * @param {object|object[]} eventData - 事件关联的数据（传入模板渲染）
 * @returns {Promise<{rulesTriggered: number, totalSent: number}>}
 */
async function triggerEvent(eventName, eventData) {
  const rules = await loadEventRules(eventName);
  if (rules.length === 0) return { rulesTriggered: 0, totalSent: 0 };

  let rulesTriggered = 0;
  let totalSent = 0;

  const dataRows = Array.isArray(eventData) ? eventData : [eventData || {}];

  for (const rule of rules) {
    const logId = await createAlertLog(rule.id, rule.name, 'event', eventName);

    try {
      // 事件触发模式：先检查去重
      let filteredRows = dataRows;
      if (rule.key_column) {
        filteredRows = await filterByCooldown(rule.id, dataRows, rule.key_column, rule.cooldown_minutes || 60);
        if (filteredRows.length === 0) {
          await updateAlertLog(logId, 'skipped', 0, 0, 0, null, null, null, '事件数据在冷却期内');
          continue;
        }
      }

      // 如果规则配置了 SQL，还可以进一步做条件判断
      if (rule.sql_template) {
        const sqlRows = await evaluateRuleSql(rule);
        if (!sqlRows || sqlRows.length === 0) {
          await updateAlertLog(logId, 'skipped', 0, 0, 0, null, null, null, '事件触发但条件SQL无结果');
          continue;
        }
        // 用 SQL 结果替代事件数据（SQL 可能做了 JOIN 或过滤）
        filteredRows = sqlRows;
        if (rule.key_column) {
          filteredRows = await filterByCooldown(rule.id, sqlRows, rule.key_column, rule.cooldown_minutes || 60);
          if (filteredRows.length === 0) {
            await updateAlertLog(logId, 'skipped', 0, 0, 0, null, null, null, 'SQL结果在冷却期内');
            continue;
          }
        }
      }

      // 构建卡片并发送
      const card = buildCardFromRule(rule, filteredRows);
      const result = await sendAlertCard(rule, card);

      // 记录去重键
      if (rule.key_column) {
        await recordSentKeys(rule.id, filteredRows, rule.key_column);
      }

      const dataSnapshot = JSON.stringify(filteredRows.slice(0, 5)).slice(0, 4000);
      const status = result.errors.length > 0 ? (result.usersSent > 0 || result.webhooksSent > 0 ? 'sent' : 'failed') : 'sent';
      const errorMsg = result.errors.length > 0 ? result.errors.join('; ').slice(0, 1000) : null;

      await updateAlertLog(
        logId, status, result.usersSent, result.usersSent, result.webhooksSent,
        card.title, card.markdown?.slice(0, 4000), dataSnapshot, errorMsg
      );

      if (status === 'sent') {
        rulesTriggered++;
        totalSent += result.usersSent + result.webhooksSent;
      }
    } catch (err) {
      await updateAlertLog(logId, 'failed', 0, 0, 0, null, null, null, String(err.message).slice(0, 1000));
      log.error({ err: err.message, ruleId: rule.id, event: eventName }, '事件警报执行失败');
    }
  }

  return { rulesTriggered, totalSent };
}

// ==================== 清理过期的 sent_keys ====================

/**
 * 清理超过最大冷却时间的已发送记录（建议每天执行一次）
 */
async function cleanupSentKeys(maxAgeDays = 7) {
  const pool = await getPool();
  await pool.request()
    .input('days', sql.Int, maxAgeDays)
    .query(
      `DELETE FROM dbo.alert_sent_keys
       WHERE last_sent_at < DATEADD(DAY, -@days, DATEADD(HOUR, 8, SYSUTCDATETIME()))`
    );
}

module.exports = {
  loadCronRules,
  loadEventRules,
  loadRuleById,
  evaluateRuleSql,
  executeRule,
  triggerEvent,
  cleanupSentKeys,
};
