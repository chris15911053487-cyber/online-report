"""性能相关：system prompt 前缀稳定、效率规则、run_sql 给模型的行数上限。"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import test_skill_prompt  # noqa: E402,F401  复用它的依赖桩（无真实依赖时）
from app import agent, tools  # noqa: E402
from app.config import settings  # noqa: E402

SKILL = {"name": "sales", "description": "销售", "bodyMd": "查 OINV", "allowedTables": ["OINV"], "resources": []}


def _fn(t):
    return getattr(t, "func", t)


class StablePrefixTests(unittest.TestCase):
    def setUp(self):
        settings.SKILL_INLINE_MAX_CHARS = 12000

    def test_user_specific_part_is_last_and_prefix_identical_across_users(self):
        extra = "你是销售分析专家"
        p1 = agent.build_system_prompt([SKILL], {"displayName": "张三", "userCode": "U001", "roles": ["operator"]}, extra)
        p2 = agent.build_system_prompt([SKILL], {"displayName": "李四", "userCode": "U002", "roles": ["operator"]}, extra)
        self.assertNotEqual(p1, p2)
        # 公共前缀必须覆盖「全局规则 + skill + Agent 指令」，差异只出现在末尾的用户信息里
        common = os.path.commonprefix([p1, p2])
        self.assertIn(extra, common)
        self.assertIn(SKILL["bodyMd"], common)
        for personal in ("张三", "李四", "U001", "U002"):
            self.assertNotIn(personal, common)
        self.assertTrue(p1.rstrip().endswith("当前用户角色：operator"))
        self.assertLess(p1.index(extra), p1.index("当前用户：张三"))

    def test_no_user_info_no_trailing_section(self):
        p = agent.build_system_prompt([SKILL], {}, "")
        self.assertNotIn("当前用户：", p)
        self.assertNotIn("当前用户编码", p)

    def test_efficiency_rules_present(self):
        rules = agent.load_base_instructions()
        self.assertIn("并行调用", rules)
        self.assertIn("合并 SQL", rules)
        self.assertIn("GROUPING SETS", rules)
        self.assertIn("前 50 行", rules)
        self.assertIn("并行", agent._DEFAULT_BASE_INSTRUCTIONS)


class RunSqlRowLimitTests(unittest.TestCase):
    def _run(self, backend_data):
        class FakeClient:
            def run_sql(self, sql, skill):
                return backend_data

        orig = tools._client
        tools._client = lambda config: FakeClient()
        try:
            return json.loads(_fn(tools.run_sql)("select 1", "sales", {}))
        finally:
            tools._client = orig

    def test_default_limit_is_50(self):
        self.assertEqual(settings.SQL_LLM_MAX_ROWS, 50)

    def test_rows_clamped_for_model_and_flagged(self):
        rows = [{"id": i} for i in range(200)]
        out = self._run({"columns": ["id"], "rows": rows, "totalRowCount": 200, "truncated": False})
        self.assertEqual(len(out["rows"]), 50)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["totalRowCount"], 200)
        self.assertIn("前 50 行（共 200 行）", out["note"])

    def test_small_result_untouched(self):
        out = self._run({"columns": ["id"], "rows": [{"id": 1}], "totalRowCount": 1, "truncated": False})
        self.assertEqual(len(out["rows"]), 1)
        self.assertFalse(out["truncated"])
        self.assertNotIn("note", out)

    def test_backend_truncation_and_cap_passed_through(self):
        out = self._run({"columns": ["id"], "rows": [{"id": 1}], "totalRowCount": 50000,
                         "truncated": True, "totalCapped": True})
        self.assertTrue(out["truncated"])
        self.assertTrue(out["totalCapped"])
        self.assertIn("note", out)


if __name__ == "__main__":
    unittest.main()
