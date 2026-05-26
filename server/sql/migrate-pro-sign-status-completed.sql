/*
  生产报工 Status 筛选项：为 filter_schema 中 Status 字段的静态 options 追加 code=2「已完工」。
  若使用 optionsSql 动态下拉，请在对应 SQL 中自行返回 code=2 的选项。
  执行：在 SSMS 或 sqlcmd 中对业务库运行本脚本（可重复执行，已存在 code 2 则跳过）。
*/
SET NOCOUNT ON;

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NULL
BEGIN
  PRINT N'跳过：dbo.nav_menu_items 不存在';
  RETURN;
END;

DECLARE @id INT;
DECLARE @json NVARCHAR(MAX);
DECLARE @newJson NVARCHAR(MAX);
DECLARE @statusIdx INT;
DECLARE @optsStart INT;
DECLARE @optsEnd INT;
DECLARE @optsBody NVARCHAR(MAX);
DECLARE @hasCode2 BIT;

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT id, filter_schema_json
  FROM dbo.nav_menu_items
  WHERE route_key = N'pro-sign'
    AND filter_schema_json IS NOT NULL
    AND LTRIM(RTRIM(filter_schema_json)) <> N''
    AND filter_schema_json LIKE N'%Status%'
    AND filter_schema_json LIKE N'%"options"%';

OPEN cur;
FETCH NEXT FROM cur INTO @id, @json;

WHILE @@FETCH_STATUS = 0
BEGIN
  SET @hasCode2 = 0;
  IF @json LIKE N'%"code"%:%"2"%'
    OR @json LIKE N'%"code"%:2%'
    OR @json LIKE N'%"code"%: 2%'
    SET @hasCode2 = 1;

  IF @hasCode2 = 0
  BEGIN
    /* 在 "options":[ ... ] 数组末尾、Status 字段的 options 内插入已完工项（简单文本补丁） */
    SET @statusIdx = CHARINDEX(N'"name":"Status"', @json);
    IF @statusIdx = 0 SET @statusIdx = CHARINDEX(N'"name": "Status"', @json);
    IF @statusIdx > 0
    BEGIN
      SET @optsStart = CHARINDEX(N'"options"', @json, @statusIdx);
      IF @optsStart > 0
      BEGIN
        SET @optsStart = CHARINDEX(N'[', @json, @optsStart);
        SET @optsEnd = CHARINDEX(N']', @json, @optsStart);
        IF @optsStart > 0 AND @optsEnd > @optsStart
        BEGIN
          SET @optsBody = SUBSTRING(@json, @optsStart + 1, @optsEnd - @optsStart - 1);
          IF LTRIM(RTRIM(@optsBody)) = N''
            SET @newJson = STUFF(@json, @optsEnd, 0, N'{"name":"已完工","code":"2"}');
          ELSE
            SET @newJson = STUFF(@json, @optsEnd, 0, N',{"name":"已完工","code":"2"}');

          UPDATE dbo.nav_menu_items
          SET filter_schema_json = @newJson
          WHERE id = @id;

          PRINT N'已更新 nav_menu_items.id=' + CAST(@id AS NVARCHAR(20)) + N'：追加 Status code=2 已完工';
        END
      END
    END
  END
  ELSE
    PRINT N'跳过 id=' + CAST(@id AS NVARCHAR(20)) + N'：已含 code=2 或需人工核对';

  FETCH NEXT FROM cur INTO @id, @json;
END;

CLOSE cur;
DEALLOCATE cur;
