"""RuleCore 配置（pydantic-settings，读 .env）."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class RuleCoreSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # MySQL（与 src/agents 同库 itn-platform）
    MYSQL_HOST: str = "127.0.0.1"
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = "root"
    MYSQL_PASSWORD: str = ""
    MYSQL_DATABASE: str = "itn-platform"

    # LLM（OpenAI 兼容）
    LLM_API_URL: str = ""
    LLM_API_KEY: str = ""
    LLM_MODEL: str = "deepseek-chat"
    LLM_TIMEOUT: int = 300
    # MiMo v2.6 是推理模型，max_tokens = 推理 + 正文总预算。
    # 实测 API 接受 16384（旧 4096 硬上限会导致长规则页正文被截断 → JSON 不闭合 → 解析失败 → 0 规则）。
    LLM_MAX_TOKENS: int = 16384
    LLM_TEMPERATURE: float = 0.2
    LLM_RETRIES: int = 3

    # Rule Engine 关键配置（§21，必须通过配置控制）
    RULE_EXTRACT_CONFIDENCE_THRESHOLD: float = 0.80
    MAX_REASONING_ROUNDS: int = 2
    MAX_REVISION_RETRY: int = 1
    RULE_ENGINE_ENABLED: bool = True
    DEBUG: bool = False
    AGENT_INTERNAL_SECRET: str = ""
    INTERNAL_AUTH_MAX_SKEW_SECONDS: int = 60

    # 对照生成（演示用轻量生成器）
    GENERATE_MAX_TOKENS: int = 4096

    @property
    def mysql_dsn(self) -> dict:
        return {
            "host": self.MYSQL_HOST,
            "port": self.MYSQL_PORT,
            "user": self.MYSQL_USER,
            "password": self.MYSQL_PASSWORD,
            "database": self.MYSQL_DATABASE,
            "charset": "utf8mb4",
            "autocommit": False,
        }


settings = RuleCoreSettings()
