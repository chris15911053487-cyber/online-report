"""FastAPI 入口：被主后端网关内网调用（不对公网开放）。"""
import asyncio
import json
import logging
import threading

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .agent import run_turn
from .auth import verify_scoped_token
from .recorder import TurnCancelled, TurnRecorder

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ai-agent")

app = FastAPI(title="online-report ai-agent", docs_url=None, redoc_url=None)


class ChatInput(BaseModel):
    type: str = "message"           # "message" | "resume"
    content: str | None = None      # message 时
    field: str | None = None        # resume 时
    value: object | None = None     # resume 时


class ChatRequest(BaseModel):
    threadId: str
    input: ChatInput
    messages: list[dict] = []
    skills: list[dict] = []
    user: dict = {}
    agentPrompt: str = ""   # Agent 专属附加 system prompt（来自 dbo.agents.system_prompt_extra）
    context: dict | None = None  # 看板点击上下文（网关已规范化），注入本轮用户消息
    mode: str | None = None      # "fast" = 用快模型（点击解读）


@app.get("/health")
async def health():
    return {"ok": True, "service": "ai-agent"}


def _authorize(req: ChatRequest, x_scoped_token: str | None) -> None:
    """校验 scoped token，并确认它属于本次 threadId；失败抛 HTTPException。"""
    if not x_scoped_token:
        raise HTTPException(status_code=401, detail="missing scoped token")
    try:
        payload = verify_scoped_token(x_scoped_token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"invalid scoped token: {exc}") from exc

    # thread 归属校验：scoped token 里的会话 id 必须与本次 threadId 一致
    if payload.get("cid") and payload.get("cid") != req.threadId:
        raise HTTPException(status_code=403, detail="thread/token mismatch")


def _sse(event: dict) -> bytes:
    return ("data: " + json.dumps(event, ensure_ascii=False, default=str) + "\n\n").encode("utf-8")


# 流式接口在没有事件时的心跳间隔（秒）：长耗时工具/LLM 期间保持连接，避免反向代理空闲超时
_SSE_KEEPALIVE_SECS = 15


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request, x_scoped_token: str | None = Header(default=None)):
    """SSE 流式对话。事件：llm_start / delta / llm_end / tool_call / tool_result / final / cancelled / error。

    final 的 data 与 /chat 的返回体一致，调用方据此落库并渲染最终结果。
    """
    _authorize(req, x_scoped_token)

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    cancel = threading.Event()
    done = object()

    def emit(event: dict) -> None:
        # 回调在工作线程里触发，需切回事件循环再入队
        loop.call_soon_threadsafe(queue.put_nowait, event)

    recorder = TurnRecorder(emit=emit, cancel_event=cancel)

    def work() -> None:
        try:
            result = run_turn(
                thread_id=req.threadId,
                scoped_token=x_scoped_token,
                input_obj=req.input.model_dump(),
                history=req.messages,
                skills=req.skills,
                user=req.user,
                agent_prompt=req.agentPrompt or "",
                recorder=recorder,
                context=req.context,
                mode=req.mode,
            )
            emit({"type": "final", "data": result})
        except TurnCancelled:
            emit({"type": "cancelled"})
        except Exception as exc:  # noqa: BLE001
            log.exception("chat stream failed")
            emit({"type": "error", "message": f"agent error: {exc}", "detail": str(exc)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    worker = loop.run_in_executor(None, work)

    async def gen():
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=_SSE_KEEPALIVE_SECS)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                if item is done:
                    break
                yield _sse(item)
        finally:
            # 客户端断开（生成器被取消/关闭）或正常结束：通知工作线程在下一次 LLM 调用前停止
            cancel.set()
            if not worker.done():
                log.info("stream closed early, cancelling agent turn for thread=%s", req.threadId)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat")
async def chat(req: ChatRequest, request: Request, x_scoped_token: str | None = Header(default=None)):
    _authorize(req, x_scoped_token)

    try:
        task = asyncio.ensure_future(
            run_in_threadpool(
                run_turn,
                thread_id=req.threadId,
                scoped_token=x_scoped_token,
                input_obj=req.input.model_dump(),
                history=req.messages,
                skills=req.skills,
                user=req.user,
                agent_prompt=req.agentPrompt or "",
                context=req.context,
                mode=req.mode,
            )
        )
        # 等待任务完成或客户端断开
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                log.info("client disconnected, cancelled agent task for thread=%s", req.threadId)
                return {"status": "cancelled", "message": ""}
            await asyncio.sleep(0.3)
        return task.result()
    except asyncio.CancelledError:
        return {"status": "cancelled", "message": ""}
    except Exception as exc:  # noqa: BLE001
        log.exception("chat failed")
        raise HTTPException(status_code=500, detail=f"agent error: {exc}") from exc
