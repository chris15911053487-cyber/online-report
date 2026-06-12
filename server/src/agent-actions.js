/**
 * AI Agent「API 动作」注册表（写入目标 target_kind='action' 的执行层）。
 *
 * 安全红线：
 * - 动作只能在本文件用代码注册，管理界面不能配置任意接口/URL/SQL；
 * - 后台（agent_write_targets）只控制某动作是否启用、哪些角色可用；
 * - handler 复用既有业务模块（含其自身的校验与业务日志），LLM 只产出结构化 payload。
 *
 * handler 约定：
 *   async run({ user, payload, log }) → 成功返回结果对象（会作为 inserted 回给 Agent 转述）；
 *   失败 throw Error（message 会原样转述给用户，可设置 err.code）。
 */
const { submitReturnProPick } = require('./returnpro-b1-service');
const { insertReturnProPickLog } = require('./returnpro-pick-log');

const ACTIONS = {
  'returnpro-pick': {
    label: '返工单领料',
    payloadHint:
      '{ "docEntry": 返修单号(可选), "lines": [{ "itemCode": "物料编码(必填)", "quantity": 数量(必填), "whsCode": "仓库(必填)", "batchNum": "批次(批次物料必填)", "lineId": 返修单行号(可选) }] }',
    /** 与 POST /returnpro/pick 同逻辑：B1 提交 + returnpro_pick_logs 业务日志 */
    async run({ user, payload, log }) {
      const userCode = String(user?.username || '').trim();
      const body = payload && typeof payload === 'object' ? payload : {};
      const docEntry = body.docEntry ?? body.DocEntry;
      const lines = body.lines ?? body.Lines;

      const logEntry = {
        userCode: userCode || null,
        docEntry: docEntry != null ? String(docEntry) : null,
        requestJson: { docEntry, lines, via: 'ai-agent' },
        b1RequestJson: null,
        responseJson: null,
        success: false,
        errorCode: null,
        errorMessage: null,
        resultDocEntry: null,
      };

      if (!Array.isArray(lines) || lines.length === 0) {
        logEntry.errorCode = 'RETURNPRO_LINES_EMPTY';
        logEntry.errorMessage = '请至少提交一行领料明细';
        logEntry.responseJson = { api: { error: logEntry.errorMessage, code: logEntry.errorCode } };
        await insertReturnProPickLog(logEntry, log);
        const err = new Error(logEntry.errorMessage);
        err.code = logEntry.errorCode;
        throw err;
      }

      try {
        const result = await submitReturnProPick({ docEntry, lines, userCode }, log);
        logEntry.b1RequestJson = result.b1Request ?? null;
        logEntry.resultDocEntry = result.docEntry != null ? String(result.docEntry) : null;
        logEntry.success = true;
        const apiResponse = {
          ok: true,
          docEntry: result.docEntry,
          message: result.docEntry ? `领料成功，单据号 ${result.docEntry}` : '领料成功',
        };
        logEntry.responseJson = { api: apiResponse, b1: result.b1Response ?? null };
        await insertReturnProPickLog(logEntry, log);
        return apiResponse;
      } catch (err) {
        const code = err.code || 'RETURNPRO_PICK_ERROR';
        logEntry.b1RequestJson = err.b1Request ?? null;
        logEntry.errorCode = code;
        logEntry.errorMessage = err.message || '领料提交失败';
        logEntry.responseJson = {
          api: { error: logEntry.errorMessage, code },
          b1: err.b1Response ?? null,
        };
        await insertReturnProPickLog(logEntry, log);
        throw err;
      }
    },
  },
};

function getAction(name) {
  return ACTIONS[String(name || '').trim().toLowerCase()] || null;
}

function isRegisteredAction(name) {
  return !!getAction(name);
}

/** 管理界面下拉用：[{name,label,payloadHint}] */
function listActions() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    name,
    label: a.label,
    payloadHint: a.payloadHint || '',
  }));
}

module.exports = { getAction, isRegisteredAction, listActions };
