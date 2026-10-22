from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

class PresentationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    requirement: str = Field(min_length=10, max_length=5000)
    title: str | None = Field(default=None, max_length=120)
    audience: Literal["students", "teachers", "professionals", "general"] = "students"
    purpose: Literal["courseware", "report", "sharing", "defense", "training"] = "courseware"
    style: Literal[
        "academic", "business", "technology", "minimal", "vibrant",
        "education", "forest", "ocean", "terracotta", "editorial", "luxury", "dark",
    ] = "academic"
    background_style: Literal[
        "none", "colorful-ink", "sunset-mountains", "abstract-gradient",
        "clean-minimal", "cartoon-doodle", "blue-white-minimal",
        "blue-conference", "morandi-blue-gray", "business-gray", "watercolor",
    ] = Field(default="none", alias="backgroundStyle")
    language: Literal["zh-CN", "en-US"] = "zh-CN"
    slide_count: int = Field(default=0, alias="slideCount", ge=0, le=70)
    aspect_ratio: Literal["16:9", "4:3"] = Field(default="16:9", alias="aspectRatio")
    detail_level: Literal["concise", "balanced", "detailed"] = Field(default="balanced", alias="detailLevel")
    include_speaker_notes: bool = Field(default=True, alias="includeSpeakerNotes")
    model_provider: Literal["mimo", "kimi"] = Field(default="mimo", alias="modelProvider")
    generation_mode: Literal["template", "web"] = Field(default="template", alias="generationMode")
    custom_style: str | None = Field(default=None, max_length=2000, alias="customStyle")
    learning_goal_id: UUID | None = Field(default=None, alias="learningGoalId")
    generation_context: dict | None = Field(default=None, alias="generationContext")

    @field_validator("slide_count")
    @classmethod
    def validate_slide_count(cls, value: int) -> int:
        if 0 < value < 5:
            raise ValueError("slideCount must be 0 (auto) or at least 5")
        return value


class PresentationTask(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID
    status: Literal["queued", "analyzing", "outline_review", "generating", "reviewing", "completed", "failed", "cancelled"]
    progress: int
    stage_message: str = Field(alias="stageMessage")
    title: str
    request: dict
    outline: dict | None = None
    events: list[dict] = Field(default_factory=list)
    error_message: str | None = Field(default=None, alias="errorMessage")
    download_url: str | None = Field(default=None, alias="downloadUrl")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
