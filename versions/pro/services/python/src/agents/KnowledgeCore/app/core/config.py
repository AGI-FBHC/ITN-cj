from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings

# Load .env from agents/ directory (shared by KnowledgeCore and predeal)
_agents_dir = Path(__file__).resolve().parent.parent.parent.parent
load_dotenv(_agents_dir / ".env")

# T5.1：已知的占位/默认密钥字符串——生产环境（ENV=prod）下检测到即拒启，
# 防止把开发期临时值原样带上线。全部小写比较（大小写不敏感）。
_KNOWN_DEFAULT_INTERNAL_SECRETS = {
    "changeme", "change_me", "change-me", "please-change-this-secret",
    "replace-with-a-random-secret-at-least-32-bytes",
    "kc-internal-secret", "qb-internal-secret", "agent-internal-secret",
    "secret", "your-secret-key", "dev-secret", "test-secret", "internal-secret",
}


class Settings(BaseSettings):
    PROJECT_NAME: str = "ITN Knowledge Core"
    API_V1_PREFIX: str = "/api/v1"

    # 运行环境标识（dev/test/prod）；仅 prod 下触发占位密钥拒启检查
    ENV: str = "dev"

    # T5.1：内部服务鉴权共享密钥（与调用方 agents/QuestionBank 的 KC_INTERNAL_SECRET 一致）。
    # 过渡期：未配置时跳过签名校验并打 WARNING；一旦配置则所有业务路由强制校验签名。
    KC_INTERNAL_SECRET: str | None = None
    INTERNAL_AUTH_MAX_SKEW_SECONDS: int = Field(default=60, ge=10, le=300)

    MYSQL_HOST: str = ""
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = ""
    MYSQL_PASSWORD: str = ""
    MYSQL_DB: str = Field(default="", alias="MYSQL_DATABASE")

    RAGFLOW_BASE_URL: str = Field(default="", alias="RAGFLOW_URL")
    RAGFLOW_API_KEY: str = ""

    LLM_API_URL: str = ""
    LLM_API_KEY: str = ""
    LLM_MODEL: str = "deepseek-chat"

    # 写接口总开关：false 时人工纠错（classifications/correct）一律 403（生产库只读优先）
    KNOWLEDGE_ALLOW_WRITE: bool = False

    # LLM 证据相关性复核开关：检索后对证据逐条判定能否支撑查询，剔除不相关项
    # （只读、失败自动降级不过滤；生产开启建议同时确认 LLM_API_URL/LLM_API_KEY/LLM_MODEL）
    KNOWLEDGE_LLM_JUDGE: bool = False

    # T3.3 重排层开关。开启后 retrieve_chunks 把三级来源合并候选统一过
    # reranker.rerank() 再截断 top_k；未配置 RERANKER_API_URL 时自动 no-op。
    # 2026-08-18 按手册"评估验证后改默认"转为默认 on：接入硅基流动
    # bge-reranker-v2-m3 后 18 条 golden 基线 hit@3 0.667→1.000、hit@8 0.889→1.000
    # （evals/baseline-20260818-rerank.json）。
    KNOWLEDGE_RERANK: bool = True
    # 外部 reranker 服务端点；未配置时 rerank() 原样返回（no-op），即使开关已打开。
    # 云 API（如硅基流动 https://api.siliconflow.cn/v1/rerank）需同时配 KEY 与 MODEL；
    # 简易自建端点（body: query/documents/top_k，响应: results[].score）两项留空即可。
    RERANKER_API_URL: str = ""
    RERANKER_API_KEY: str = ""
    # 配置后请求体按 OpenAI 风格 rerank 契约发送（model + top_n），如 BAAI/bge-reranker-v2-m3
    RERANKER_MODEL: str = ""

    # T4.5 GraphRAG 一跳：默认 off。开启后 decision_service.resolve() 会查目标知识点
    # 的直接（1 跳）先修节点填 FactSnapshot.prerequisite_chain，并各取 1~2 条证据块
    # （evidence_role='prerequisite'，总数 ≤3，不计入 coverage 分子）。
    KNOWLEDGE_GRAPH_RAG: bool = False

    DEBUG: bool = False

    model_config = {
        "env_file": str(_agents_dir / ".env"),
        "env_file_encoding": "utf-8",
        "populate_by_name": True,
        # agents/.env 含 predeal 使用的其他键（FILE_*/IMAGE_*/VLM_* 等），
        # pydantic-settings 2.6+ 对多余键默认报错，这里显式忽略
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def _reject_known_default_secret_in_prod(self) -> "Settings":
        """T5.1 启动检查：ENV=prod 且密钥命中已知占位字符串 → 拒启。"""
        if (
            self.ENV.strip().lower() in {"prod", "production"}
            and self.KC_INTERNAL_SECRET
            and self.KC_INTERNAL_SECRET.strip().lower() in _KNOWN_DEFAULT_INTERNAL_SECRETS
        ):
            raise RuntimeError(
                "KC_INTERNAL_SECRET 使用了已知的占位/默认密钥，生产环境（ENV=prod）拒绝启动，"
                "请配置真实的内部服务共享密钥。"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
