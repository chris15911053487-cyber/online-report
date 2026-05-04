import { useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import VoiceButton from './VoiceButton';

const WEBVIEW_URL = process.env.EXPO_PUBLIC_WEBVIEW_URL || 'http://192.168.31.50:3000';

export default function App() {
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>连接失败</Text>
          <Text style={styles.errorHint}>请检查服务器是否正常运行</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ uri: WEBVIEW_URL }}
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
});
