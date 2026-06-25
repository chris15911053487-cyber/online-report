"""Agent 白名单工具（skill 的执行层）。

安全要点：
- 工具是唯一的"执行手"，全部经主后端 internal 端点取数，受 canAccessMenu 门禁；
- LLM 只能选择工具与填参，无法执行任意代码或拼 SQL；
- ask_user_to_choose 触发 LangGraph interrupt，实现"消歧/确认"的人机协同。
"""
import base64
import csv
import io
import json

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.types import interrupt

from .backend_client import BackendClient


def _client(config: RunnableConfig) -> BackendClient:
    cfg = (config or {}).get("configurable", {})
    token = cfg.get("scoped_token")
    if not token:
        raise RuntimeError("missing scoped_token in config")
    return BackendClient(token)


def _lenient_json_parse(value, fallback=None):
    """尝试解析 JSON，容忍 LLM 常见格式问题（单引号、尾逗号、已是 Python 对象等）。"""
    if not isinstance(value, str):
        return value if value is not None else fallback
    text = value.strip()
    if not text:
        return fallback
    # 标准 JSON 解析
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        pass
    # LLM 有时用单引号或 Python repr 风格
    import ast
    try:
        result = ast.literal_eval(text)
        if isinstance(result, (list, dict)):
            return result
    except Exception:  # noqa: BLE001
        pass
    # 去除尾逗号后重试
    import re
    cleaned = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(cleaned)
    except Exception:  # noqa: BLE001
        pass
    return fallback


@tool
def knowledge_search(query: str, config: RunnableConfig) -> str:
    """检索系统使用说明 / 操作流程知识库。用于回答"怎么用、如何操作、是什么意思"类问题。
    参数 query 为用户的自然语言问题。返回相关知识片段（含标题）。"""
    data = _client(config).knowledge_search(query, 5)
    chunks = data.get("chunks", [])
    if not chunks:
        return "（知识库未检索到相关内容）"
    return "\n\n".join(f"【{c.get('title','')}】\n{c.get('body','')}" for c in chunks)


@tool
def read_skill_resource(skill_name: str, path: str, config: RunnableConfig) -> str:
    """按需读取某个 skill 包内的文本资源文件（references/examples 等）。
    当 skill 的资源清单里列出了相关文件、且你需要其中细节（流程规范、字段说明、示例）时调用。
    skill_name：skill 名称；path：资源相对路径（如 references/fields.md）。返回文件文本内容。"""
    try:
        data = _client(config).skill_resource(skill_name, path)
    except RuntimeError as e:
        err_str = str(e)
        if "AGENT_RESOURCE_NOT_FOUND" in err_str or "404" in err_str:
            return f"该 skill 无此资源文件（{path}），无需读取，请直接根据 skill 正文中的信息继续执行。"
        return f"（读取资源失败：{e}）"
    return str(data.get("content", ""))


def _tool_error(tool: str, exc: Exception) -> str:
    return json.dumps({"success": False, "tool": tool, "error": str(exc)}, ensure_ascii=False)


@tool
def lookup_options(route_key: str, field_name: str, keyword: str, config: RunnableConfig) -> str:
    """按关键词查找某报表筛选字段的候选项（用于实体消歧，如按客户名找客户编码）。
    route_key：报表路由；field_name：筛选字段名（如 customer）；keyword：搜索关键词（如客户名）。
    返回候选项 JSON 列表 [{value, label}]，供后续让用户确认编码。"""
    try:
        data = _client(config).lookup_options(route_key, field_name, keyword)
    except RuntimeError as e:
        return _tool_error("lookup_options", e)
    options = data.get("options", [])
    return json.dumps(
        {"success": True, "options": options, "total": data.get("total", len(options))},
        ensure_ascii=False,
    )


