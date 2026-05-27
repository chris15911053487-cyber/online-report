/**
 * SAP B1 WCF Web Service: AddDocuments for returnpro pick.
 *
 * Env (see server/.env.example):
 *   RETURNPRO_B1_BASE_URL, RETURNPRO_B1_ADD_DOCUMENTS_PATH
 */

function trimEnv(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
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

function getAddDocumentsPath() {
  const path = trimEnv('RETURNPRO_B1_ADD_DOCUMENTS_PATH') || '/WEB/AddDocuments';
  return path.startsWith('/') ? path : `/${path}`;
}

function getAddDocumentsUrl() {
  return `${getBaseUrl()}${getAddDocumentsPath()}`;
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

async function b1PostAddDocuments(body, log) {
  const url = getAddDocumentsUrl();
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
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const err = new Error(
      res.ok
        ? 'B1 返回非 JSON'
        : `B1 HTTP ${res.status}（${url}）：${preview || '无响应体'}`,
    );
    err.code = res.status === 404 ? 'RETURNPRO_B1_NOT_FOUND' : 'RETURNPRO_B1_BAD_RESPONSE';
    err.b1Url = url;
    throw err;
  }

  if (!res.ok) {
    log?.warn?.({ status: res.status, url, json }, 'returnpro B1 HTTP error');
    const err = new Error(parseB1Error(json, `B1 HTTP ${res.status}`));
    err.code = 'RETURNPRO_B1_HTTP_ERROR';
    err.httpStatus = res.status;
    err.b1Response = json;
    throw err;
  }

  return json;
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

function getCompany() {
  return trimEnv('DB_NAME') || 'SBO_GFBS_20200111';
}

/**
 * @param {{ docEntry: unknown, lines: object[], userCode: string }} input
 */
function buildAddDocumentsBody(input) {
  const docEntry = input.docEntry != null ? String(input.docEntry).trim() : '';
  const userCode = String(input.userCode || '').trim();
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) {
    const err = new Error('领料明细不能为空');
    err.code = 'RETURNPRO_BAD_REQUEST';
    throw err;
  }

  const objectType = '60';
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

  const docData = {
    MAIN: [mainRow],
    DELETE: [],
    DETAIL: detail,
  };
  if (btnt.length > 0) docData.BTNT = btnt;

  return {
    JsonString: JSON.stringify(docData),
    objType: objectType,
    Company: getCompany(),
  };
}

function parseAddDocumentsSuccess(json) {
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
      return parseAddDocumentsSuccess(nested);
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
    return { ok: false, message: parseB1Error(json, 'AddDocuments 失败'), docEntry: null };
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

async function addDocuments(addBody, log) {
  const json = await b1PostAddDocuments(addBody, log);
  const parsed = parseAddDocumentsSuccess(json);
  if (!parsed.ok) {
    const err = new Error(parsed.message);
    err.code = 'RETURNPRO_B1_ADD_DOCUMENTS_FAILED';
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
  const addBody = buildAddDocumentsBody(input);
  return addDocuments(addBody, log);
}

module.exports = {
  buildAddDocumentsBody,
  submitReturnProPick,
};
