"""工具步骤的展示辅助：标签、参数摘要、结果预览。

从 agent.py 抽出，供 agent.py（整理 toolSteps）与 recorder.py（实时事件）共用，避免循环引用。
"""
import json

TOOL_LABELS = {
    "knowledge_search": "检索知识库",
    "read_skill_resource": "读取 Skill 资源",
    "load_skill": "加载 Skill",
    "lookup_options": "查找候选项",
    "run_report": "执行报表查询",
    "run_sql": "执行 SQL 查询",
    "ask_user_to_choose": "等待用户确认",
    "save_record": "保存记录",
    "generate_document": "生成文档",
    "generate_chart": "生成图表",
    "web_search": "联网搜索",
    "url_fetch": "抓取网页",
}


def truncate_text(text, limit=180):
    s = str(text or "").replace("\n", " ").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def summarize_args(tool, args):
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


def tool_result_preview(content: str):
    """解析工具返回；失败时提取可读错误供前台展示。"""
    text = str(content or "").strip()
    if not text:
        return "", False
    try:
        data = json.loads(text)
        if isinstance(data, dict) and data.get("success") is False:
            err = str(data.get("error") or "工具调用失败")
            return truncate_text(err), True
    except Exception:  # noqa: BLE001
        pass
    if "失败" in text or text.startswith("（读取资源失败"):
        return truncate_text(text), True
    return truncate_text(text), False
