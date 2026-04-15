/* 真机调试时设置 API：在项目根目录建 .env，写入
   EXPO_PUBLIC_API_URL=http://192.168.x.x:3000
   然后 npx expo start -c 清缓存启动 */
module.exports = {
  expo: {
    name: '生产报工',
    slug: 'online-report',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0f172a',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.example.onlinereport',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0f172a',
      },
      package: 'com.example.onlinereport',
      usesCleartextTraffic: true,
    },
    extra: {
      apiBaseUrl: process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3000',
    },
  },
};
