"""QuestionBank 配置：读取 agents/.env（与 KnowledgeCore / predeal 共用同一环境文件）。"""
from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_AGENTS_DIR = Path(__file__).resolve().parent.parent.parent.parent  # src/agents/

# T5.1：已知的占位/默认密钥字符串——生产环境（ENV=prod）下检测到即拒启，
# 防止把开发期临时值原样带上线。全部小写比较（大小写不敏感）。
_KNOWN_DEFAULT_INTERNAL_SECRETS = {
    "changeme", "change_me", "change-me", "please-change-this-secret",
    "replace-with-a-random-secret-at-least-32-bytes",
    "kc-internal-secret", "qb-internal-secret", "agent-internal-secret",
    "secret", "your-secret-key", "dev-secret", "test-secret", "internal-secret",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_AGENTS_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 运行环境标识（dev/test/prod）；仅 prod 下触发占位密钥拒启检查
    env: str = Field(default="dev", alias="ENV")

    # T5.1：内部服务鉴权——保护 QuestionBank 自身业务路由的共享密钥。
    # 过渡期：未配置时跳过签名校验并打 WARNING；一旦配置则强制校验。
    qb_internal_secret: str | None = Field(default=None, alias="QB_INTERNAL_SECRET")
    # 调用 KnowledgeCore 时用于签名的共享密钥（需与 KC 侧 KC_INTERNAL_SECRET 一致）；
    # 与 agents/.env 中 KnowledgeCore 使用的同名变量共享同一份 .env 文件。
    kc_internal_secret: str | None = Field(default=None, alias="KC_INTERNAL_SECRET")
    internal_auth_max_skew_seconds: int = Field(default=60, ge=10, le=300, alias="INTERNAL_AUTH_MAX_SKEW_SECONDS")

    # Knowledge Core 服务地址（唯一知识入口；未配置时检索类功能不可用）
    knowledge_core_url: str | None = Field(
        default=None, alias="KNOWLEDGE_CORE_URL",
        description="KnowledgeCore HTTP 地址，如 http://localhost:8000",
    )
    knowledge_core_timeout: float = Field(default=15.0, alias="KNOWLEDGE_CORE_TIMEOUT")
    knowledge_core_domain: str = Field(default="agent", alias="KNOWLEDGE_CORE_DOMAIN")

    # 平台 MySQL（题库三张核心表所在库，与知识库同库）
    mysql_host: str = Field(default="", alias="MYSQL_HOST")
    mysql_port: int = Field(default=3306, alias="MYSQL_PORT")
    mysql_user: str = Field(default="", alias="MYSQL_USER")
    mysql_password: str = Field(default="", alias="MYSQL_PASSWORD")
    mysql_database: str = Field(default="", alias="MYSQL_DATABASE")

    # LLM（出题/审题/判题）：与 agents/.env 共用同一套键。
    # 默认 openai-compatible：只要配了 LLM_API_URL 即可用；mock 仅供测试显式设置。
    llm_provider: str = Field(default="openai-compatible", alias="LLM_PROVIDER", description="mock / openai-compatible")
    llm_api_url: str = Field(default="", alias="LLM_API_URL", description="兼容 /chat/completions 或完整 URL")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_model: str = Field(default="deepseek-chat", alias="LLM_MODEL")
    llm_timeout_seconds: float = Field(default=90.0, alias="LLM_TIMEOUT_SECONDS")
    llm_max_tokens: int = Field(default=4096, alias="LLM_MAX_TOKENS", description="MiMo 推理模型限制，防止全用思考 token")

    @model_validator(mode="after")
    def _reject_known_default_secret_in_prod(self) -> "Settings":
        """T5.1 启动检查：ENV=prod 且密钥命中已知占位字符串 → 拒启。"""
        if self.env.strip().lower() not in {"prod", "production"}:
            return self
        for secret in (self.qb_internal_secret, self.kc_internal_secret):
            if secret and secret.strip().lower() in _KNOWN_DEFAULT_INTERNAL_SECRETS:
                raise RuntimeError(
                    "QB_INTERNAL_SECRET/KC_INTERNAL_SECRET 使用了已知的占位/默认密钥，"
                    "生产环境（ENV=prod）拒绝启动，请配置真实的内部服务共享密钥。"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
