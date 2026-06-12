# returnpro-pick payload 字段说明

`save_record(entity="returnpro-pick", payload_json=...)` 的 payload 结构：

| 字段 | 必填 | 说明 |
|------|------|------|
| `docEntry` | 否（建议） | 返修单（生产订单）单号，会写入领料单的关联与备注 |
| `lines` | 是 | 领料明细数组，至少一行 |

## lines 每行字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `itemCode` | 是 | 物料编码 |
| `quantity` | 是 | 领料数量，必须大于 0 |
| `whsCode` | 是 | 发料仓库编码 |
| `batchNum` | 批次物料必填 | 批次号 |
| `itemName` | 否 | 物料描述（不填则接口侧留空） |
| `uUnit` | 否 | 计量单位 |
| `lineId` | 否 | 对应返修单的行号（U_BaseLine） |

## 完整示例

```json
{
  "docEntry": 12345,
  "lines": [
    { "itemCode": "A001", "quantity": 2, "whsCode": "01", "batchNum": "B20260601" },
    { "itemCode": "A002", "quantity": 1.5, "whsCode": "01" }
  ]
}
```

## 常见接口报错

| 报错 | 含义与处理 |
|------|------------|
| 第 N 行：物料或数量无效 | 检查该行 itemCode 是否为空、quantity 是否大于 0 |
| 第 N 行：缺少仓库 | 补充该行 whsCode |
| 请至少提交一行领料明细 | lines 为空 |
| B1 相关错误（连接/业务） | 原样转述给用户，建议联系管理员检查 B1 服务配置 |
