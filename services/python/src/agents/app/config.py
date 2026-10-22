from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "ITN Agent Service"
    app_version: str = "1.0.0"
    debug: bool = False
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_allowed_origins: str = "http://localhost:5173"

    agent_internal_secret: str = Field(min_length=32)
    jwt_secret: str | None = None
    platform_db_url: str | None = None
    knowledge_core_url: str = "http://itn-knowledgecore:8010"
    kc_internal_secret: str | None = Field(default=None, alias="KC_INTERNAL_SECRET")
    # Gray release: opt in per deployment. compose.yml enables it for the integrated stack.
    knowledge_resolve_enabled: bool = False
    knowledge_resolve_timeout_seconds: int = Field(default=15, ge=2, le=60)
    rule_core_url: str = "http://itn-rulecore:8201"
    rule_core_enabled: bool = False
    rule_core_mode: str = "observe"
    rule_core_timeout_seconds: int = Field(default=30, ge=2, le=90)
    internal_auth_max_skew_seconds: int = Field(default=60, ge=10, le=300)
    agent_database_path: Path = Path("data/agents.db")
    presentation_output_dir: Path = Path("data/presentations")
    presentation_visual_review_enabled: bool = False
    presentation_visual_review_model: str = "deepseek-chat"
    presentation_visual_review_max_slides: int = Field(default=6, ge=1, le=12)
    presentation_visual_review_timeout_seconds: int = Field(default=75, ge=20, le=180)
    presentation_content_min_concurrency: int = Field(default=4, ge=1, le=16)
    presentation_content_initial_concurrency: int = Field(default=6, ge=1, le=16)
    presentation_content_max_concurrency: int = Field(default=8, ge=1, le=16)
    presentation_content_retry_budget: int = Field(default=2, ge=1, le=4)
    # 全局 AI 教研/资源生成并发任务数（此前本地单槽模型固定为 1）
    generation_concurrency: int = Field(default=8, ge=1, le=32)
    presentation_content_batch_size: int = Field(default=2, ge=1, le=3)
    presentation_content_timeout_seconds: int = Field(default=90, ge=30, le=300)
    presentation_agenda_max_tokens: int = Field(default=3072, ge=1024, le=4096)
    presentation_agenda_timeout_seconds: int = Field(default=90, ge=30, le=150)

    llm_provider: str = "mock"
    llm_api_key: str | None = None
    llm_api_base: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    llm_reasoning_effort: str = "none"
    llm_context_window: int = Field(default=131072, ge=8192, le=1048576)
    llm_timeout_seconds: int = Field(default=60, ge=5, le=300)
    llm_max_tokens: int = Field(default=8192, ge=256, le=32768)
    llm_temperature: float = Field(default=0.1, ge=0, le=2)

    tavily_api_key: str | None = None
    url_fetch_timeout_seconds: int = Field(default=20, ge=5, le=60)
    url_fetch_max_length: int = Field(default=12000, ge=2000, le=50000)
    chat_tool_max_iterations: int = Field(default=4, ge=1, le=10)

    # 兼容旧 MiMo 变量名（当前统一指向 DeepSeek）
    # 首选环境变量名：MIMO_API_KEY / MIMO_API_BASE / MIMO_MODEL；
    # 兼容旧名 OPENCODE_GO_*（历史 .env 与部署脚本继续可用）。
    mimo_api_key: str | None = Field(default=None, validation_alias=AliasChoices("MIMO_API_KEY", "OPENCODE_GO_API_KEY"))
    mimo_api_base: str = Field(default="https://api.deepseek.com/v1", validation_alias=AliasChoices("MIMO_API_BASE", "OPENCODE_GO_API_BASE"))
    # 留空时复用当前 MiMo 服务地址；独立语音 Key 可覆盖为 https://api.xiaomimimo.com/v1
    mimo_tts_api_key: str | None = None
    mimo_tts_api_base: str | None = None
    mimo_asr_api_base: str | None = None
    mimo_asr_api_key: str | None = None
    mimo_multimodal_api_base: str | None = None
    mimo_model: str = Field(default="deepseek-chat", validation_alias=AliasChoices("MIMO_MODEL", "OPENCODE_GO_MODEL"))
    # MiMo 文本/视觉通道：统一复用 MIMO_API_KEY（兼容 OPENCODE_GO_API_KEY）；
    # 仅保留 base/model 覆盖能力；key 不在此处单独配置。
    mimo_text_api_base: str | None = None
    mimo_text_model: str | None = None
    # 视觉（图片理解）通道：留空时依次回退到多模态/文本/主 MiMo 配置
    mimo_vision_api_base: str | None = None
    mimo_vision_model: str | None = None

    # PPT 语音模型对比通道（仅服务端读取；密钥不得下发前端）
    qwen_audio_api_key: str | None = None
    qwen_audio_api_base: str = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    qwen_audio_model: str = "qwen-audio-3.0-realtime-plus"
    qwen_tts_api_key: str | None = None
    qwen_tts_api_base: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    qwen_tts_model: str = "qwen-audio-3.0-tts-flash"

    # Qwen 文本/视觉模型（tokenplan compatible-mode；key 留空时复用 qwen_audio_api_key）
    qwen_chat_api_key: str | None = None
    qwen_chat_api_base: str = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    qwen_chat_model: str = "qwen3.8-max"

    # RAGFlow 知识库检索
    ragflow_base_url: str = "http://127.0.0.1:9380"
    ragflow_api_key: str | None = None
    ragflow_dataset_id: str = "eb337a1e90a611f1876b4b731f5af1b1"
    ragflow_top_k: int = Field(default=5, ge=1, le=10)

    @property
    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.cors_allowed_origins.split(",") if item.strip()]

    @field_validator("llm_provider")
    @classmethod
    def validate_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"mock", "openai-compatible"}:
            raise ValueError("LLM_PROVIDER must be mock or openai-compatible")
        return normalized

    @field_validator("llm_reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, value: str) -> str:
        normalized = value.strip().lower()
        # none：上游（如 DeepSeek）不支持 reasoning_effort，且该参数会让部分模型把预算全花在思考上
        if normalized not in {"none", "low", "high", "max"}:
            raise ValueError("LLM_REASONING_EFFORT must be none, low, high or max")
        return normalized


@lru_cache
def get_settings() -> Settings:
    return Settings()
