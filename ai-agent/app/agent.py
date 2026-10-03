"""LangGraph agent：skill 编排 + 工具调用 + 中断/恢复（消歧/确认）。

- 用 create_react_agent 跑工具调用循环；
- SqliteSaver 做 checkpoint，按 thread_id 支持 interrupt/resume；
- system prompt 注入"按角色过滤后的 skill 清单"（第 1 层权限），执行落白名单工具。
"""
import json
import os
import re
import sqlite3

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent
from langgraph.types import Command

from .bi_context import compose_user_message
from . import steps as _steps
from .recorder import TurnRecorder
from .config import settings
from .skill_prompt import format_skill_full, format_skill_index, index_skills, should_lazy_load
from .tools import ALL_TOOLS

# 全局约束规则的内置默认值（兜底）：当 agent_rules.md 缺失或为空时使用。
_DEFAULT_BASE_INSTRUCTIONS = (
    "你是工厂在线报表系统的 AI 助手。遵循以下原则：\n"
    "1. 你可以通过 run_sql 工具直接编写并执行 SELECT 查询来获取数据（仅允许 SELECT，禁止写操作）。\n"
    "2. **重要**：run_sql 只能在某个 skill 的工作流中使用。每次执行 SQL 查询时，你必须明确是在执行哪个 skill。\n"
    "   如果用户的请求不匹配任何可用 skill，告知用户当前无对应能力，不要自行执行 SQL。\n"
    "   且只能执行该 skill 的 body_md 中明确描述或示例的 SQL 模式和表，不可自行发挥查询其他表或拼接 skill 未提及的逻辑。\n"
    "3. 只回答用户有权访问的数据；工具返回无权/未找到时如实告知。\n"
    "4. 用简洁中文作答；涉及知识问答时注明参考来源标题。\n"
    "5. 所有数据查询统一通过 run_sql 工具执行，不依赖菜单预配置的报表。\n"
    "6. 如果 run_sql 未返回数据，严禁编造数字，如实告知用户查无结果。\n"
    "7. 回复末尾可附加快捷操作建议（JSON 块），帮助用户一键执行下一步。格式：\n"
    '   ```suggested_actions\n'
    '   [{"type":"navigate","view":"settings","label":"打开设置"},\n'
    '    {"type":"openProSign","label":"进入生产报工"},\n'
    '    {"type":"openCatalog","label":"打开菜单"},\n'
    '    {"type":"followup","label":"如何暂停报工？"}]\n'
    "   ```\n"
    "   支持的 type：navigate（需 view 字段：settings/catalog）、openCatalog、openProSign、followup（追问建议）。\n"
    "   只在有意义时附加，不要每次都加；最多 3 个。如果不需要就不要输出此块。\n"
    "8. 效率：相互独立的查询在同一轮一次性发出多个工具调用（会并行执行）；优先用一条带 CTE / GROUP BY / 条件聚合的汇总 SQL，"
    "不要为每个维度各写一条；工具只返回前几十行，需要总览请在 SQL 里聚合。\n"
)

# 全局约束规则 md 文件路径（可通过环境变量 AGENT_RULES_FILE 覆盖）。
AGENT_RULES_FILE = os.getenv(
    "AGENT_RULES_FILE",
    os.path.join(os.path.dirname(__file__), "agent_rules.md"),
)


def _strip_html_comments(text: str) -> str:
    """移除 md 中的 HTML 注释块（<!-- ... -->），这些仅为维护说明，不应进入 prompt。"""
    return re.sub(r"<!--[\s\S]*?-->", "", text)


def load_base_instructions() -> str:
    """读取全局约束规则 md。文件缺失/为空/读取失败时回退到内置默认值。"""
    try:
        with open(AGENT_RULES_FILE, encoding="utf-8") as f:
            content = _strip_html_comments(f.read()).strip()
        if content:
            return content
    except FileNotFoundError:
        pass
    except OSError:
        pass
    return _DEFAULT_BASE_INSTRUCTIONS


def _build_model(model_name: str | None = None, max_tokens: int | None = None):
    from langchain_openai import ChatOpenAI

    kwargs = {
        "model": model_name or settings.DEFAULT_MODEL,
        "temperature": settings.TEMPERATURE,
        "api_key": settings.resolve_api_key() or "dummy-key-for-dev",
        "timeout": settings.TIMEOUT_MS / 1000.0,
        "max_tokens": max_tokens or settings.MAX_TOKENS,
        # 流式输出：token 经回调实时推给 SSE；对普通 /chat 调用无副作用
        "streaming": True,
    }
    if settings.STREAM_USAGE:
        # 让流式响应带回 token 用量（用于显示 prompt 大小）。个别 OpenAI 兼容服务不支持，故默认关闭
        kwargs["stream_usage"] = True
    base_url = settings.resolve_base_url()
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


