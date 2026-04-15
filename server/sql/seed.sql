SET NAMES utf8mb4;

-- 示例订单（可选，与 init-db 一并执行）
INSERT INTO production_orders (order_no, product_name, planned_qty, status, remark)
VALUES
  ('PO-2026-001', '零件A总成', 1000, 'in_progress', '试产'),
  ('PO-2026-002', '零件B外壳', 500, 'open', '')
ON DUPLICATE KEY UPDATE product_name = VALUES(product_name);
