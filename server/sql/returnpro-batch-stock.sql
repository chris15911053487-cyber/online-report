/* 领料出库：按物料 + OIBT.BatchNum + 仓库查询 SAP B1 批次库存
 * 应用内默认使用 server/src/returnpro-batch-stock.js 中的等价 SQL。
 * 若需自定义逻辑，可部署下方存储过程并设置环境变量：
 *   RETURNPRO_BATCH_STOCK_PROC=Z_ONLINE_RETURNPRO_BATCH_STOCK
 */

-- 内联查询（与 DEFAULT_BATCH_STOCK_SQL 一致）：
/*
SELECT ISNULL(SUM(T0.Quantity), 0) AS OnHand
FROM dbo.OIBT T0 WITH (NOLOCK)
WHERE T0.ItemCode = @ItemCode
  AND T0.BatchNum = @BatchNum
  AND (@WhsCode IS NULL OR LTRIM(RTRIM(@WhsCode)) = '' OR T0.WhsCode = @WhsCode);
*/

IF OBJECT_ID(N'dbo.Z_ONLINE_RETURNPRO_BATCH_STOCK', N'P') IS NOT NULL
  DROP PROCEDURE dbo.Z_ONLINE_RETURNPRO_BATCH_STOCK;
GO

CREATE PROCEDURE dbo.Z_ONLINE_RETURNPRO_BATCH_STOCK
  @ItemCode NVARCHAR(50),
  @BatchNum NVARCHAR(100),
  @WhsCode  NVARCHAR(20) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  SELECT ISNULL(SUM(T0.Quantity), 0) AS OnHand
  FROM dbo.OIBT T0 WITH (NOLOCK)
  WHERE T0.ItemCode = @ItemCode
    AND T0.BatchNum = @BatchNum
    AND (@WhsCode IS NULL OR LTRIM(RTRIM(@WhsCode)) = '' OR T0.WhsCode = @WhsCode);
END;
GO
