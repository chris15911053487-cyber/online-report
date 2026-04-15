import axios from 'axios';
import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra || {};
const baseURL = extra.apiBaseUrl || 'http://127.0.0.1:3000';

export const api = axios.create({
  baseURL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

export function setAuthToken(token) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
