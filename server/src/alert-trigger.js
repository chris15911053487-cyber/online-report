/**
 * 警报事件触发钩子
 *
 * 提供简单的 API 供业务代码在关键节点调用，异步触发警报（不阻塞主业务流程）。
 *
 * 使用方式：
 *   const { emitAlertEvent } = require('../alert-trigger');
 *
 *   // 在单据保存成功后
 *   emitAlertEvent('pro-sign-complete', { DocEntry: 123, StepName: '装配', ... });
 *
 * 预定义事件名称（建议约定）：
 *   - 'pro-sign-save'       合并报工保存（接单/完工/暂停/恢复）
 *   - 'order-create'        订单创建
 *   - 'order-status-change' 订单状态变更
 *   - 'inventory-low'       库存低于阈值（也可用 cron 定时检查）
 *   - 'quality-reject'      质检不合格
 *   - 自定义事件名...
 *
 * 注意：emitAlertEvent 是异步非阻塞的，不会因为警报发送失败而影响业务。
 */
const { triggerEvent } = require('./alert-engine');

const pino = require('pino');
const log = pino({ name: 'alert-trigger' });

/**
 * 触发一个警报事件（异步，不阻塞调用方）
 *
 * @param {string} eventName - 事件名称
 * @param {object|object[]} eventData - 事件关联数据，用于模板渲染
 * @param {object} [options] - 选项
 * @param {object} [options.log] - 日志实例
 */
function emitAlertEvent(eventName, eventData, options) {
  const logger = options?.log || log;

  // 异步执行，不等待结果
  setImmediate(() => {
    triggerEvent(eventName, eventData)
      .then((result) => {
        if (result.rulesTriggered > 0) {
          logger.info?.({
            event: eventName,
            rulesTriggered: result.rulesTriggered,
            totalSent: result.totalSent,
          }, '事件触发警报已发送');
        }
      })
      .catch((err) => {
        logger.error?.({ err: err.message, event: eventName }, '事件触发警报异常');
      });
  });
}

module.exports = { emitAlertEvent };
