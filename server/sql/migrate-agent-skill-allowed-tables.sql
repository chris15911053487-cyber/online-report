-- 为 agent_skills 增加 allowed_tables_json 列：run_sql 表白名单。
--
-- 「标准 + 可扩展」框架的硬护栏：
--   skill 的 body_md 描述固定骨架/字段词典/组装规则（软约束，决定"怎么写"）；
--   allowed_tables_json 限定该 skill 通过 run_sql 只能引用哪些表（硬约束，决定"能碰哪些表"）。
-- 留空（[]）= 不限制表（仅保留 SELECT-only 限制），向后兼容既有 skill。
--
-- 幂等：列已存在则跳过。SQL2012+ 兼容（不依赖 AT TIME ZONE）。

IF OBJECT_ID(N'dbo.agent_skills', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.agent_skills', N'allowed_tables_json') IS NULL
BEGIN
  ALTER TABLE dbo.agent_skills
    ADD allowed_tables_json NVARCHAR(MAX) NOT NULL
      CONSTRAINT DF_agent_skills_allowed_tables DEFAULT (N'[]');
END;
