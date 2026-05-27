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

  const mainRow = {
    DocDate: todayDocDateIso(),
    DocEntry: '0',
    BPLId: '1',
    Comments: `返修单领料${docEntry ? ` DocEntry=${docEntry}` : ''}${userCode ? ` 操作员=${userCode}` : ''}`,
  };

  const cardCode = trimEnv('RETURNPRO_B1_CARD_CODE');
  if (cardCode) {
    mainRow.CardCode = cardCode;
    const cardName = trimEnv('RETURNPRO_B1_CARD_NAME');
    if (cardName) mainRow.CardName = cardName;
  }

  const detail = [];

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

    const whs = line.whsCode ?? line.WhsCode;
    const whsStr = whs != null ? String(whs).trim() : '';
    if (!whsStr) {
      const err = new Error(`第 ${idx + 1} 行：缺少仓库`);
      err.code = 'RETURNPRO_BAD_REQUEST';
      throw err;
    }
    row.WhsCode = whsStr;

    const unit = line.uUnit ?? line.U_Unit;
    if (unit != null && String(unit).trim()) row.unitMsr = String(unit).trim();

    const batchNum = String(line.batchNum ?? line.BatchNum ?? '').trim();
    if (isBatchLine(line) && batchNum) {
      row.BatchNumbers = batchNum;
    }

    row.U_BaseType = 'TT_OWOR';
    if (docEntry) row.U_BaseEntry = docEntry;
    const baseLine = line.lineId ?? line.LineId;
    if (baseLine != null && String(baseLine).trim() !== '') {
      row.U_BaseLine = String(baseLine).trim();
    }

    detail.push(row);
  });

  const docData = {
    MAIN: [mainRow],
    DELETE: [],
    DETAIL: detail,
  };

  return {
    JsonString: JSON.stringify(docData),
    objType: objectType,
    Company: getCompany(),
  };
}

function tryParseJsonString(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** WCF AddDocuments 常见：{ AddDocumentsResult: "{\"RETURN\":[{\"Ret\":...,\"Message\":...}]}" } */
function unwrapAddDocumentsPayload(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return json;

  const resultKey = Object.keys(json).find((k) => /result$/i.test(k));
  if (resultKey) {
    const inner = tryParseJsonString(json[resultKey]);
    if (inner && typeof inner === 'object') return inner;
  }

  const nested = json.Result ?? json.result ?? json.Data ?? json.data;
  if (nested && nested !== json) {
    const parsed = tryParseJsonString(nested);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof nested === 'object') return nested;
  }

  return json;
}

function getReturnItems(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const retKey = Object.keys(payload).find((k) => k.toLowerCase() === 'return');
  const arr = retKey ? payload[retKey] : null;
  return Array.isArray(arr) && arr.length > 0 ? arr : null;
}

function parseReturnItemResult(item) {
  if (!item || typeof item !== 'object') return null;
  const ret = toNumberOrNull(item.Ret ?? item.ret ?? item.Code ?? item.code);
  const message = pickFirstString(item, ['Message', 'message', 'Msg', 'msg', 'ErrorMsg']);
  const docEntry = pickFirstString(item, ['DocEntry', 'docEntry', 'DocNum', 'docNum']);
  return { ret, message, docEntry };
}

function parseAddDocumentsSuccess(json) {
  const payload = unwrapAddDocumentsPayload(json);
  const returnItems = getReturnItems(payload);

  if (returnItems) {
    const { ret, message, docEntry } = parseReturnItemResult(returnItems[0]);
    if (ret != null && ret < 0) {
      return {
        ok: false,
        message: message || `AddDocuments 失败 (Ret=${ret})`,
        docEntry: null,
      };
    }
    // Ret=0 且 Message 为新单据号（如 "22561"）表示成功
    if (ret === 0) {
      const msgDoc = message && /^\d+$/.test(message.trim()) ? message.trim() : '';
      if (msgDoc) {
        return { ok: true, message: '', docEntry: msgDoc };
      }
      return {
        ok: false,
        message: message || 'AddDocuments 失败',
        docEntry: null,
      };
    }
    if (docEntry) {
      return { ok: true, message: '', docEntry };
    }
    if (ret != null && ret > 0) {
      return { ok: true, message: '', docEntry: String(ret) };
    }
    if (message && /^\d+$/.test(message.trim())) {
      return { ok: true, message: '', docEntry: message.trim() };
    }
    if (message) {
      return { ok: false, message, docEntry: null };
    }
  }

  const docEntry = pickFirstString(payload, ['DocEntry', 'docEntry', 'DocNum', 'docNum']);
  const successFlag = payload?.Success ?? payload?.success ?? payload?.Ok ?? payload?.ok;

  if (successFlag === false) {
    return { ok: false, message: parseB1Error(payload, 'AddDocuments 失败'), docEntry: null };
  }

  if (successFlag === true && docEntry) {
    return { ok: true, message: '', docEntry };
  }

  const errMsg = parseB1Error(payload, '');
  if (errMsg && errMsg !== 'B1 服务返回失败') {
    return { ok: false, message: errMsg, docEntry: null };
  }

  if (docEntry) {
    return { ok: true, message: '', docEntry };
  }

  return {
    ok: false,
    message: 'AddDocuments 未返回成功结果，请检查 B1 响应格式',
    docEntry: null,
  };
}

async function addDocuments(addBody, log) {
  const json = await b1PostAddDocuments(addBody, log);
  const parsed = parseAddDocumentsSuccess(json);
  if (!parsed.ok) {
    const err = new Error(parsed.message);
    err.code = 'RETURNPRO_B1_ADD_DOCUMENTS_FAILED';
    err.b1Response = json;
    err.b1Request = addBody;
    throw err;
  }
  return { b1Response: json, docEntry: parsed.docEntry, b1Request: addBody };
}

/**
 * @param {{ docEntry: unknown, lines: object[], userCode: string }} input
 * @param {import('fastify').FastifyBaseLogger} [log]
 */
async function submitReturnProPick(input, log) {
  let addBody;
  try {
    addBody = buildAddDocumentsBody(input);
    return await addDocuments(addBody, log);
  } catch (e) {
    if (addBody && !e.b1Request) e.b1Request = addBody;
    throw e;
  }
}

module.exports = {
  buildAddDocumentsBody,
  submitReturnProPick,
  parseAddDocumentsSuccess,
};
