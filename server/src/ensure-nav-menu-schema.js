const fs = require('fs');
const path = require('path');

const SQL_PATH = path.join(__dirname, '..', 'sql', 'migrate-nav-menu-items-only.sql');
const SQL_REPORT_COLS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-report-columns.sql'
);
const SQL_DETAIL_COLS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-detail-columns.sql'
);
const SQL_X_BATCH_PATH = path.join(__dirname, '..', 'sql', 'migrate-x-report-batch.sql');
const SQL_COLUMN_LABELS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-column-labels.sql'
);
const SQL_COLUMN_NAME_MAPPING_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-column-name-mapping.sql'
);
const SQL_X_ONLINE_SIGN_PATH = path.join(__dirname, '..', 'sql', 'migrate-x-online-sign.sql');
const SQL_AI_PROMPT_PATH = path.join(__dirname, '..', 'sql', 'migrate-nav-menu-ai-prompt.sql');
const SQL_VOICE_ACTIONS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-voice-actions.sql'
);
const SQL_RETURNPRO_PICK_LOGS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-returnpro-pick-logs.sql'
);
const SQL_PRO_SIGN_SQL_LOGS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-pro-sign-sql-logs.sql'
);
const SQL_USER_ROLES_PATH = path.join(__dirname, '..', 'sql', 'migrate-user-roles.sql');
const SQL_AI_AGENT_PATH = path.join(__dirname, '..', 'sql', 'migrate-ai-agent.sql');
const SQL_AWT_KIND_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-agent-write-target-kind.sql'
);
const SQL_SKILL_ALLOWED_TABLES_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-agent-skill-allowed-tables.sql'
);
const SQL_MESSAGE_ALERTS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-message-alerts.sql'
);
const SQL_BOT_USER_BINDINGS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-bot-user-bindings.sql'
);
const SQL_SCHEDULED_REPORTS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-scheduled-reports.sql'
);
const SQL_ALERT_PUSH_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-alert-push.sql'
);
const SQL_BOT_MESSAGE_LOGS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-bot-message-logs.sql'
);
const SQL_AGENTS_PATH = path.join(__dirname, '..', 'sql', 'migrate-agents.sql');
const SQL_BI_PATH = path.join(__dirname, '..', 'sql', 'migrate-bi.sql');
const SQL_UI_SETTINGS_PATH = path.join(__dirname, '..', 'sql', 'migrate-ui-settings.sql');

/**
 * 启动时自动执行 migrate-nav-menu-items-only.sql（需账号有建表权限）。
 * 设置 AUTO_CREATE_NAV_MENU_TABLE=false 可关闭。
 */
async function ensureNavMenuSchema(getPool, log) {
  if (process.env.AUTO_CREATE_NAV_MENU_TABLE === 'false') {
    log?.info?.('[nav_menu_items] 跳过自动建表（AUTO_CREATE_NAV_MENU_TABLE=false）');
    return;
  }

  const warn = (msg, err) => {
    if (log && typeof log.warn === 'function') {
      log.warn(err, msg);
    } else {
      console.warn(msg, err || '');
    }
  };

  // 按顺序执行；每个脚本单独 try，一个失败（如依赖的业务表不存在）不影响后面的脚本
  const scripts = [
    SQL_PATH,
    SQL_REPORT_COLS_PATH,
    SQL_DETAIL_COLS_PATH,
    SQL_X_BATCH_PATH,
    SQL_COLUMN_LABELS_PATH,
    SQL_COLUMN_NAME_MAPPING_PATH,
    SQL_X_ONLINE_SIGN_PATH,
    SQL_AI_PROMPT_PATH, // AI Prompt 字段 ai_prompt
    SQL_VOICE_ACTIONS_PATH, // 语音动作模板 voice_actions_json
    SQL_RETURNPRO_PICK_LOGS_PATH,
    SQL_PRO_SIGN_SQL_LOGS_PATH,
    SQL_USER_ROLES_PATH,
    SQL_AI_AGENT_PATH, // AI Agent：skill 注册表 + 会话/消息表
    SQL_AWT_KIND_PATH, // AI Agent：写入目标 target_kind 列（table | action）
    SQL_SKILL_ALLOWED_TABLES_PATH, // AI Agent：skill 的 run_sql 表白名单列
    SQL_MESSAGE_ALERTS_PATH,
    SQL_BOT_USER_BINDINGS_PATH,
    SQL_SCHEDULED_REPORTS_PATH,
    SQL_ALERT_PUSH_PATH,
    SQL_BOT_MESSAGE_LOGS_PATH,
    SQL_AGENTS_PATH, // 可配置 Agent 中心：agents 表
    SQL_BI_PATH, // BI 看板：查询库、看板表、agents.dashboard_key（须在 agents 表之后）
    SQL_UI_SETTINGS_PATH, // 界面设置：公司默认主题 + 用户偏好
  ];

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    warn('[nav_menu_items] 自动建表失败：无法连接数据库', err);
    return;
  }

  const failed = [];
  for (const file of scripts) {
    const name = path.basename(file);
    try {
      await pool.request().query(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      failed.push(name);
      warn(`[nav_menu_items] 迁移脚本执行失败：${name}（请用有 DDL 权限的账号连接，或手动执行该脚本）`, err);
    }
  }

  if (failed.length === 0) {
    log?.info?.(`[nav_menu_items] 已检查/创建表结构（${scripts.length} 个迁移脚本）`);
  } else {
    warn(`[nav_menu_items] ${failed.length}/${scripts.length} 个迁移脚本失败：${failed.join('、')}；其余已执行`);
  }
}

module.exports = ensureNavMenuSchema;
