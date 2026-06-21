"""LangGraph agent：skill 编排 + 工具调用 + 中断/恢复（消歧/确认）。

- 用 create_react_agent 跑工具调用循环；
- SqliteSaver 做 checkpoint，按 thread_id 支持 interrupt/resume；
- system prompt 注入"按角色过滤后的 skill 清单"（第 1 层权限），执行落白名单工具。
"""
import json
import os
import sqlite3

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent
from langgraph.types import Command

from .config import settings
from .tools import ALL_TOOLS

BASE_INSTRUCTIONS = (
    "你是工厂在线报表系统的 AI 助手。遵循以下原则：\n"
    "1. 你可以通过 run_sql 工具直接编写并执行 SELECT 查询来获取数据（仅允许 SELECT，禁止写操作）。\n"
    "2. **重要**：run_sql 只能在某个 skill 的工作流中使用。每次执行 SQL 查询时，你必须明确是在执行哪个 skill。\n"
    "   如果用户的请求不匹配任何可用 skill，告知用户当前无对应能力，不要自行执行 SQL。\n"
    "   且只能执行该 skill 的 body_md 中明确描述或示例的 SQL 模式和表，不可自行发挥查询其他表或拼接 skill 未提及的逻辑。\n"
    "3. 只回答用户有权访问的数据；工具返回无权/未找到时如实告知。\n"
    "4. 用简洁中文作答；涉及知识问答时注明参考来源标题。\n"
    "5. 所有数据查询统一通过 run_sql 工具执行，不依赖菜单预配置的报表。\n"
    "6. 如果 run_sql 未返回数据，严禁编造数字，如实告知用户查无结果。\n"
)


def _build_model():
    from langchain_openai import ChatOpenAI

    kwargs = {
        "model": settings.DEFAULT_MODEL,
        "temperature": settings.TEMPERATURE,
        "api_key": settings.resolve_api_key() or "dummy-key-for-dev",
        "timeout": settings.TIMEOUT_MS / 1000.0,
        "max_tokens": settings.MAX_TOKENS,
    }
    base_url = settings.resolve_base_url()
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


_graph = None


def get_graph():
    global _graph
    if _graph is None:
        os.makedirs(os.path.dirname(settings.CHECKPOINT_DB) or ".", exist_ok=True)
        conn = sqlite3.connect(settings.CHECKPOINT_DB, check_same_thread=False)
        saver = SqliteSaver(conn)
        _graph = create_react_agent(_build_model(), ALL_TOOLS, checkpointer=saver)
    return _graph


def build_system_prompt(skills, user) -> str:
    lines = [BASE_INSTRUCTIONS, "", "## 可用 skill（按你的权限过滤后）"]
    if not skills:
        lines.append("（当前无可用 skill，仅可做一般性回答）")
    for s in skills or []:
        lines.append(f"\n### {s.get('name')}\n{s.get('description','')}\n{s.get('bodyMd','')}")
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
    roles = (user or {}).get("roles") or []
    if roles:
        lines.append(f"\n当前用户角色：{', '.join(roles)}")
    return "\n".join(lines)


def _interrupt_payload(result):
    intr = result.get("__interrupt__") if isinstance(result, dict) else None
    if not intr:
        return None
    first = intr[0] if isinstance(intr, (list, tuple)) and intr else intr
    return getattr(first, "value", None) or (first if isinstance(first, dict) else None)


TOOL_LABELS = {
    "knowledge_search": "检索知识库",
    "read_skill_resource": "读取 Skill 资源",
    "lookup_options": "查找候选项",
    "run_report": "执行报表查询",
    "run_sql": "执行 SQL 查询",
    "ask_user_to_choose": "等待用户确认",
    "save_record": "保存记录",
    "generate_document": "生成文档",
}


def _truncate_text(text, limit=180):
    s = str(text or "").replace("\n", " ").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def _summarize_args(tool, args):
    if not isinstance(args, dict):
        return {}
    out = dict(args)
    if tool == "run_report" and "params_json" in out:
        try:
            raw = out.get("params_json")
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            out["params"] = parsed if isinstance(parsed, dict) else raw
        except Exception:  # noqa: BLE001
            pass
        out.pop("params_json", None)
    if tool == "save_record" and "payload_json" in out:
        try:
            raw = out.get("payload_json")
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            out["payload"] = parsed if isinstance(parsed, (dict, list)) else raw
        except Exception:  # noqa: BLE001
            pass
        out.pop("payload_json", None)
    if tool == "generate_document":
        for key in ("columns_json", "rows_json"):
            if key in out:
                try:
                    raw = out.get(key)
                    parsed = json.loads(raw) if isinstance(raw, str) else raw
                    out[key.replace("_json", "")] = parsed
                except Exception:  # noqa: BLE001
                    pass
                out.pop(key, None)
    if tool == "lookup_options" and "options_json" in out:
        out.pop("options_json", None)
    out.pop("config", None)
    return out


