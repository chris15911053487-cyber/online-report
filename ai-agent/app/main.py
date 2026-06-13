"""FastAPI 入口：被主后端网关内网调用（不对公网开放）。"""
import asyncio
import logging

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .agent import run_turn
from .auth import verify_scoped_token

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


@app.get("/health")
async def health():
    return {"ok": True, "service": "ai-agent"}


@app.post("/chat")
async def chat(req: ChatRequest, request: Request, x_scoped_token: str | None = Header(default=None)):
    if not x_scoped_token:
        raise HTTPException(status_code=401, detail="missing scoped token")
    try:
        payload = verify_scoped_token(x_scoped_token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"invalid scoped token: {exc}") from exc

    # thread 归属校验：scoped token 里的会话 id 必须与本次 threadId 一致
    if payload.get("cid") and payload.get("cid") != req.threadId:
        raise HTTPException(status_code=403, detail="thread/token mismatch")

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
