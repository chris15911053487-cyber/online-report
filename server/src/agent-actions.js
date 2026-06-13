/**
 * AI Agent「API 动作」自动加载器。
 *
 * 扫描 server/src/actions/ 目录下所有 .js 文件并注册为可用动作。
 * 每个文件须 module.exports 导出：{ name, label, payloadHint, run }
 *
 * 新增动作只需在 actions/ 目录下新建文件，重启服务即可生效。
 */
const fs = require('fs');
const path = require('path');

const ACTIONS = {};

const actionsDir = path.join(__dirname, 'actions');
if (fs.existsSync(actionsDir)) {
  for (const file of fs.readdirSync(actionsDir)) {
    if (!file.endsWith('.js')) continue;
    try {
      const mod = require(path.join(actionsDir, file));
      const name = String(mod.name || path.basename(file, '.js')).trim().toLowerCase();
      if (name && typeof mod.run === 'function') {
        ACTIONS[name] = {
          label: mod.label || name,
          payloadHint: mod.payloadHint || '',
          run: mod.run,
        };
      }
    } catch (err) {
      console.error(`[agent-actions] 加载 ${file} 失败:`, err.message);
    }
  }
}

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
