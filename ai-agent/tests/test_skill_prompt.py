"""skill 按需加载相关测试。

langchain / langgraph / httpx 在本地开发环境可能未安装，这里用桩模块替代，
只验证本项目自己的逻辑（prompt 拼装、load_skill 查表）。

运行：cd ai-agent && python3 -m unittest discover -s tests -v
"""
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _install_stubs():
    def mod(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m
        return m

    class _Msg:
        def __init__(self, content="", **kw):
            self.content = content

    mod("httpx")
    mod("langchain_core")
    mod("langchain_core.callbacks", BaseCallbackHandler=object)
    mod("langchain_core.messages", AIMessage=_Msg, HumanMessage=_Msg, SystemMessage=_Msg, ToolMessage=_Msg)
    mod("langchain_core.runnables", RunnableConfig=dict)
    mod("langchain_core.tools", tool=lambda f: f)  # 透传：保留原函数，便于直接调用
    mod("langgraph")
    mod("langgraph.checkpoint")
    mod("langgraph.checkpoint.sqlite", SqliteSaver=object)
    mod("langgraph.prebuilt", create_react_agent=lambda *a, **k: None)
    mod("langgraph.types", Command=object, interrupt=lambda *a, **k: None)


try:  # 装了真实依赖就用真实的；否则用桩，保证无依赖环境也能跑
    import langchain_core  # noqa: F401
    import langgraph  # noqa: F401
    import httpx  # noqa: F401
except ImportError:
    _install_stubs()

from app import agent, tools  # noqa: E402
from app.skill_prompt import (  # noqa: E402
    format_skill_full,
    format_skill_index,
    index_skills,
    should_lazy_load,
)


def _legacy_inline_lines(skills):
    """改造前 build_system_prompt 中逐个 skill 的拼装逻辑（冻结副本，用于对照）。"""
    lines = []
    for s in skills or []:
        lines.append(f"\n### {s.get('name')}\n{s.get('description','')}\n{s.get('bodyMd','')}")
        allowed_tables = s.get("allowedTables") or []
        if allowed_tables:
            lines.append(
                "\n**本 skill 的 run_sql 表白名单（硬约束）**：只能引用以下表，"
                + "、".join(str(t) for t in allowed_tables)
                + "。禁止 JOIN 或查询白名单以外的任何表；"
                "需要新增维度/字段时，只能在这些表已有的列上扩展（加入 SELECT 并同步加入 GROUP BY），"
                "不可引入新表。调用 run_sql 时必须传 skill_name=\""
                + str(s.get("name"))
                + "\"。"
            )
        resources = s.get("resources") or []
        if resources:
            lines.append("\n本 skill 附带以下资源文件（仅列清单，内容未加载）：")
            for r in resources:
                lines.append(f"- {r.get('path')}（{r.get('size', 0)} 字节）")
            lines.append(
                "需要其中细节时，用 read_skill_resource(skill_name, path) 按需读取；不要凭空臆测资源内容。"
            )
        else:
            lines.append("\n注意：本 skill 无附带资源文件，不要调用 read_skill_resource。正文中如提到文件路径属于说明文本，直接按正文指引执行即可。")
    return lines


SKILL_A = {
    "name": "sales-query",
    "description": "销售查询",
    "bodyMd": "## 流程\n用 run_sql 查 OINV。",
    "allowedTables": ["OINV", "INV1"],
    "resources": [{"path": "references/fields.md", "size": 120}],
}
SKILL_B = {"name": "stock-query", "description": "库存\n查询", "bodyMd": "x" * 50, "allowedTables": [], "resources": []}
USER = {"displayName": "张三", "userCode": "U001", "roles": ["operator"]}


def _load_skill(name, config):
    """桩环境下 load_skill 是普通函数；真实环境下是 StructuredTool，取其 .func。"""
    fn = getattr(tools.load_skill, "func", tools.load_skill)
    return fn(name, config)


class SkillPromptTests(unittest.TestCase):
    def test_full_format_identical_to_legacy(self):
        for s in (SKILL_A, SKILL_B):
            self.assertEqual(format_skill_full(s), _legacy_inline_lines([s]))

    def test_should_lazy_load_threshold(self):
        skills = [SKILL_A, SKILL_B]
        total = len(SKILL_A["bodyMd"]) + len(SKILL_B["bodyMd"])
        self.assertFalse(should_lazy_load(skills, total))  # 等于阈值仍内联
        self.assertTrue(should_lazy_load(skills, total - 1))
        self.assertTrue(should_lazy_load(skills, 0))
        self.assertFalse(should_lazy_load(skills, -1))  # -1 = 永不按需
        self.assertFalse(should_lazy_load([], 0))

    def test_index_lists_names_and_descriptions_only(self):
        text = "\n".join(format_skill_index([SKILL_A, SKILL_B]))
        self.assertIn("- sales-query：销售查询", text)
        self.assertIn("- stock-query：库存 查询", text)  # 描述换行被压成空格
        self.assertIn("load_skill", text)
        self.assertNotIn(SKILL_A["bodyMd"], text)
        self.assertNotIn("OINV", text)

    def test_build_prompt_inline_when_small(self):
        agent.settings.SKILL_INLINE_MAX_CHARS = 12000
        prompt = agent.build_system_prompt([SKILL_A, SKILL_B], USER)
        self.assertIn(SKILL_A["bodyMd"], prompt)
        self.assertIn("表白名单（硬约束）", prompt)
        self.assertNotIn("必须先调用 load_skill", prompt)
        legacy = "\n".join(_legacy_inline_lines([SKILL_A, SKILL_B]))
        self.assertIn(legacy, prompt)

    def test_build_prompt_lazy_when_large(self):
        agent.settings.SKILL_INLINE_MAX_CHARS = 10
        prompt = agent.build_system_prompt([SKILL_A, SKILL_B], USER)
        self.assertNotIn(SKILL_A["bodyMd"], prompt)
        self.assertIn("必须先调用 load_skill", prompt)
        self.assertIn("- sales-query：销售查询", prompt)
        # 用户信息等后续段落仍然存在
        self.assertIn("当前用户编码：U001", prompt)

    def test_build_prompt_no_skills(self):
        prompt = agent.build_system_prompt([], USER)
        self.assertIn("当前无可用 skill", prompt)


class LoadSkillToolTests(unittest.TestCase):
    def _cfg(self, skills):
        return {"configurable": {"skills_by_name": index_skills(skills)}}

    def test_load_existing_skill_returns_full_text(self):
        out = _load_skill("Sales-Query ", self._cfg([SKILL_A, SKILL_B]))  # 大小写/空白容错
        self.assertIn("### sales-query", out)
        self.assertIn(SKILL_A["bodyMd"], out)
        self.assertIn("OINV、INV1", out)
        self.assertIn("references/fields.md", out)
        self.assertFalse(out.startswith("\n"))

    def test_load_unknown_skill_lists_available(self):
        out = _load_skill("nope", self._cfg([SKILL_A, SKILL_B]))
        self.assertIn("无此 skill", out)
        self.assertIn("sales-query", out)
        self.assertIn("stock-query", out)

    def test_load_without_config(self):
        out = _load_skill("x", {})
        self.assertIn("无此 skill", out)

    def test_registered_and_labelled(self):
        self.assertIn(tools.load_skill, tools.ALL_TOOLS)
        self.assertIn("load_skill", agent.TOOL_LABELS)

    def test_guess_skill_from_load_skill(self):
        steps = [{"tool": "load_skill", "args": {"skill_name": "sales-query"}}]
        self.assertEqual(agent._guess_skill(["load_skill"], steps), "sales-query")
        steps2 = steps + [{"tool": "run_sql", "args": {"skill_name": "stock-query"}}]
        self.assertEqual(agent._guess_skill(["load_skill", "run_sql"], steps2), "stock-query")


if __name__ == "__main__":
    unittest.main()
