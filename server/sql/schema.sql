-- 生产报工系统表结构 (MySQL 8+)
-- 执行前请创建数据库: CREATE DATABASE online_report CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET NAMES utf8mb4;

-- 用户（操作工 / 班组长等）
CREATE TABLE IF NOT EXISTS app_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  role          ENUM('operator', 'lead', 'admin') NOT NULL DEFAULT 'operator',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 生产订单
CREATE TABLE IF NOT EXISTS production_orders (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no      VARCHAR(64) NOT NULL,
  product_name  VARCHAR(256) NOT NULL DEFAULT '',
  planned_qty   DECIMAL(18, 4) NOT NULL DEFAULT 0,
  reported_qty  DECIMAL(18, 4) NOT NULL DEFAULT 0,
  status        ENUM('open', 'in_progress', 'completed', 'cancelled') NOT NULL DEFAULT 'open',
  remark        VARCHAR(512) NOT NULL DEFAULT '',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 工序（可选，用于报工时选择工序）
CREATE TABLE IF NOT EXISTS order_operations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT UNSIGNED NOT NULL,
  seq_no          INT NOT NULL DEFAULT 1,
  operation_name  VARCHAR(128) NOT NULL DEFAULT '',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_order (order_id),
  UNIQUE KEY uk_order_seq (order_id, seq_no),
  CONSTRAINT fk_op_order FOREIGN KEY (order_id) REFERENCES production_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 报工记录
CREATE TABLE IF NOT EXISTS work_reports (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT UNSIGNED NOT NULL,
  operation_id    BIGINT UNSIGNED NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  good_qty        DECIMAL(18, 4) NOT NULL DEFAULT 0,
  scrap_qty       DECIMAL(18, 4) NOT NULL DEFAULT 0,
  remark          VARCHAR(512) NOT NULL DEFAULT '',
  reported_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_order (order_id),
  KEY idx_user (user_id),
  KEY idx_reported (reported_at),
  CONSTRAINT fk_wr_order FOREIGN KEY (order_id) REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_wr_op FOREIGN KEY (operation_id) REFERENCES order_operations (id) ON DELETE SET NULL,
  CONSTRAINT fk_wr_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
