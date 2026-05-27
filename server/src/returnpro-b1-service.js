/**
 * SAP B1 WCF Web Service (B1Service.svc/Web): Login + AddObject for returnpro pick.
 *
 * Env (see server/.env.example):
 *   RETURNPRO_B1_BASE_URL, B1_* credentials, RETURNPRO_B1_OBJECT_TYPE, ...
 */

function trimEnv(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

function trimEnvOrFallback(primary, fallback) {
  const p = trimEnv(primary);
  if (p) return p;
  return trimEnv(fallback);
}

function getTimeoutMs() {
  const n = Number(trimEnv('RETURNPRO_B1_TIMEOUT_MS') || '60000');
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function getBaseUrl() {
  const base = trimEnv('RETURNPRO_B1_BASE_URL');
  if (!base) {
    const err = new Error('未配置 RETURNPRO_B1_BASE_URL（SAP B1 Web 服务地址）');
    err.code = 'RETURNPRO_B1_NOT_CONFIGURED';
    throw err;
  }
  return base.replace(/\/$/, '');
}

function buildLoginBody() {
  const dataBaseServer = trimEnvOrFallback('B1_DATABASE_SERVER', 'DB_HOST');
  const dataBaseName = trimEnvOrFallback('B1_DATABASE_NAME', 'DB_NAME');
  const dataBaseUser = trimEnvOrFallback('B1_DATABASE_USER', 'DB_USER');
  const dataBasePassword = trimEnvOrFallback('B1_DATABASE_PASSWORD', 'DB_PASSWORD');
  const companyUser = trimEnv('B1_COMPANY_USER');
  const companyPassword = trimEnv('B1_COMPANY_PASSWORD');

  if (!dataBaseServer || !dataBaseName || !companyUser || !companyPassword) {
    const err = new Error(
      'B1 登录配置不完整：需 B1_DATABASE_SERVER/NAME、B1_COMPANY_USER、B1_COMPANY_PASSWORD（数据库账号可复用 DB_HOST/DB_NAME/DB_USER/DB_PASSWORD）',
    );
    err.code = 'RETURNPRO_B1_NOT_CONFIGURED';
    throw err;
  }

  return {
    DataBaseServer: dataBaseServer,
    DataBaseName: dataBaseName,
    DataBaseType: trimEnv('B1_DATABASE_TYPE') || '1',
    DataBaseUserName: dataBaseUser || 'sa',
    DataBasePassword: dataBasePassword,
    CompanyUserName: companyUser,
    CompanyPassword: companyPassword,
    Language: trimEnv('B1_LANGUAGE') || 'ln_Chinese',
    LicenseServer: trimEnv('B1_LICENSE_SERVER'),
    Port: trimEnv('B1_PORT') || '30015',
  };
}

let cachedSession = null;
let sessionExpiresAt = 0;

function getSessionTtlMs() {
  const n = Number(trimEnv('RETURNPRO_B1_SESSION_TTL_MS') || '1500000');
  return Number.isFinite(n) && n > 60000 ? n : 1500000;
}

function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const found = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found != null && obj[found] != null && String(obj[found]).trim() !== '') {
      return String(obj[found]).trim();
    }
  }
  return '';
}

