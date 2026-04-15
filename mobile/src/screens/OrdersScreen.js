import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../api';

function statusLabel(s) {
  const map = {
    open: '待开工',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
  };
  return map[s] || s;
}

export default function OrdersScreen({ navigation }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const { data } = await api.get('/orders');
    setItems(data.items || []);
  };

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        try {
          await load();
        } catch {
          if (!cancelled) setItems([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>暂无生产订单</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => navigation.navigate('OrderDetail', { id: item.id })}
          >
            <View style={styles.row}>
              <Text style={styles.orderNo}>{item.orderNo}</Text>
              <Text style={styles.badge}>{statusLabel(item.status)}</Text>
            </View>
            <Text style={styles.product}>{item.productName || '—'}</Text>
            <Text style={styles.meta}>
              计划 {item.plannedQty} · 已报 {item.reportedQty}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 48 },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  orderNo: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  badge: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  product: { fontSize: 15, color: '#334155', marginBottom: 6 },
  meta: { fontSize: 13, color: '#64748b' },
});
