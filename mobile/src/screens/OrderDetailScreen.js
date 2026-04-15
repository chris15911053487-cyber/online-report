import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../api';

export default function OrderDetailScreen({ route, navigation }) {
  const { id } = route.params;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [goodQty, setGoodQty] = useState('');
  const [scrapQty, setScrapQty] = useState('0');
  const [remark, setRemark] = useState('');
  const [operationId, setOperationId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    const { data: res } = await api.get(`/orders/${id}`);
    setData(res);
    if (res.operations?.length && operationId == null) {
      setOperationId(res.operations[0].id);
    }
  };

  useFocusEffect(
    useCallback(() => {
      let c = false;
      (async () => {
        setLoading(true);
        try {
          await load();
        } catch (e) {
          if (!c) Alert.alert('错误', e.response?.data?.error || '加载失败');
        } finally {
          if (!c) setLoading(false);
        }
      })();
      return () => {
        c = true;
      };
    }, [id])
  );

  const submit = async () => {
    const good = parseFloat(goodQty);
    const scrap = parseFloat(scrapQty || '0');
    if (!Number.isFinite(good) || good <= 0) {
      Alert.alert('提示', '请填写大于 0 的良品数量');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/orders/${id}/report`, {
        goodQty: good,
        scrapQty: scrap,
        remark,
        operationId: operationId || undefined,
      });
      Alert.alert('成功', '报工已提交', [
        { text: '确定', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('失败', e.response?.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const { order, operations, recentReports } = data;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.orderNo}>{order.orderNo}</Text>
      <Text style={styles.product}>{order.productName}</Text>
      <Text style={styles.meta}>
        计划 {order.plannedQty} · 已报 {order.reportedQty} · {order.status}
      </Text>

      {operations?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.label}>工序</Text>
          <View style={styles.chips}>
            {operations.map((op) => {
              const active = operationId === op.id;
              return (
                <TouchableOpacity
                  key={op.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setOperationId(op.id)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {op.seqNo}. {op.operationName}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.label}>良品数量</Text>
        <TextInput
          style={styles.input}
          keyboardType="decimal-pad"
          placeholder="必填"
          value={goodQty}
          onChangeText={setGoodQty}
        />
        <Text style={styles.label}>不良数量</Text>
        <TextInput
          style={styles.input}
          keyboardType="decimal-pad"
          placeholder="可为 0"
          value={scrapQty}
          onChangeText={setScrapQty}
        />
        <Text style={styles.label}>备注</Text>
        <TextInput
          style={[styles.input, styles.textarea]}
          placeholder="选填"
          value={remark}
          onChangeText={setRemark}
          multiline
        />
      </View>

      <TouchableOpacity
        style={[styles.btn, submitting && styles.btnDisabled]}
        onPress={submit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>提交报工</Text>
        )}
      </TouchableOpacity>

      <View style={styles.section}>
        <Text style={styles.label}>最近报工</Text>
        {(recentReports || []).length === 0 ? (
          <Text style={styles.hint}>暂无记录</Text>
        ) : (
          recentReports.map((r) => (
            <View key={r.id} style={styles.reportRow}>
              <Text style={styles.reportMain}>
                良 {r.goodQty} / 不良 {r.scrapQty} · {r.reporterName}
              </Text>
              <Text style={styles.reportSub}>{r.reportedAt}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  orderNo: { fontSize: 22, fontWeight: '700', color: '#0f172a' },
  product: { fontSize: 16, color: '#334155', marginTop: 4 },
  meta: { fontSize: 14, color: '#64748b', marginTop: 8, marginBottom: 16 },
  section: { marginBottom: 20 },
  label: { fontSize: 14, fontWeight: '600', color: '#475569', marginBottom: 8 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 12,
  },
  textarea: { minHeight: 72, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  chipActive: { backgroundColor: '#dbeafe' },
  chipText: { color: '#334155', fontSize: 14 },
  chipTextActive: { color: '#1d4ed8', fontWeight: '600' },
  btn: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 24,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  hint: { color: '#94a3b8' },
  reportRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  reportMain: { fontSize: 14, color: '#334155' },
  reportSub: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
});
