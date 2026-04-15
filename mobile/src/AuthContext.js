import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setAuthToken } from './api';

const STORAGE_KEY = 'online_report_token';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const t = await AsyncStorage.getItem(STORAGE_KEY);
        if (t) {
          setAuthToken(t);
          setTokenState(t);
          const { data } = await api.get('/auth/me');
          if (data && data.id) setUser(data);
        }
      } catch {
        await AsyncStorage.removeItem(STORAGE_KEY);
        setAuthToken(null);
        setTokenState(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const login = async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password });
    const t = data.token;
    await AsyncStorage.setItem(STORAGE_KEY, t);
    setAuthToken(t);
    setTokenState(t);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setAuthToken(null);
    setTokenState(null);
    setUser(null);
  };

  const value = useMemo(
    () => ({
      token,
      user,
      ready,
      isLoggedIn: !!token && !!user,
      login,
      logout,
    }),
    [token, user, ready]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
