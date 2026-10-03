"""skill 在 system prompt 中的呈现方式（全量内联 / 按需加载）。

刻意不依赖 langchain / langgraph，便于单测，也避免 agent.py 与 tools.py 循环引用。

- 全量内联：skill 总量较小时，正文直接进 system prompt（与历史行为一致）；
- 按需加载：skill 正文总量超过阈值后，system prompt 只列「名称 + 描述」，
  模型命中某个 skill 后调用 load_skill 工具取完整正文（渐进式披露，与 read_skill_resource 同思路）。
"""


def total_body_chars(skills) -> int:
    return sum(len(str((s or {}).get("bodyMd") or "")) for s in skills or [])


def should_lazy_load(skills, inline_max_chars: int) -> bool:
    """skill 正文总字数超过阈值才切换为按需加载；阈值 < 0 表示永不按需加载。"""
    if inline_max_chars is None or inline_max_chars < 0:
        return False
    return total_body_chars(skills) > inline_max_chars


def format_skill_full(s) -> list:
    """单个 skill 的完整呈现（正文 + 表白名单硬约束 + 资源清单），返回待追加的行。"""
    lines = [f"\n### {s.get('name')}\n{s.get('description','')}\n{s.get('bodyMd','')}"]
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


def format_skill_index(skills) -> list:
    """按需加载模式下的 skill 索引（仅名称 + 描述）及使用规则，返回待追加的行。"""
    lines = [
        "\n以下 skill 只列出名称与描述，完整工作流、SQL 模式、表白名单与资源清单尚未加载。",
        "使用规则：判断用户请求匹配某个 skill 后，**必须先调用 load_skill(skill_name) 读取该 skill 的完整说明**，"
        "再严格按其说明执行；未加载对应 skill 之前，不要调用 run_sql，也不要凭描述臆测 SQL 或表结构。\n",
    ]
    for s in skills or []:
        desc = str(s.get("description") or "").strip().replace("\n", " ")
        lines.append(f"- {s.get('name')}：{desc}")
    return lines


def find_skill(skills_by_name, name):
    """按名称取 skill（忽略大小写与首尾空白）；找不到返回 None。"""
    key = str(name or "").strip().lower()
    if not key or not isinstance(skills_by_name, dict):
        return None
    return skills_by_name.get(key)


def index_skills(skills) -> dict:
    """name(小写) → skill，供 load_skill 查表。"""
    out = {}
    for s in skills or []:
        name = str((s or {}).get("name") or "").strip().lower()
        if name:
            out[name] = s
    return out
