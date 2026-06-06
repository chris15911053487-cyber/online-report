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
def lookup_options(route_key: str, field_name: str, keyword: str, config: RunnableConfig) -> str:
    """按关键词查找某报表筛选字段的候选项（用于实体消歧，如按客户名找客户编码）。
    route_key：报表路由；field_name：筛选字段名（如 customer）；keyword：搜索关键词（如客户名）。
    返回候选项 JSON 列表 [{value, label}]，供后续让用户确认编码。"""
    data = _client(config).lookup_options(route_key, field_name, keyword)
    options = data.get("options", [])
    return json.dumps({"options": options, "total": data.get("total", len(options))}, ensure_ascii=False)


@tool
def run_report(route_key: str, params_json: str, config: RunnableConfig) -> str:
    """执行只读报表查询取数。route_key：报表路由；params_json：参数对象的 JSON 字符串
    （如 {"customer":"C001","year":2026}）。返回列与数据行（已做中英文列名映射）。"""
    try:
        params = json.loads(params_json) if isinstance(params_json, str) else (params_json or {})
    except Exception:  # noqa: BLE001
        params = {}
    data = _client(config).run_report(route_key, params)
    return json.dumps(
        {
            "label": data.get("label"),
            "columns": data.get("columns", []),
            "rows": data.get("rows", []),
            "totalRowCount": data.get("totalRowCount", 0),
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
    try:
        payload = json.loads(payload_json) if isinstance(payload_json, str) else (payload_json or {})
    except Exception:  # noqa: BLE001
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
    try:
        columns = json.loads(columns_json) if isinstance(columns_json, str) else (columns_json or [])
        rows = json.loads(rows_json) if isinstance(rows_json, str) else (rows_json or [])
    except Exception:  # noqa: BLE001
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


ALL_TOOLS = [
    knowledge_search,
    lookup_options,
    run_report,
    ask_user_to_choose,
    save_record,
    generate_document,
]