def _collect_tool_steps(messages):
    """收集本轮工具调用明细（名称、参数摘要、结果预览），供前端展示执行过程。
    只取最后一条 HumanMessage 之后的消息，避免累积历史。"""
    # 找到最后一条 HumanMessage 的索引，只处理其之后的消息
    last_human_idx = -1
    for i, m in enumerate(messages or []):
        if isinstance(m, HumanMessage):
            last_human_idx = i
    current_turn = (messages or [])[last_human_idx + 1:] if last_human_idx >= 0 else (messages or [])
    steps = []
    pending = {}
    for m in current_turn:
        if isinstance(m, AIMessage):
            for c in getattr(m, "tool_calls", None) or []:
                name = c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
                if not name:
                    continue
                raw_args = c.get("args") if isinstance(c, dict) else getattr(c, "args", {})
                tid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
                step = {
                    "tool": name,
                    "label": TOOL_LABELS.get(name, name),
                    "args": _summarize_args(name, raw_args),
                }
                steps.append(step)
                if tid:
                    pending[tid] = len(steps) - 1
        elif isinstance(m, ToolMessage):
            tid = getattr(m, "tool_call_id", None)
            idx = pending.get(tid)
            if idx is not None:
                content = m.content if isinstance(m.content, str) else str(m.content or "")
                preview, is_err = _tool_result_preview(content)
                steps[idx]["resultPreview"] = preview
                # 保留完整结果供前端复制（限 4000 字符避免过大）
                full = str(content or "").strip()
                if full and full != preview:
                    steps[idx]["resultFull"] = full[:4000]
                if is_err:
                    steps[idx]["status"] = "error"
    return steps


def _tool_result_preview(content: str):
    """解析工具返回；失败时提取可读错误供前台展示。"""
    text = str(content or "").strip()
    if not text:
        return "", False
    try:
        data = json.loads(text)
        if isinstance(data, dict) and data.get("success") is False:
            err = str(data.get("error") or "工具调用失败")
            return _truncate_text(err), True
    except Exception:  # noqa: BLE001
        pass
    if "失败" in text or text.startswith("（读取资源失败"):
        return _truncate_text(text), True
    return _truncate_text(text), False


def _collect_tool_names(steps):
    return [s.get("tool") for s in steps if s.get("tool")]


def _guess_skill(tool_names, steps):
    for s in steps:
        if s.get("tool") == "read_skill_resource":
            sk = (s.get("args") or {}).get("skill_name")
            if sk:
                return str(sk)
    if "save_record" in tool_names:
        for s in steps:
            if s.get("tool") == "save_record":
                ent = (s.get("args") or {}).get("entity")
                if ent:
                    return str(ent)
        return "save-record"
    if "generate_document" in tool_names:
        return "doc-export"
    if any(t in ("run_report", "lookup_options", "run_sql") for t in tool_names):
        # 优先从 run_sql 的 skill_name 参数获取真实 skill 名称
        for s in steps:
            if s.get("tool") == "run_sql":
                sk = (s.get("args") or {}).get("skill_name")
                if sk:
                    return str(sk)
        return "report-query"
    if "knowledge_search" in tool_names:
        return "knowledge-qa"
    return None


def run_turn(*, thread_id, scoped_token, input_obj, history, skills, user):
    graph = get_graph()
    config = {"configurable": {"thread_id": thread_id, "scoped_token": scoped_token}}

    if input_obj.get("type") == "resume":
        result = graph.invoke(Command(resume=input_obj.get("value")), config)
    else:
        content = str(input_obj.get("content", ""))
        existing = False
        try:
            state = graph.get_state(config)
            existing = bool(state and state.values and state.values.get("messages"))
        except Exception:  # noqa: BLE001
            existing = False

        if existing:
            messages = [HumanMessage(content=content)]
        else:
            hist = history or [{"role": "user", "content": content}]
            seeded = [SystemMessage(content=build_system_prompt(skills, user))]
            for m in hist:
                if m.get("role") == "user":
                    seeded.append(HumanMessage(content=m.get("content", "")))
                elif m.get("role") == "assistant":
                    seeded.append(AIMessage(content=m.get("content", "")))
            messages = seeded
        result = graph.invoke({"messages": messages}, config)

    clar = _interrupt_payload(result)
    msgs = result.get("messages", []) if isinstance(result, dict) else []
    tool_steps = _collect_tool_steps(msgs)
    tool_names = _collect_tool_names(tool_steps)
    skill_used = _guess_skill(tool_names, tool_steps)

    if clar:
        # 透传整个中断负载：消歧为 {type:'clarification', field, question, options}，
        # 保存确认为 {type:'save_confirm', entity, payload, question}
        clarification = {
            "type": clar.get("type", "clarification"),
            "field": clar.get("field", "value"),
            "question": clar.get("question", "请补充信息"),
            "options": clar.get("options", []),
        }
        if clar.get("type") == "save_confirm":
            clarification["entity"] = clar.get("entity")
            clarification["payload"] = clar.get("payload", {})
        return {
            "status": "need_clarification",
            "clarification": clarification,
            "skillUsed": skill_used,
            "toolCalls": tool_names,
            "toolSteps": tool_steps,
        }

    final = ""
    for m in reversed(msgs):
        if isinstance(m, AIMessage) and getattr(m, "content", ""):
            final = m.content if isinstance(m.content, str) else str(m.content)
            break
    return {
        "status": "final",
        "message": final or "（无回复）",
        "skillUsed": skill_used,
        "toolCalls": tool_names,
        "toolSteps": tool_steps,
    }
