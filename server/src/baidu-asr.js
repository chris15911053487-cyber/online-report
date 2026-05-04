/**
 * Baidu Short Speech Recognition (ASR) helper.
 *
 * Requires env vars:
 *   BAIDU_ASR_API_KEY    - Baidu AI console API Key
 *   BAIDU_ASR_SECRET_KEY - Baidu AI console Secret Key
 */

const API_KEY = process.env.BAIDU_ASR_API_KEY || '';
const SECRET_KEY = process.env.BAIDU_ASR_SECRET_KEY || '';
const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const ASR_URL = 'https://vop.baidu.com/server_api';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
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
 * @returns {Promise<string>} recognized text
 */
async function recognize(base64Audio, audioBytes, opts = {}) {
  if (!API_KEY || !SECRET_KEY) {
    throw new Error('BAIDU_ASR_API_KEY and BAIDU_ASR_SECRET_KEY must be set in .env');
  }

  const token = await getAccessToken();
  const body = JSON.stringify({
    format: opts.format || 'wav',
    rate: opts.rate || 16000,
    channel: 1,
    cuid: 'online-report-web',
    token,
    speech: base64Audio,
    len: audioBytes,
    dev_pid: opts.dev_pid || 1537,
  });

  const res = await fetch(ASR_URL, {
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

module.exports = { recognize };
