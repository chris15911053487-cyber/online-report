import { useRef, useState, useCallback, useEffect } from 'react';
import { StyleSheet, TouchableOpacity, Animated, View, Text } from 'react-native';
import { ExpoWebSpeechRecognition } from 'expo-speech-recognition';

export default function VoiceButton({ webViewRef }) {
  const [isListening, setIsListening] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');

  // Pulse animation when listening
  useEffect(() => {
    if (isListening) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.1, duration: 400, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isListening]);

  const injectToWebView = useCallback((text) => {
    if (text && webViewRef.current) {
      const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      webViewRef.current.injectJavaScript(
        `window.__voiceExec && window.__voiceExec('${escaped}')`
      );
    }
  }, [webViewRef]);

  const handlePressIn = useCallback(() => {
    const recognition = new ExpoWebSpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      if (event.results && event.results[0]) {
        transcriptRef.current = event.results[0][0]?.transcript || '';
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      // Inject result after recognition ends
      setTimeout(() => {
        const text = transcriptRef.current;
        if (text) {
          injectToWebView(text.trim());
          transcriptRef.current = '';
        }
      }, 300);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    transcriptRef.current = '';
  }, [injectToWebView]);

  const handlePressOut = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
  }, []);

  const isActive = isListening;

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.button,
          isActive && styles.buttonActive,
          { transform: [{ scale: isActive ? pulseAnim : 1 }] },
        ]}
      >
        <TouchableOpacity
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          activeOpacity={0.8}
          style={styles.touchable}
        >
          <Text style={styles.micText}>{isActive ? '🎙️' : '🎤'}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 100,
    right: 16,
    zIndex: 9999,
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonActive: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ef4444',
  },
  touchable: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micText: {
    fontSize: 24,
  },
});
