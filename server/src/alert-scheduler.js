/**
 * 警报定时检查调度器
 *
 * 与 scheduled-reports.js 类似，基于 node-cron 定时执行警报规则检查。
 * 启动时加载所有 trigger_type='cron' 且 enabled=1 的规则，按各自 cron_expr 调度。
 */
const cron = require('node-cron');
const { loadCronRules, executeRule, cleanupSentKeys } = require('./alert-engine');
const { runTaskDigest } = require('./tasks');

const pino = require('pino');
const log = pino({ name: 'alert-scheduler' });

const activeTasks = new Map(); // ruleId -> cron.ScheduledTask
let cleanupTask = null;
const digestTasks = [];

/** 待办推送时间：TASK_DIGEST_CRON 早上汇总（默认 7:30）、TASK_RECHECK_CRON 下午复查（默认 15:00）；设为 off 关闭 */
function digestSchedules() {
  const pick = (v, d) => {
    const s = String(v ?? '').trim();
    if (s.toLowerCase() === 'off') return null;
    return s || d;
  };
  return [
    { kind: 'morning', cron: pick(process.env.TASK_DIGEST_CRON, '30 7 * * *') },
    { kind: 'afternoon', cron: pick(process.env.TASK_RECHECK_CRON, '0 15 * * *') },
  ].filter((x) => x.cron);
}

/** 汇总前先全量同步定时待办规则，保证推的是最新数据 */
function runDigest(kind, logger) {
  return runTaskDigest({ kind, syncRules: (rule) => executeRule(rule) })
    .then((r) => logger.info?.({ kind, ...r }, '待办汇总已推送'))
    .catch((e) => logger.error?.(e, `待办汇总（${kind}）失败`));
}

/**
 * 加载并调度所有定时警报规则
 */
async function loadAndScheduleAlerts(externalLog) {
  const logger = externalLog || log;

  // 停掉旧任务
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();

  // 待办汇总先注册：规则加载失败（如启动时库没连上）也不影响每天的推送
  if (digestTasks.length === 0) {
    for (const d of digestSchedules()) {
      if (!cron.validate(d.cron)) {
        logger.warn?.({ kind: d.kind, cron: d.cron }, '待办推送 cron 表达式无效，跳过');
        continue;
      }
      digestTasks.push(cron.schedule(d.cron, () => void runDigest(d.kind, logger), { timezone: 'Asia/Shanghai' }));
    }
  }

  let rules = [];
  try {
    rules = await loadCronRules();
  } catch (err) {
    logger.warn?.({ err: err.message }, 'alert_rules 加载失败（表可能不存在）');
    return;
  }

  for (const rule of rules) {
    // 待办规则可以不填 cron：只在早上汇总、下午复查前同步
    if (rule.output_mode === 'task' && !String(rule.cron_expr || '').trim()) continue;
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
  for (const t of digestTasks.splice(0)) t.stop();
}

/**
 * 获取当前活跃任务数
 */
function getActiveAlertCount() {
  return activeTasks.size;
}

module.exports = { loadAndScheduleAlerts, stopAllAlerts, getActiveAlertCount, runDigest };
