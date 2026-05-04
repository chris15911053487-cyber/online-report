import { useRef, useState, useEffect, useCallback } from 'react';
import {
  StyleSheet, View, ActivityIndicator, Text, Modal,
  TextInput, TouchableOpacity, Alert
} from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { Accelerometer } from 'expo-sensors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import VoiceButton from './VoiceButton';

const DEFAULT_URL = process.env.EXPO_PUBLIC_WEBVIEW_URL || 'http://192.168.31.50:3000';
const STORAGE_KEY = '@webview_url';
const SHAKE_THRESHOLD = 1.8;

export default function App() {
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [webviewUrl, setWebviewUrl] = useState(DEFAULT_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [urlInput, setUrlInput] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved) setWebviewUrl(saved);
    });
  }, []);

  useEffect(() => {
    let lastX = 0, lastY = 0, lastZ = 0;
    let lastShakeTime = 0;

    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const now = Date.now();
      if (now - lastShakeTime < 1500) {
        lastX = x; lastY = y; lastZ = z;
        return;
      }
      const delta = Math.abs(x - lastX) + Math.abs(y - lastY) + Math.abs(z - lastZ);
      if (delta > SHAKE_THRESHOLD) {
        lastShakeTime = now;
        setUrlInput(webviewUrl);
        setShowSettings(true);
      }
      lastX = x; lastY = y; lastZ = z;
    });

    Accelerometer.setUpdateInterval(200);
    return () => sub.remove();
  }, [webviewUrl]);

  const handleSaveUrl = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!/^https?:\/\/.+/.test(trimmed)) {
      Alert.alert('格式错误', '请输入完整的地址，如 http://192.168.1.1:3000');
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEY, trimmed);
    setWebviewUrl(trimmed);
    setShowSettings(false);
    setLoading(true);
    setError(false);
  }, [urlInput]);

  const openSettings = useCallback(() => {
    setUrlInput(webviewUrl);
    setShowSettings(true);
  }, [webviewUrl]);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>连接失败</Text>
          <Text style={styles.errorHint}>请检查服务器是否正常运行</Text>
          <TouchableOpacity style={styles.changeBtn} onPress={openSettings}>
            <Text style={styles.changeBtnText}>修改服务器地址</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          key={webviewUrl}
          source={{ uri: webviewUrl }}
          style={styles.webview}
          onLoadEnd={() => setLoading(false)}
          onError={() => setError(true)}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          allowsInlineMediaPlayback={true}
        />
      )}

      {loading && !error && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      )}

      {!loading && !error && <VoiceButton webViewRef={webViewRef} />}

      <Modal visible={showSettings} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>服务器地址</Text>
            <Text style={styles.modalHint}>摇一摇手机也可打开此设置</Text>
            <TextInput
              style={styles.urlInput}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="http://192.168.1.1:3000"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowSettings(false)}
              >
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSaveUrl}>
                <Text style={styles.saveBtnText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  webview: { flex: 1 },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  loadingText: { color: '#94a3b8', marginTop: 12, fontSize: 14 },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 32,
  },
  errorText: { color: '#f87171', fontSize: 18, fontWeight: '600' },
  errorHint: { color: '#94a3b8', fontSize: 14, marginTop: 8 },
  changeBtn: {
    marginTop: 24,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2563eb',
  },
  changeBtnText: { color: '#fff', fontSize: 14 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 24,
  },
  modalTitle: { color: '#f1f5f9', fontSize: 18, fontWeight: '600' },
  modalHint: { color: '#64748b', fontSize: 12, marginTop: 4 },
  urlInput: {
    marginTop: 16,
    backgroundColor: '#0f172a',
    color: '#f1f5f9',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
    gap: 12,
  },
  cancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cancelBtnText: { color: '#94a3b8', fontSize: 15 },
  saveBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2563eb',
  },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
