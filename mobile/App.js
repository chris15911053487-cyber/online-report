import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { AuthProvider, useAuth } from './src/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import OrdersScreen from './src/screens/OrdersScreen';
import OrderDetailScreen from './src/screens/OrderDetailScreen';

const Stack = createNativeStackNavigator();

function AppNavigator() {
  const { ready, isLoggedIn, logout } = useAuth();

  if (!ready) {
    return null;
  }

  return (
    <Stack.Navigator
      initialRouteName={isLoggedIn ? 'Orders' : 'Login'}
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="Orders"
        component={OrdersScreen}
        options={({ navigation }) => ({
          title: '生产订单',
          headerRight: () => (
            <TouchableOpacity
              onPress={async () => {
                await logout();
                navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
              }}
              style={{ paddingHorizontal: 12 }}
            >
              <Text style={{ color: '#93c5fd', fontSize: 15 }}>退出</Text>
            </TouchableOpacity>
          ),
          headerBackVisible: false,
        })}
      />
      <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: '订单报工' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <NavigationContainer>
        <StatusBar style="light" />
        <AppNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
