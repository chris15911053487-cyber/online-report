/**
 * 警报定时检查调度器
 *
 * 与 scheduled-reports.js 类似，基于 node-cron 定时执行警报规则检查。
 * 启动时加载所有 trigger_type='cron' 且 enabled=1 的规则，按各自 cron_expr 调度。
 */
const cron = require('node-cron');
const { loadCronRules, executeRule, cleanupSentKeys } = require('./alert-engine');

const pino = require('pino');
const log = pino({ name: 'alert-scheduler' });

const activeTasks = new Map(); // ruleId -> cron.ScheduledTask
let cleanupTask = null;

/**
 * 加载并调度所有定时警报规则
 */
async function loadAndScheduleAlerts(externalLog) {
  const logger = externalLog || log;

  // 停掉旧任务
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();

  let rules = [];
  try {
    rules = await loadCronRules();
  } catch (err) {
    logger.warn?.({ err: err.message }, 'alert_rules 加载失败（表可能不存在）');
    return;
  }

  for (const rule of rules) {
    if (!rule.cron_expr || !cron.validate(rule.cron_expr)) {
      logger.warn?.({ id: rule.id, cron: rule.cron_expr, name: rule.name }, '警报规则 cron 表达式无效，跳过');
      continue;
    }

    const task = cron.schedule(rule.cron_expr, () => {
      executeRule(rule).catch((e) => logger.error?.(e, `警报规则 [${rule.name}] 执行异常`));
    }, { timezone: 'Asia/Shanghai' });

    activeTasks.set(rule.id, task);
  }

  // 每天凌晨2点清理过期 sent_keys
  if (!cleanupTask) {
    cleanupTask = cron.schedule('0 2 * * *', () => {
      cleanupSentKeys(7).catch((e) => logger.error?.(e, '清理 alert_sent_keys 失败'));
    }, { timezone: 'Asia/Shanghai' });
  }

  logger.info?.({ count: activeTasks.size }, '警报定时规则已加载');
}

/**
 * 停止所有警报调度任务
 */
function stopAllAlerts() {
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
  }
}

/**
 * 获取当前活跃任务数
 */
function getActiveAlertCount() {
  return activeTasks.size;
}

module.exports = { loadAndScheduleAlerts, stopAllAlerts, getActiveAlertCount };
