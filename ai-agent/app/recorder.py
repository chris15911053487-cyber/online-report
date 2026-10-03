"""一次对话回合的记录器（LangChain 回调处理器）。

作用：
1. 记录每次 LLM 调用、每个工具调用的耗时（供 toolSteps.durationMs 与 timings 使用）；
2. 可选地把实时事件推给调用方（SSE 流式：llm_start / delta / llm_end / tool_call / tool_result）；
3. 在 LLM 调用的边界处响应「取消」——客户端断开后不再发起新的 LLM 调用。

取消只在 on_chat_model_start 处生效，不打断正在执行的工具：
此时图状态必然停在「所有 tool_calls 都已有对应 ToolMessage」的位置，
下一轮追加用户消息不会触发 INVALID_CHAT_HISTORY。若在工具开始时取消，会留下没有 ToolMessage 的 tool_calls，
破坏后续会话，因此刻意不这样做。
"""
import threading
import time

from langchain_core.callbacks import BaseCallbackHandler

from .steps import TOOL_LABELS, summarize_args, tool_result_preview

_INTERRUPT_NAMES = {"GraphInterrupt", "NodeInterrupt"}


class TurnCancelled(Exception):
    """客户端已断开，回合在 LLM 调用边界被终止。"""


def _ms(t0: float) -> int:
    return int(round((time.perf_counter() - t0) * 1000))


class TurnRecorder(BaseCallbackHandler):
    # 让 TurnCancelled 能穿透 LangChain 的回调层；其余回调方法内部自行吞掉异常，避免拖垮回合。
    raise_error = True

    def __init__(self, emit=None, cancel_event: "threading.Event | None" = None):
        self._emit_fn = emit
        self._cancel = cancel_event
        self._t0 = time.perf_counter()
        self._lock = threading.Lock()
        self._llm_runs = {}      # run_id -> {"t0", "n"}
        self._tool_runs = {}     # run_id -> {"t0", "tool"}
        self.llm_calls = []      # [{"durationMs", "toolCalls", "inputTokens"?, "outputTokens"?}]
        self.tool_durations = {}  # tool_call_id -> ms
        self._round = 0

    # ---------- 内部 ----------
    def _emit(self, event: dict):
        if not self._emit_fn:
            return
        try:
            self._emit_fn(event)
        except Exception:  # noqa: BLE001  推送失败不应影响回合
            pass

    # ---------- LLM ----------
    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        if self._cancel is not None and self._cancel.is_set():
            raise TurnCancelled()
        try:
            with self._lock:
                self._round += 1
                n = self._round
                self._llm_runs[run_id] = {"t0": time.perf_counter(), "n": n}
            self._emit({"type": "llm_start", "id": str(run_id), "round": n})
        except Exception:  # noqa: BLE001
            pass

    def on_llm_new_token(self, token, *, run_id, **kwargs):
        if token:
            self._emit({"type": "delta", "text": token, "llmId": str(run_id)})

    def on_llm_end(self, response, *, run_id, **kwargs):
        try:
            run = self._llm_runs.pop(run_id, None)
            dur = _ms(run["t0"]) if run else 0
            n_tool_calls = 0
            usage = {}
            try:
                msg = response.generations[0][0].message
                n_tool_calls = len(getattr(msg, "tool_calls", None) or [])
                um = getattr(msg, "usage_metadata", None) or {}
                if um.get("input_tokens") is not None:
                    usage["inputTokens"] = int(um["input_tokens"])
                if um.get("output_tokens") is not None:
                    usage["outputTokens"] = int(um["output_tokens"])
            except Exception:  # noqa: BLE001
                pass
            call = {"durationMs": dur, "toolCalls": n_tool_calls, **usage}
            with self._lock:
                self.llm_calls.append(call)
            self._emit({"type": "llm_end", "id": str(run_id), "round": run["n"] if run else None, **call})
        except Exception:  # noqa: BLE001
            pass

    def on_llm_error(self, error, *, run_id, **kwargs):
        try:
            run = self._llm_runs.pop(run_id, None)
            dur = _ms(run["t0"]) if run else 0
            with self._lock:
                self.llm_calls.append({"durationMs": dur, "toolCalls": 0, "error": str(error)[:200]})
            self._emit({"type": "llm_end", "id": str(run_id), "round": run["n"] if run else None,
                        "durationMs": dur, "toolCalls": 0, "error": str(error)[:200]})
        except Exception:  # noqa: BLE001
            pass

    # ---------- 工具 ----------
    def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        try:
            name = (serialized or {}).get("name") or kwargs.get("name") or ""
            args = inputs if isinstance(inputs, dict) else {}
            with self._lock:
                self._tool_runs[run_id] = {"t0": time.perf_counter(), "tool": name}
            self._emit({
                "type": "tool_call",
                "id": str(run_id),
                "tool": name,
                "label": TOOL_LABELS.get(name, name),
                "args": summarize_args(name, args),
            })
        except Exception:  # noqa: BLE001
            pass

    def on_tool_end(self, output, *, run_id, **kwargs):
        try:
            run = self._tool_runs.pop(run_id, None)
            dur = _ms(run["t0"]) if run else 0
            tool = run["tool"] if run else ""
            content = getattr(output, "content", output)
            tcid = getattr(output, "tool_call_id", None)
            preview, is_err = tool_result_preview(content if isinstance(content, str) else str(content or ""))
            if tcid:
                with self._lock:
                    self.tool_durations[tcid] = dur
            self._emit({
                "type": "tool_result",
                "id": str(run_id),
                "toolCallId": tcid,
                "tool": tool,
                "ok": not is_err,
                "durationMs": dur,
                "preview": preview,
            })
        except Exception:  # noqa: BLE001
            pass

    def on_tool_error(self, error, *, run_id, **kwargs):
        try:
            run = self._tool_runs.pop(run_id, None)
            dur = _ms(run["t0"]) if run else 0
            tool = run["tool"] if run else ""
            if type(error).__name__ in _INTERRUPT_NAMES:
                # 人机协同中断（消歧/保存确认）：不是失败，等待用户
                self._emit({"type": "tool_result", "id": str(run_id), "tool": tool, "ok": True,
                            "waiting": True, "durationMs": dur, "preview": "等待用户确认"})
            else:
                self._emit({"type": "tool_result", "id": str(run_id), "tool": tool, "ok": False,
                            "durationMs": dur, "preview": str(error)[:200]})
        except Exception:  # noqa: BLE001
            pass

    # ---------- 汇总 ----------
    def summary(self) -> dict:
        total = _ms(self._t0)
        with self._lock:
            calls = list(self.llm_calls)
        llm_ms = sum(c.get("durationMs", 0) for c in calls)
        out = {
            "totalMs": total,
            "llmMs": llm_ms,
            # 工具执行与框架开销（并行工具按墙钟计，所以不是各工具耗时之和）
            "otherMs": max(0, total - llm_ms),
            "llmCalls": len(calls),
        }
        in_tok = [c["inputTokens"] for c in calls if "inputTokens" in c]
        out_tok = [c["outputTokens"] for c in calls if "outputTokens" in c]
        if in_tok:
            out["inputTokens"] = sum(in_tok)
        if out_tok:
            out["outputTokens"] = sum(out_tok)
        return out

    def apply_durations(self, steps):
        """把工具耗时按 tool_call_id 写回 toolSteps（step['id'] 由 agent._collect_tool_steps 填充）。"""
        with self._lock:
            durations = dict(self.tool_durations)
        for s in steps or []:
            d = durations.get(s.get("id"))
            if d is not None:
                s["durationMs"] = d
        return steps
