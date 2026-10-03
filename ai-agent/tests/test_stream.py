"""流式回合 / 耗时记录 / 取消 的集成测试：真实 LangGraph + 脚本化的假模型。

需要真实依赖（pip install -r requirements.txt）；未安装时整体跳过。
运行：cd ai-agent && python3 -m unittest discover -s tests -v
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
    from langchain_core.outputs import ChatGenerationChunk
    from langchain_core.tools import tool
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.prebuilt import create_react_agent
    from fastapi.testclient import TestClient

    HAVE_DEPS = True
except ImportError:  # pragma: no cover
    HAVE_DEPS = False

if HAVE_DEPS:
    from app import agent, main, tools as app_tools
    from app.config import settings
    from app.recorder import TurnCancelled, TurnRecorder


if HAVE_DEPS:

    class ScriptedModel(BaseChatModel):
        """按脚本依次返回 AIMessage；逐字符触发 on_llm_new_token（模拟 ChatOpenAI(streaming=True)）。"""

        script: list
        pos: int = 0

        @property
        def _llm_type(self):
            return "scripted"

        def bind_tools(self, tools, **kwargs):
            return self

        def _stream(self, messages, stop=None, run_manager=None, **kwargs):
            m = self.script[self.pos]
            self.pos += 1
            for ch in m.content or "":
                chunk = ChatGenerationChunk(message=AIMessageChunk(content=ch))
                if run_manager:
                    run_manager.on_llm_new_token(ch, chunk=chunk)
                yield chunk
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {"name": c["name"], "args": json.dumps(c["args"]), "id": c["id"], "index": i}
                        for i, c in enumerate(m.tool_calls)
                    ],
                )
            )

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            from langchain_core.language_models.chat_models import generate_from_stream

            return generate_from_stream(self._stream(messages, stop, run_manager, **kwargs))

    SLEEP = 0.3

    @tool
    def slow(x: str) -> str:
        """slow tool"""
        time.sleep(SLEEP)
        return "ok-" + x

    def call(name, cid, **args):
        return {"name": name, "args": args, "id": cid}

    def make_token(cid):
        payload = {"sub": "U1", "name": "u", "roles": ["operator"], "cid": cid,
                   "exp": int(time.time()) + 300, "scope": "ai-agent"}
        b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        sig = base64.urlsafe_b64encode(
            hmac.new(settings.SCOPED_SECRET.encode(), b64.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        return f"{b64}.{sig}"

    def install_graph(script, extra_tools=()):
        model = ScriptedModel(script=script)
        agent._graph = create_react_agent(model, [slow, *extra_tools], checkpointer=MemorySaver())
        return model

    def run(thread, text, recorder=None):
        return agent.run_turn(
            thread_id=thread,
            scoped_token=make_token(thread),
            input_obj={"type": "message", "content": text},
            history=[],
            skills=[],
            user={},
            recorder=recorder,
        )


@unittest.skipUnless(HAVE_DEPS, "需要安装 ai-agent/requirements.txt 的依赖")
class RecorderTests(unittest.TestCase):
    def tearDown(self):
        agent._graph = None

    def test_tool_steps_carry_id_and_duration(self):
        install_graph([
            AIMessage(content="", tool_calls=[call("slow", "c1", x="a")]),
            AIMessage(content="完成"),
        ])
        r = run("t-dur", "hi")
        self.assertEqual(r["status"], "final")
        step = r["toolSteps"][0]
        self.assertEqual(step["id"], "c1")
        self.assertGreaterEqual(step["durationMs"], int(SLEEP * 1000) - 20)
        t = r["timings"]
        self.assertEqual(t["llmCalls"], 2)
        self.assertGreaterEqual(t["totalMs"], t["llmMs"])
        self.assertGreaterEqual(t["otherMs"], int(SLEEP * 1000) - 50)

    def test_parallel_tool_calls_run_concurrently(self):
        install_graph([
            AIMessage(content="", tool_calls=[call("slow", "c1", x="a"), call("slow", "c2", x="b")]),
            AIMessage(content="完成"),
        ])
        t0 = time.perf_counter()
        r = run("t-par", "hi")
        elapsed = time.perf_counter() - t0
        self.assertEqual([s["id"] for s in r["toolSteps"]], ["c1", "c2"])
        self.assertTrue(all(s["durationMs"] >= 250 for s in r["toolSteps"]))
        self.assertLess(elapsed, SLEEP * 1.8, f"两个工具应并行执行，实际耗时 {elapsed:.2f}s")

    def test_events_order_and_tokens(self):
        install_graph([
            AIMessage(content="", tool_calls=[call("slow", "c1", x="a")]),
            AIMessage(content="好的"),
        ])
        events = []
        run("t-ev", "hi", recorder=TurnRecorder(emit=events.append))
        kinds = [e["type"] for e in events]
        self.assertEqual(kinds[0], "llm_start")
        self.assertEqual(kinds.count("llm_start"), 2)
        self.assertEqual(kinds.count("llm_end"), 2)
        i_call, i_res = kinds.index("tool_call"), kinds.index("tool_result")
        self.assertLess(i_call, i_res)
        self.assertEqual(events[i_call]["id"], events[i_res]["id"])  # 同一 run id，前端据此更新同一步
        self.assertEqual(events[i_call]["tool"], "slow")
        self.assertEqual(events[i_res]["toolCallId"], "c1")
        self.assertTrue(events[i_res]["ok"])
        self.assertGreaterEqual(events[i_res]["durationMs"], 250)
        deltas = "".join(e["text"] for e in events if e["type"] == "delta")
        self.assertEqual(deltas, "好的")
        first_end = next(e for e in events if e["type"] == "llm_end")
        self.assertEqual(first_end["toolCalls"], 1)

    def test_interrupt_reports_waiting_not_failure(self):
        install_graph(
            [AIMessage(content="", tool_calls=[call(
                "ask_user_to_choose", "c9", field="f", question="选哪个？", options_json="[]")])],
            extra_tools=[app_tools.ask_user_to_choose],
        )
        events = []
        r = run("t-int", "hi", recorder=TurnRecorder(emit=events.append))
        self.assertEqual(r["status"], "need_clarification")
        res = [e for e in events if e["type"] == "tool_result"]
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])
        self.assertTrue(res[0]["waiting"])

    def test_interrupt_then_resume_completes(self):
        """固定在 requirements 的 langgraph 0.2.x 下，invoke 结果不含 __interrupt__，需从 checkpoint 状态取。"""
        install_graph(
            [
                AIMessage(content="", tool_calls=[call(
                    "ask_user_to_choose", "c9", field="customer", question="哪个客户？",
                    options_json='[{"value":"C1","label":"甲"}]')]),
                AIMessage(content="已选择 C1"),
            ],
            extra_tools=[app_tools.ask_user_to_choose],
        )
        r1 = run("t-resume", "查客户")
        self.assertEqual(r1["status"], "need_clarification")
        self.assertEqual(r1["clarification"]["field"], "customer")
        self.assertEqual(r1["clarification"]["options"][0]["value"], "C1")
        r2 = agent.run_turn(
            thread_id="t-resume", scoped_token=make_token("t-resume"),
            input_obj={"type": "resume", "value": "C1"}, history=[], skills=[], user={},
        )
        self.assertEqual(r2["status"], "final")
        self.assertEqual(r2["message"], "已选择 C1")

    def test_cancel_stops_before_next_llm_and_keeps_history_valid(self):
        model = install_graph([
            AIMessage(content="", tool_calls=[call("slow", "c1", x="a")]),
            AIMessage(content="不该被生成"),
        ])
        cancel = threading.Event()
        events = []

        def emit(e):
            events.append(e)
            if e["type"] == "tool_call":
                cancel.set()  # 工具开始后客户端断开：工具应执行完，但不再发起下一次 LLM

        with self.assertRaises(TurnCancelled):
            run("t-cancel", "hi", recorder=TurnRecorder(emit=emit, cancel_event=cancel))
        self.assertEqual(model.pos, 1, "取消后不应再调用模型")
        self.assertIn("tool_result", [e["type"] for e in events], "已开始的工具应执行完毕")

        # 同一会话继续提问：历史里 tool_calls 都有对应 ToolMessage，不应报 INVALID_CHAT_HISTORY
        state = agent._graph.get_state({"configurable": {"thread_id": "t-cancel"}})
        self.assertIsInstance(state.values["messages"][-1], ToolMessage)
        model.script = [AIMessage(content="第二问的回答")]
        model.pos = 0
        r = run("t-cancel", "再问一个")
        self.assertEqual(r["message"], "第二问的回答")


@unittest.skipUnless(HAVE_DEPS, "需要安装 ai-agent/requirements.txt 的依赖")
class StreamEndpointTests(unittest.TestCase):
    def tearDown(self):
        agent._graph = None

    def _post(self, client, thread, text):
        body = {"threadId": thread, "input": {"type": "message", "content": text},
                "messages": [], "skills": [], "user": {}}
        events = []
        with client.stream("POST", "/chat/stream", json=body,
                           headers={"X-Scoped-Token": make_token(thread)}) as resp:
            self.assertEqual(resp.status_code, 200)
            self.assertTrue(resp.headers["content-type"].startswith("text/event-stream"))
            self.assertEqual(resp.headers.get("x-accel-buffering"), "no")
            for line in resp.iter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        return events

    def test_stream_endpoint_emits_steps_then_final(self):
        install_graph([
            AIMessage(content="", tool_calls=[call("slow", "c1", x="a")]),
            AIMessage(content='结果如下\n```suggested_actions\n[{"type":"followup","label":"再查"}]\n```'),
        ])
        client = TestClient(main.app)
        events = self._post(client, "t-sse", "查一下")
        kinds = [e["type"] for e in events]
        self.assertIn("tool_call", kinds)
        self.assertIn("tool_result", kinds)
        self.assertEqual(kinds[-1], "final")
        final = events[-1]["data"]
        self.assertEqual(final["status"], "final")
        self.assertEqual(final["message"], "结果如下")  # suggested_actions 块已剥离
        self.assertEqual(final["actions"][0]["label"], "再查")
        self.assertIn("durationMs", final["toolSteps"][0])
        self.assertIn("timings", final)
        # 流式 token 里仍带着原始 suggested_actions 文本——前端负责在展示时过滤
        streamed = "".join(e["text"] for e in events if e["type"] == "delta")
        self.assertIn("suggested_actions", streamed)

    def test_rejects_bad_token_and_thread_mismatch(self):
        install_graph([AIMessage(content="x")])
        client = TestClient(main.app)
        body = {"threadId": "a", "input": {"type": "message", "content": "x"}}
        self.assertEqual(client.post("/chat/stream", json=body).status_code, 401)
        self.assertEqual(
            client.post("/chat/stream", json=body, headers={"X-Scoped-Token": "bad.token"}).status_code, 401)
        self.assertEqual(
            client.post("/chat/stream", json=body, headers={"X-Scoped-Token": make_token("other")}).status_code, 403)

    def test_error_is_reported_as_event(self):
        orig = agent.get_graph

        def boom():
            raise RuntimeError("模型不可用")

        agent.get_graph = boom
        try:
            client = TestClient(main.app)
            events = self._post(client, "t-err", "x")
        finally:
            agent.get_graph = orig
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("模型不可用", events[-1]["message"])


if __name__ == "__main__":
    unittest.main()