function findSessionIdDeep(val, depth = 0) {
  if (depth > 6 || val == null || typeof val !== 'object') return '';
  const direct = pickFirstString(val, ['SessionID', 'sessionId', 'session_id']);
  if (direct) return direct;
  for (const v of Object.values(val)) {
    if (v && typeof v === 'object') {
      const found = findSessionIdDeep(v, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function parseB1Error(json, fallbackText) {
  if (!json || typeof json !== 'object') return fallbackText || 'B1 服务返回异常';
  const msg = pickFirstString(json, [
    'ErrorMsg',
    'ErrMsg',
    'Message',
    'msg',
    'error',
    'ErrorMessage',
    'ResultMessage',
  ]);
  if (msg) return msg;
  const nested = json.Result || json.result || json.Data || json.data;
  if (nested && nested !== json) {
    const inner = parseB1Error(nested, '');
    if (inner) return inner;
  }
  return fallbackText || 'B1 服务返回失败';
}

function isSessionInvalidMessage(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    s.includes('session') ||
    s.includes('login') ||
    s.includes('未登录') ||
    s.includes('过期') ||
    s.includes('expired')
  );
}

async function b1Post(operation, body, log) {
  const url = `${getBaseUrl()}/${operation}`;
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`B1 请求超时（${timeoutMs}ms）`);
      err.code = 'RETURNPRO_B1_TIMEOUT';
      throw err;
    }
    const err = new Error(`无法连接 B1 服务：${e.message || String(e)}`);
    err.code = 'RETURNPRO_B1_NETWORK';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(
      res.ok ? 'B1 返回非 JSON' : `B1 HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
    err.code = 'RETURNPRO_B1_BAD_RESPONSE';
    throw err;
  }

  if (!res.ok) {
    log?.warn?.({ status: res.status, operation, json }, 'returnpro B1 HTTP error');
    const err = new Error(parseB1Error(json, `B1 HTTP ${res.status}`));
    err.code = 'RETURNPRO_B1_HTTP_ERROR';
    err.httpStatus = res.status;
    err.b1Response = json;
    throw err;
  }

  return json;
}

async function login(log) {
  const body = buildLoginBody();
  const json = await b1Post('Login', body, log);
  const sessionId = findSessionIdDeep(json);
  if (!sessionId) {
    const err = new Error(parseB1Error(json, 'B1 Login 未返回 SessionID'));
    err.code = 'RETURNPRO_B1_LOGIN_FAILED';
    err.b1Response = json;
    throw err;
  }
  cachedSession = sessionId;
  sessionExpiresAt = Date.now() + getSessionTtlMs();
  return sessionId;
}

async function getSessionId(log, forceRefresh = false) {
  if (!forceRefresh && cachedSession && Date.now() < sessionExpiresAt - 30000) {
    return cachedSession;
  }
  return login(log);
}

function todayDocDateIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00`;
}

function toNumberOrNull(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function isBatchLine(line) {
  const v = line.manBtchNum ?? line.ManBtchNum;
  return String(v ?? '').trim().toUpperCase() === 'Y';
}

/**
 * @param {{ docEntry: unknown, lines: object[], userCode: string }} input
 */
function buildAddObjectBody(input) {
  const docEntry = input.docEntry != null ? String(input.docEntry).trim() : '';
  const userCode = String(input.userCode || '').trim();
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) {
    const err = new Error('领料明细不能为空');
    err.code = 'RETURNPRO_BAD_REQUEST';
    throw err;
  }

  const objectType = trimEnv('RETURNPRO_B1_OBJECT_TYPE') || 'oInventoryGenExit';
  const bplId = toNumberOrNull(trimEnv('RETURNPRO_B1_BPL_ID'));

  const mainRow = {
    DocDate: todayDocDateIso(),
    Comments: `返修单领料${docEntry ? ` DocEntry=${docEntry}` : ''}${userCode ? ` 操作员=${userCode}` : ''}`,
  };
  if (bplId != null) mainRow.BPLId = bplId;

  const cardCode = trimEnv('RETURNPRO_B1_CARD_CODE');
  if (cardCode) {
    mainRow.CardCode = cardCode;
    const cardName = trimEnv('RETURNPRO_B1_CARD_NAME');
    if (cardName) mainRow.CardName = cardName;
  }

  const detail = [];
  const btnt = [];

  lines.forEach((line, idx) => {
    const itemCode = String(line.itemCode ?? line.ItemCode ?? '').trim();
    const qty = toNumberOrNull(line.quantity ?? line.Quantity);
    if (!itemCode || qty == null || qty <= 0) {
      const err = new Error(`第 ${idx + 1} 行：物料或数量无效`);
      err.code = 'RETURNPRO_BAD_REQUEST';
      throw err;
    }

    const row = {
      LineNum: idx,
      ItemCode: itemCode,
      Quantity: qty,
    };

    const desc = line.itemName ?? line.ItemName ?? line.uSpec ?? line.U_Spec;
    if (desc != null && String(desc).trim()) row.Dscription = String(desc).trim();

    const whs =
      line.uWhsCode ??
      line.U_WhsCode ??
      line.whsCode ??
      line.WhsCode;
    const whsStr = whs != null ? String(whs).trim() : '';
    if (!whsStr) {
      const err = new Error(`第 ${idx + 1} 行：缺少仓库（U_WhsCode）`);
      err.code = 'RETURNPRO_BAD_REQUEST';
      throw err;
    }
    row.WhsCode = whsStr;
    row.U_WhsCode = whsStr;

    const unit = line.uUnit ?? line.U_Unit;
    if (unit != null && String(unit).trim()) row.unitMsr = String(unit).trim();

    const baseType = toNumberOrNull(line.baseType ?? line.BaseType);
    const baseEntry = toNumberOrNull(line.baseEntry ?? line.BaseEntry);
    const baseLine = toNumberOrNull(line.baseLine ?? line.BaseLine);
    if (baseType != null) row.BaseType = baseType;
    if (baseEntry != null) row.BaseEntry = baseEntry;
    if (baseLine != null) row.BaseLine = baseLine;

    detail.push(row);

    const batchNum = String(line.batchNum ?? line.BatchNum ?? '').trim();
    if (isBatchLine(line) && batchNum) {
      btnt.push({
        LineNum: idx,
        BatchNum: batchNum,
        Quantity: qty,
      });
    }
  });

  return {
    ObjectType: objectType,
    Data: {
      MAIN: [mainRow],
      DELETE: [],
      DETAIL: detail,
      BTNT: btnt,
    },
  };
}

function parseAddObjectSuccess(json) {
  const docEntry = pickFirstString(json, [
    'DocEntry',
    'docEntry',
    'DocNum',
    'docNum',
    'Key',
    'key',
  ]);
  if (!docEntry) {
    const nested = json.Result || json.result || json.Data || json.data;
    if (nested && typeof nested === 'object') {
      return parseAddObjectSuccess(nested);
    }
  }

  const successFlag = json.Success ?? json.success ?? json.Ok ?? json.ok;
  const firstVal =
    json && typeof json === 'object' && !Array.isArray(json)
      ? Object.values(json)[0]
      : undefined;
  const isFailureZero =
    firstVal === 0 ||
    firstVal === 0n ||
    (typeof firstVal === 'string' && firstVal.trim() === '0');

  if (successFlag === false || isFailureZero) {
    return { ok: false, message: parseB1Error(json, 'AddObject 失败'), docEntry: null };
  }

  if (successFlag === true || docEntry) {
    return { ok: true, message: '', docEntry: docEntry || null };
  }

  const errMsg = parseB1Error(json, '');
  if (errMsg && errMsg !== 'B1 服务返回失败') {
    return { ok: false, message: errMsg, docEntry: null };
  }

  return { ok: true, message: '', docEntry: docEntry || null };
}

async function addObject(sessionId, addBody, log) {
  const payload = {
    SessionID: sessionId,
    ObjectType: addBody.ObjectType,
    Data: addBody.Data,
  };
  const json = await b1Post('AddObject', payload, log);
  const parsed = parseAddObjectSuccess(json);
  if (!parsed.ok) {
    const err = new Error(parsed.message);
    err.code = 'RETURNPRO_B1_ADD_OBJECT_FAILED';
    err.b1Response = json;
    throw err;
  }
  return { b1Response: json, docEntry: parsed.docEntry };
}

/**
 * @param {{ docEntry: unknown, lines: object[], userCode: string }} input
 * @param {import('fastify').FastifyBaseLogger} [log]
 */
async function submitReturnProPick(input, log) {
  const addBody = buildAddObjectBody(input);

  let sessionId = await getSessionId(log, false);
  try {
    return await addObject(sessionId, addBody, log);
  } catch (e) {
    if (e.code === 'RETURNPRO_B1_ADD_OBJECT_FAILED' && isSessionInvalidMessage(e.message)) {
      sessionId = await getSessionId(log, true);
      return addObject(sessionId, addBody, log);
    }
    throw e;
  }
}

module.exports = {
  buildAddObjectBody,
  submitReturnProPick,
  login,
  getSessionId,
};
