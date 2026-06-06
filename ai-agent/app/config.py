"""Runtime configuration for the AI agent service (env-driven)."""
import os


def _trim(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return str(v).strip() if v is not None else default


class Settings:
    # 主后端回调地址（容器内网，例如 http://app:3000）
    BACKEND_URL = _trim("AI_BACKEND_URL", "http://app:3000").rstrip("/")

    # 与主后端共享的 scoped token 密钥（必须一致）
    SCOPED_SECRET = _trim("AI_SCOPED_SECRET") or _trim("JWT_SECRET") or "change-me-ai-scoped-secret"

    # LLM provider（openai / deepseek / grok）— 复用主项目 ai.js 的约定
    PROVIDER = (_trim("AI_PROVIDER", "openai")).lower()
    DEFAULT_MODEL = _trim("AI_DEFAULT_MODEL", "gpt-4o-mini")
    TEMPERATURE = float(_trim("AI_TEMPERATURE", "0.1") or 0.1)
    MAX_TOKENS = int(_trim("AI_MAX_TOKENS", "2048") or 2048)
    TIMEOUT_MS = int(_trim("AI_TIMEOUT_MS", "45000") or 45000)

    OPENAI_API_KEY = _trim("OPENAI_API_KEY")
    DEEPSEEK_API_KEY = _trim("DEEPSEEK_API_KEY")
    GROK_API_KEY = _trim("GROK_API_KEY")
    DEEPSEEK_BASE_URL = _trim("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

    # LangGraph checkpoint（中断/恢复）持久化路径
    CHECKPOINT_DB = _trim("AI_CHECKPOINT_DB", "/data/checkpoints.sqlite")

    PORT = int(_trim("PORT", "8080") or 8080)

    @classmethod
    def resolve_api_key(cls) -> str:
        if cls.PROVIDER == "deepseek":
            return cls.DEEPSEEK_API_KEY or cls.OPENAI_API_KEY
        if cls.PROVIDER == "grok":
            return cls.GROK_API_KEY or cls.OPENAI_API_KEY
        return cls.OPENAI_API_KEY

    @classmethod
    def resolve_base_url(cls):
        if cls.PROVIDER == "deepseek":
            return cls.DEEPSEEK_BASE_URL
        if cls.PROVIDER == "grok":
            return "https://api.x.ai/v1"
        return None  # OpenAI 默认


settings = Settings()