@tool
def run_report(route_key: str, params_json: str, config: RunnableConfig) -> str:
    """执行只读报表查询取数。route_key：报表路由；params_json：参数对象的 JSON 字符串
    （如 {"customer":"C001","year":2026}）。返回列与数据行（已做中英文列名映射）。"""
    try:
        params = json.loads(params_json) if isinstance(params_json, str) else (params_json or {})
    except Exception:  # noqa: BLE001
        params = {}
    try:
        data = _client(config).run_report(route_key, params)
    except RuntimeError as e:
        return _tool_error("run_report", e)
    return json.dumps(
        {
            "success": True,
            "label": data.get("label"),
            "columns": data.get("columns", []),
            "rows": data.get("rows", []),
            "totalRowCount": data.get("totalRowCount", 0),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def run_sql(sql_query: str, skill_name: str, config: RunnableConfig) -> str:
    """直接执行只读 SQL 查询（仅允许 SELECT）。必须在某个 skill 工作流中使用。
    sql_query：完整的 SELECT 语句；skill_name：当前正在执行的 skill 名称（如 customer-master-data-query）。
    返回列名与数据行（最多 200 行）。"""
    try:
        data = _client(config).run_sql(sql_query, skill_name)
    except RuntimeError as e:
        return _tool_error("run_sql", e)
    return json.dumps(
        {
            "success": True,
            "skill": skill_name,
            "columns": data.get("columns", []),
            "rows": data.get("rows", []),
            "totalRowCount": data.get("totalRowCount", 0),
            "truncated": data.get("truncated", False),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def ask_user_to_choose(field: str, question: str, options_json: str) -> str:
    """当需要用户确认（如多个同名客户、保存前最终确认）时调用。会暂停并向用户出示结构化选项。
    field：要确认的字段名（如 customer_code）；question：给用户看的问题；
    options_json：候选项 JSON 列表 [{value,label}]。用户选择后返回所选 value。"""
    try:
        options = json.loads(options_json) if isinstance(options_json, str) else (options_json or [])
    except Exception:  # noqa: BLE001
        options = []
    chosen = interrupt(
        {"type": "clarification", "field": field, "question": question, "options": options}
    )
    return f"用户已选择 {field} = {chosen}"


def _confirmed(decision) -> bool:
    return str(decision).strip().lower() in ("confirm", "yes", "true", "确认", "是", "ok")


@tool
def save_record(entity: str, payload_json: str, config: RunnableConfig) -> str:
    """向系统写入一条记录（单保存）。entity：后台配置的写入实体名；
    payload_json：字段对象的 JSON 字符串。会先向用户出示预览并要求确认，确认后才真正写库。
    只能写后台白名单实体与字段，且受角色门禁。"""
    payload = _lenient_json_parse(payload_json, None)
    if not isinstance(payload, dict):
        return "payload_json 不是合法 JSON，已取消保存。"
    decision = interrupt(
        {
            "type": "save_confirm",
            "entity": entity,
            "payload": payload,
            "question": f"确认保存到「{entity}」？请核对内容后确认。",
        }
    )
    if not _confirmed(decision):
        return "用户取消了保存，未写入任何数据。"
    data = _client(config).save_record(entity, payload)
    return json.dumps({"success": data.get("success", True), "inserted": data.get("inserted")}, ensure_ascii=False, default=str)


@tool
def generate_document(title: str, fmt: str, columns_json: str, rows_json: str, config: RunnableConfig) -> str:
    """把数据导出为可下载文档。title：文件标题；fmt：'xlsx' 或 'csv'；
    columns_json：列名数组 JSON；rows_json：行数组 JSON（每行为对象）。
    返回包含鉴权下载链接的说明，请把链接转达给用户。"""
    columns = _lenient_json_parse(columns_json, [])
    rows = _lenient_json_parse(rows_json, [])
    if not isinstance(columns, list) or not isinstance(rows, list):
        return "columns_json / rows_json 不是合法 JSON，已取消导出。"

    fmt = (fmt or "xlsx").lower()
    safe_title = (title or "导出数据").strip()[:80]

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(columns)
        for r in rows:
            writer.writerow([r.get(c, "") if isinstance(r, dict) else "" for c in columns])
        content = ("\ufeff" + buf.getvalue()).encode("utf-8")  # BOM 便于 Excel 识别中文
        ext = "csv"
    else:
        try:
            from openpyxl import Workbook
        except Exception:  # noqa: BLE001
            return "服务未安装 openpyxl，无法生成 xlsx；请改用 fmt='csv'。"
        wb = Workbook()
        ws = wb.active
        ws.title = safe_title[:31] or "Sheet1"
        ws.append([str(c) for c in columns])
        for r in rows:
            ws.append([(r.get(c, "") if isinstance(r, dict) else "") for c in columns])
        bio = io.BytesIO()
        wb.save(bio)
        content = bio.getvalue()
        ext = "xlsx"

    content_b64 = base64.b64encode(content).decode("ascii")
    data = _client(config).store_document(f"{safe_title}.{ext}", ext, content_b64)
    url = data.get("downloadUrl", "")
    name = data.get("filename", f"{safe_title}.{ext}")
    return json.dumps(
        {"filename": name, "downloadUrl": url, "hint": f"已生成文档，请把下载链接转达用户：[{name}]({url})"},
        ensure_ascii=False,
    )


@tool
def generate_chart(title: str, chart_type: str, option_json: str, config: RunnableConfig) -> str:
    """生成一个前端可渲染的图表。当用户需要数据可视化（趋势图、对比图、占比图等）时调用。
    title：图表标题；chart_type：'bar'|'line'|'pie'；
    option_json：ECharts option 对象的 JSON 字符串（包含 xAxis/yAxis/series 等，无需包含 title）。
    示例 bar: {"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[10,20]}]}
    示例 pie: {"series":[{"type":"pie","data":[{"name":"A","value":10},{"name":"B","value":20}]}]}
    重要：调用此工具后，在你的文字回复中用 ![图表标题] 标记图表应出现的位置（标题需与参数 title 对应），前端会自动在该位置渲染图表。
    返回成功标识，前端会自动渲染图表。"""
    option = _lenient_json_parse(option_json, None)
    if not isinstance(option, dict):
        return json.dumps({"success": False, "error": "option_json 不是合法 JSON"}, ensure_ascii=False)
    # 注入标题
    option.setdefault("title", {})
    if isinstance(option["title"], dict):
        option["title"].setdefault("text", title)
    # 注入 tooltip
    option.setdefault("tooltip", {"trigger": "axis" if chart_type != "pie" else "item"})
    return json.dumps({"success": True, "chart": option}, ensure_ascii=False, default=str)


ALL_TOOLS = [
    knowledge_search,
    read_skill_resource,
    run_sql,
    ask_user_to_choose,
    save_record,
    generate_document,
    generate_chart,
]
