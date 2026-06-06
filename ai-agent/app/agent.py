"""LangGraph agent：skill 编排 + 工具调用 + 中断/恢复（消歧/确认）。

- 用 create_react_agent 跑工具调用循环；
- SqliteSaver 做 checkpoint，按 thread_id 支持 interrupt/resume；
- system prompt 注入"按角色过滤后的 skill 清单"（第 1 层权限），执行落白名单工具。
"""
import sqlite3
import os

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent
from langgraph.types import Command

from .config import settings
from .tools import ALL_TOOLS

BASE_INSTRUCTIONS = (
    "你是工厂在线报表系统的 AI 助手。遵循以下原则：\n"
    "1. 只能通过提供的工具获取数据，严禁编造数据或自行拼写 SQL。\n"
    "2. 需要用户确认时（如多个同名客户、保存前最终确认），调用 ask_user_to_choose 出示候选，不要自行猜测。\n"
    "3. 即使只匹配到一个候选，也按对应 skill 的要求决定是否仍需确认。\n"
    "4. 只回答用户有权访问的数据；工具返回无权/未找到时如实告知。\n"
    "5. 用简洁中文作答；涉及知识问答时注明参考来源标题。\n"
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


def _collect_tool_names(messages):
    names = []
    for m in messages or []:
        tc = getattr(m, "tool_calls", None)
        if tc:
            for c in tc:
                n = c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
                if n:
                    names.append(n)
    return names


def _guess_skill(tool_names):
    if "save_record" in tool_names:
        return "save-record"
    if "generate_document" in tool_names:
        return "doc-export"
    if any(t in ("run_report", "lookup_options") for t in tool_names):
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
    tool_names = _collect_tool_names(msgs)
    skill_used = _guess_skill(tool_names)

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
        }

    final = ""
    for m in reversed(msgs):
        if isinstance(m, AIMessage) and getattr(m, "content", ""):
            final = m.content if isinstance(m.content, str) else str(m.content)
            break
    return {"status": "final", "message": final or "（无回复）", "skillUsed": skill_used, "toolCalls": tool_names}