_graph = None
_fast_graph = None
_saver = None


def _get_saver():
    global _saver
    if _saver is None:
        os.makedirs(os.path.dirname(settings.CHECKPOINT_DB) or ".", exist_ok=True)
        conn = sqlite3.connect(settings.CHECKPOINT_DB, check_same_thread=False)
        _saver = SqliteSaver(conn)
    return _saver


def fast_model_enabled() -> bool:
    return bool(settings.FAST_MODEL) and settings.FAST_MODEL != settings.DEFAULT_MODEL


def get_graph(mode: str | None = None):
    """mode='fast' 且配置了 AI_FAST_MODEL 时返回快模型图，否则返回主模型图。

    两张图共用同一个 checkpointer：同一会话线程在快 / 主模型之间切换时上下文连续
    （例如先点「AI 解读」用快模型，接着追问用主模型，主模型能看到前面的解读）。
    """
    global _graph, _fast_graph
    if mode == "fast" and fast_model_enabled():
        if _fast_graph is None:
            model = _build_model(settings.FAST_MODEL, settings.FAST_MAX_TOKENS)
            _fast_graph = create_react_agent(model, ALL_TOOLS, checkpointer=_get_saver())
        return _fast_graph
    if _graph is None:
        _graph = create_react_agent(_build_model(), ALL_TOOLS, checkpointer=_get_saver())
    return _graph


def build_system_prompt(skills, user, agent_prompt: str = "") -> str:
    lines = [load_base_instructions(), "", "## 可用 skill（按你的权限过滤后）"]
    if not skills:
        lines.append("（当前无可用 skill，仅可做一般性回答）")
    elif should_lazy_load(skills, settings.SKILL_INLINE_MAX_CHARS):
        # skill 正文总量较大：只放索引，命中后由 load_skill 按需取完整说明，避免 prompt 膨胀
        lines.extend(format_skill_index(skills))
    else:
        for s in skills:
            lines.extend(format_skill_full(s))
    # 附加该 Agent 专属指令（来自 dbo.agents.system_prompt_extra）
    if agent_prompt and agent_prompt.strip():
        lines.append("")
        lines.append("## Agent 专属指令")
        lines.append(agent_prompt.strip())
    # 随用户变化的内容必须放在最后：前面的「全局规则 + skill + Agent 指令」对同角色的所有用户逐字相同，
    # OpenAI 兼容服务（如 DeepSeek）按相同前缀自动缓存，前缀越长命中越多、首 token 越快。
    display_name = (user or {}).get("displayName") or ""
    user_code = (user or {}).get("userCode") or ""
    roles = (user or {}).get("roles") or []
    if display_name or user_code or roles:
        lines.append("")
    if display_name:
        lines.append(f"当前用户：{display_name}")
    if user_code:
        lines.append(f"当前用户编码：{user_code}（对应数据库 OUSR.USER_CODE，可用于按用户过滤查询）")
    if roles:
        lines.append(f"当前用户角色：{', '.join(roles)}")
    return "\n".join(lines)


def _interrupt_payload(result, graph=None, config=None):
    """取出挂起的人机协同中断负载（消歧 / 保存确认）。

    新版 LangGraph 的 invoke 结果里带 __interrupt__；但 requirements 固定的 0.2.x 不带，
    此时必须从 checkpoint 状态（StateSnapshot.tasks[*].interrupts）里取——两种方式都兼容。
    """
    intr = result.get("__interrupt__") if isinstance(result, dict) else None
    if intr:
        first = intr[0] if isinstance(intr, (list, tuple)) and intr else intr
        return getattr(first, "value", None) or (first if isinstance(first, dict) else None)
    if graph is not None:
        try:
            state = graph.get_state(config)
            for task in getattr(state, "tasks", None) or ():
                for it in getattr(task, "interrupts", None) or ():
                    value = getattr(it, "value", None)
                    if value:
                        return value
        except Exception:  # noqa: BLE001
            pass
    return None


