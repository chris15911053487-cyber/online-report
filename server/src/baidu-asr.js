/**
 * Baidu Short Speech Recognition (ASR) helper.
 *
 * 环境变量（每次调用时读取）：
 *   BAIDU_ASR_API_KEY    - Baidu AI console API Key
 *   BAIDU_ASR_SECRET_KEY - Baidu AI console Secret Key
 *   BAIDU_ASR_MODE       - standard（默认，标准版 1537）| pro（极速版 80001，需在百度控制台单独开通）
 *   BAIDU_ASR_DEV_PID    - 覆盖 dev_pid（如自训练模型给出的 dev_pid）
 *   BAIDU_ASR_LM_ID      - 语音自训练平台的模型 id，有值时随请求带上 lm_id
 */

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const STANDARD_URL = 'https://vop.baidu.com/server_api';
const PRO_URL = 'https://vop.baidu.com/pro_api';

/** 按环境变量决定接口地址与模型 */
function resolveAsrConfig(env = process.env) {
  const mode = String(env.BAIDU_ASR_MODE || 'standard').trim().toLowerCase() === 'pro' ? 'pro' : 'standard';
  const devPid = Number(env.BAIDU_ASR_DEV_PID) || (mode === 'pro' ? 80001 : 1537);
  const lmId = String(env.BAIDU_ASR_LM_ID || '').trim() || null;
  return { mode, url: mode === 'pro' ? PRO_URL : STANDARD_URL, devPid, lmId };
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(API_KEY, SECRET_KEY) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(API_KEY)}&client_secret=${encodeURIComponent(SECRET_KEY)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) {
    throw new Error(`Baidu token error: ${json.error_description || json.error}`);
  }
  cachedToken = json.access_token;
  // expires_in is seconds, subtract 1 minute for safety
  tokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Recognize speech from WAV audio data (base64-encoded).
 *
 * @param {string} base64Audio  - base64-encoded WAV/PCM audio
 * @param {number} audioBytes   - original byte length of the audio
 * @param {object} [opts]
 * @param {number} [opts.rate=16000]
 * @param {string} [opts.format='wav']
 * @param {string} [opts.userCode]  用于 cuid，便于在百度控制台按人看调用
 * @returns {Promise<string>} recognized text
 */
async function recognize(base64Audio, audioBytes, opts = {}) {
  const API_KEY = process.env.BAIDU_ASR_API_KEY || '';
  const SECRET_KEY = process.env.BAIDU_ASR_SECRET_KEY || '';
  if (!API_KEY || !SECRET_KEY) {
    throw new Error('BAIDU_ASR_API_KEY and BAIDU_ASR_SECRET_KEY must be set in .env');
  }
  const cfg = resolveAsrConfig();

  const token = await getAccessToken(API_KEY, SECRET_KEY);
  const payload = {
    format: opts.format || 'wav',
    rate: opts.rate || 16000,
    channel: 1,
    cuid: opts.userCode ? `online-report-${String(opts.userCode).slice(0, 40)}` : 'online-report-web',
    token,
    speech: base64Audio,
    len: audioBytes,
    dev_pid: cfg.devPid,
  };
  if (cfg.lmId) payload.lm_id = cfg.lmId;
  const body = JSON.stringify(payload);

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();

  if (json.err_no !== 0) {
    throw new Error(`Baidu ASR error [${json.err_no}]: ${json.err_msg}`);
  }

  return (json.result || []).join('') || '';
}

module.exports = { recognize, resolveAsrConfig };