# 工具步骤展示辅助已移至 steps.py；保留旧名称别名以兼容既有引用
TOOL_LABELS = _steps.TOOL_LABELS
_truncate_text = _steps.truncate_text
_summarize_args = _steps.summarize_args
_tool_result_preview = _steps.tool_result_preview


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
                    "id": tid,  # tool_call_id：用于把工具耗时写回步骤
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
                # 保留完整结果供前端复制
                full = str(content or "").strip()
                if full and full != preview:
                    steps[idx]["resultFull"] = full
                if is_err:
                    steps[idx]["status"] = "error"
    return steps


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
    if "run_named_query" in tool_names and "run_sql" not in tool_names:
        return "bi-named-query"
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
    # 只加载了 skill 但没执行后续工具（如直接答复 / 追问）：以加载的 skill 为准
    for s in steps:
        if s.get("tool") == "load_skill":
            sk = (s.get("args") or {}).get("skill_name")
            if sk:
                return str(sk)
    return None


_ACTIONS_BLOCK_RE = re.compile(
    r"```suggested_actions\s*\n([\s\S]*?)\n```", re.MULTILINE
)

_VALID_TYPES = {"navigate", "openCatalog", "openProSign", "followup"}


def _extract_suggested_actions(text):
    """从 AI 回复中提取 suggested_actions 代码块，返回 (cleaned_text, actions_list)。"""
    m = _ACTIONS_BLOCK_RE.search(text)
    if not m:
        return text, []
    raw = m.group(1).strip()
    cleaned = text[: m.start()].rstrip() + text[m.end():]
    cleaned = cleaned.rstrip()
    try:
        actions = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return cleaned, []
    if not isinstance(actions, list):
        return cleaned, []
    valid = []
    for a in actions[:3]:
        if isinstance(a, dict) and a.get("type") in _VALID_TYPES and a.get("label"):
            valid.append({k: v for k, v in a.items() if k in ("type", "label", "view")})
    return cleaned, valid


def run_turn(
    *,
    thread_id,
    scoped_token,
    input_obj,
    history,
    skills,
    user,
    agent_prompt: str = "",
    recorder=None,
    context: dict | None = None,
    mode: str | None = None,
):
    graph = get_graph(mode)
    recorder = recorder or TurnRecorder()
    config = {
        "configurable": {
            "thread_id": thread_id,
            "scoped_token": scoped_token,
            # load_skill 的查表来源：每次请求都由网关带来（已按角色/Agent 过滤），
            # 不依赖 checkpoint，重启或 resume 后仍可用。值为 dict（非基础类型），不会写入 checkpoint 元数据。
            "skills_by_name": index_skills(skills),
        },
        # 记录 LLM/工具耗时；流式接口通过它实时推送事件
        "callbacks": [recorder],
    }

    if input_obj.get("type") == "resume":
        result = graph.invoke(Command(resume=input_obj.get("value")), config)
    else:
        raw_content = str(input_obj.get("content", ""))
        # 看板点击上下文注入本轮用户消息（不进 system prompt，保持前缀缓存）
        content = compose_user_message(raw_content, context)
        existing = False
        try:
            state = graph.get_state(config)
            existing = bool(state and state.values and state.values.get("messages"))
        except Exception:  # noqa: BLE001
            existing = False

        if existing:
            messages = [HumanMessage(content=content)]
        else:
            hist = history or [{"role": "user", "content": raw_content}]
            seeded = [SystemMessage(content=build_system_prompt(skills, user, agent_prompt))]
            for m in hist:
                if m.get("role") == "user":
                    seeded.append(HumanMessage(content=m.get("content", "")))
                elif m.get("role") == "assistant":
                    seeded.append(AIMessage(content=m.get("content", "")))
            if content != raw_content:
                # 网关落库的是用户原话；新线程用历史播种时，把本轮那条换成带上下文的版本
                for i in range(len(seeded) - 1, 0, -1):
                    if isinstance(seeded[i], HumanMessage):
                        if seeded[i].content == raw_content:
                            seeded[i] = HumanMessage(content=content)
                        else:
                            seeded.append(HumanMessage(content=content))
                        break
                else:
                    seeded.append(HumanMessage(content=content))
            messages = seeded
        result = graph.invoke({"messages": messages}, config)

    clar = _interrupt_payload(result, graph, config)
    msgs = result.get("messages", []) if isinstance(result, dict) else []
    tool_steps = recorder.apply_durations(_collect_tool_steps(msgs))
    timings = recorder.summary()
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
            "timings": timings,
        }

    final = ""
    for m in reversed(msgs):
        if isinstance(m, AIMessage) and getattr(m, "content", ""):
            final = m.content if isinstance(m.content, str) else str(m.content)
            break
    message_text, actions = _extract_suggested_actions(final or "（无回复）")
    return {
        "status": "final",
        "message": message_text,
        "actions": actions,
        "skillUsed": skill_used,
        "toolCalls": tool_names,
        "toolSteps": tool_steps,
        "timings": timings,
    }
