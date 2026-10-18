# P3 路径覆盖表 (LOCAL vs FWD)

生成方式: `python tmp_verify/route_coverage.py`（对比 Python 路由与 Spire 本地注册）

| 口径 | 数值 |
| --- | --- |
| Python `/v1` + `/internal/v1` 路由 | 149 |
| Spire 本地注册 (不含 health) | 61 |
| 转发兜底 `v1/{*rest}` / `internal/v1/{*rest}` | 2 |
| **未覆盖 (uncovered)** | **0** |
| 归属错误 (生成生命周期被本地接管) | 0 |

## 逐条

| Method | Path | 归属 | Spire 本地模式 |
| --- | --- | --- | --- |
| GET | `/v1/agents` | FWD | — |
| GET | `/v1/teaching-group/agents` | FWD | — |
| GET | `/v1/teaching-group/runs` | FWD | — |
| GET | `/v1/teaching-group/runs/{run_id}` | FWD | — |
| POST | `/v1/teaching-group/runs/stream` | FWD | — |
| POST | `/v1/presentations` | FWD | — |
| POST | `/v1/presentations/{task_id}/restart` | FWD | — |
| POST | `/v1/presentations/{task_id}/cancel` | FWD | — |
| POST | `/v1/presentations/{task_id}/generate` | FWD | — |
| GET | `/v1/presentations` | LOCAL | `/v1/presentations` |
| GET | `/v1/presentations/{task_id}` | LOCAL | `/v1/presentations/{task_id}` |
| POST | `/v1/presentations/{task_id}/complete` | LOCAL | `/v1/presentations/{task_id}/complete` |
| GET | `/v1/presentations/{task_id}/download` | LOCAL | `/v1/presentations/{task_id}/download` |
| DELETE | `/v1/presentations/{task_id}` | LOCAL | `/v1/presentations/{task_id}` |
| POST | `/v1/presentations/batch-delete` | LOCAL | `/v1/presentations/batch-delete` |
| GET | `/v1/presentations/{task_id}/slides` | LOCAL | `/v1/presentations/{task_id}/slides` |
| GET | `/v1/presentations/{task_id}/slides/{slide_index}` | LOCAL | `/v1/presentations/{task_id}/slides/{slide_index}` |
| GET | `/v1/presentations/{task_id}/audio/{slide_index}` | FWD | — |
| POST | `/v1/presentations/{task_id}/chat/sessions` | FWD | — |
| GET | `/v1/presentations/{task_id}/chat/sessions` | FWD | — |
| GET | `/v1/presentations/{task_id}/chat/sessions/{session_id}/messages` | FWD | — |
| DELETE | `/v1/presentations/{task_id}/chat/sessions/{session_id}` | FWD | — |
| POST | `/v1/presentations/{task_id}/chat/stream` | FWD | — |
| POST | `/v1/presentations/{task_id}/progress` | LOCAL | `/v1/presentations/{task_id}/progress` |
| POST | `/v1/presentations/{task_id}/chat/tts` | FWD | — |
| POST | `/v1/assistant/tts` | FWD | — |
| POST | `/v1/presentations/{task_id}/chat/audio-stream` | FWD | — |
| POST | `/v1/presentations/{task_id}/chat/image-stream` | FWD | — |
| POST | `/v1/assistant/asr` | FWD | — |
| POST | `/v1/assistant/audio-plan` | FWD | — |
| POST | `/v1/assistant/audio-stream` | FWD | — |
| GET | `/v1/notes` | LOCAL | `/v1/notes` |
| GET | `/v1/note-categories` | LOCAL | `/v1/note-categories` |
| POST | `/v1/note-categories` | LOCAL | `/v1/note-categories` |
| PATCH | `/v1/note-categories/{category_id}` | LOCAL | `/v1/note-categories/{category_id}` |
| DELETE | `/v1/note-categories/{category_id}` | LOCAL | `/v1/note-categories/{category_id}` |
| POST | `/v1/assistant/plan` | FWD | — |
| POST | `/v1/assistant/plan-stream` | FWD | — |
| POST | `/v1/notes` | LOCAL | `/v1/notes` |
| PATCH | `/v1/notes/{note_id}` | LOCAL | `/v1/notes/{note_id}` |
| DELETE | `/v1/notes/{note_id}` | LOCAL | `/v1/notes/{note_id}` |
| GET | `/v1/knowledge-categories/match` | LOCAL | `/v1/knowledge-categories/match` |
| GET | `/v1/wrong-answers` | LOCAL | `/v1/wrong-answers` |
| PATCH | `/v1/wrong-answers/{wrong_id}` | LOCAL | `/v1/wrong-answers/{wrong_id}` |
| POST | `/v1/wrong-answers/{wrong_id}/review` | LOCAL | `/v1/wrong-answers/{wrong_id}/review` |
| DELETE | `/v1/wrong-answers/{wrong_id}` | LOCAL | `/v1/wrong-answers/{wrong_id}` |
| POST | `/v1/wrong-answers/add` | LOCAL | `/v1/wrong-answers/add` |
| GET | `/v1/agent-sessions` | LOCAL | `/v1/agent-sessions` |
| POST | `/v1/agent-sessions` | LOCAL | `/v1/agent-sessions` |
| PATCH | `/v1/agent-sessions/{session_id}` | LOCAL | `/v1/agent-sessions/{session_id}` |
| GET | `/v1/agent-sessions/{session_id}` | LOCAL | `/v1/agent-sessions/{session_id}` |
| POST | `/v1/agent-sessions/{session_id}/complete` | LOCAL | `/v1/agent-sessions/{session_id}/complete` |
| GET | `/v1/agent-sessions/{session_id}/messages` | LOCAL | `/v1/agent-sessions/{session_id}/messages` |
| POST | `/v1/agent-sessions/{session_id}/messages` | LOCAL | `/v1/agent-sessions/{session_id}/messages` |
| GET | `/v1/agent-sessions/{session_id}/decisions` | LOCAL | `/v1/agent-sessions/{session_id}/decisions` |
| POST | `/v1/agent-sessions/{session_id}/decisions` | LOCAL | `/v1/agent-sessions/{session_id}/decisions` |
| POST | `/v1/agent/ask/stream` | FWD | — |
| POST | `/v1/agent/ask/image-stream` | FWD | — |
| POST | `/v1/agent/ask/suggestions` | FWD | — |
| POST | `/v1/agent/ask/weekly-plan` | FWD | — |
| POST | `/v1/agent/ask/similar-quiz` | FWD | — |
| POST | `/v1/agent/ask` | FWD | — |
| DELETE | `/v1/agent-sessions/{session_id}` | LOCAL | `/v1/agent-sessions/{session_id}` |
| POST | `/v1/agent/infer` | FWD | — |
| GET | `/v1/tutoring/scripts/{learner_code}` | LOCAL | `/v1/tutoring/scripts/{learner_code}` |
| GET | `/v1/learning-units/{kp_id}/topics/{topic_id}` | FWD | — |
| POST | `/v1/learning-units/prewarm` | FWD | — |
| POST | `/v1/tutoring/sessions` | LOCAL | `/v1/tutoring/sessions` |
| GET | `/v1/tutoring/sessions/{session_id}` | LOCAL | `/v1/tutoring/sessions/{session_id}` |
| POST | `/v1/tutoring/sessions/{session_id}/answer` | LOCAL | `/v1/tutoring/sessions/{session_id}/answer` |
| POST | `/v1/tutoring/sessions/{session_id}/complete` | LOCAL | `/v1/tutoring/sessions/{session_id}/complete` |
| POST | `/v1/courses` | FWD | — |
| POST | `/v1/courses/{course_id}/regenerate` | FWD | — |
| POST | `/v1/courses/{course_id}/retry` | FWD | — |
| GET | `/v1/course-progress` | LOCAL | `/v1/course-progress` |
| GET | `/v1/courses` | LOCAL | `/v1/courses` |
| GET | `/v1/courses/{course_id}` | LOCAL | `/v1/courses/{course_id}` |
| PUT | `/v1/courses/{course_id}` | LOCAL | `/v1/courses/{course_id}` |
| PUT | `/v1/courses/{course_id}/chapters/{chapter_id}` | LOCAL | `/v1/courses/{course_id}/chapters/{chapter_id}` |
| POST | `/v1/courses/{course_id}/chapters/{chapter_id}/resources/{resource_type}/retry` | FWD | — |
| DELETE | `/v1/courses/{course_id}` | FWD | — |
| GET | `/v1/learning-resources` | LOCAL | `/v1/learning-resources` |
| POST | `/v1/learning-resources/{resource_id}/regenerate` | FWD | — |
| GET | `/v1/learning-context` | FWD | — |
| GET | `/v1/memories` | FWD | — |
| POST | `/v1/memory/context` | FWD | — |
| PUT | `/v1/memories` | FWD | — |
| GET | `/v1/memory/profile-analysis` | FWD | — |
| POST | `/v1/profile/llm-score` | FWD | — |
| PUT | `/v1/learners/scores` | FWD | — |
| DELETE | `/v1/memories/{memory_id}` | FWD | — |
| GET | `/v1/course-recommendations` | FWD | — |
| GET | `/v1/learning-resources/{resource_id}` | LOCAL | `/v1/learning-resources/{resource_id}` |
| GET | `/v1/learning-resources/{resource_id}/traceability` | LOCAL | `/v1/learning-resources/{resource_id}/traceability` |
| POST | `/v1/learning-resources/{resource_id}/complete` | LOCAL | `/v1/learning-resources/{resource_id}/complete` |
| PATCH | `/v1/learning-resources/{resource_id}/progress` | LOCAL | `/v1/learning-resources/{resource_id}/progress` |
| POST | `/v1/learning-resources/{resource_id}/source-feedback` | LOCAL | `/v1/learning-resources/{resource_id}/source-feedback` |
| POST | `/v1/learning-resources/batch-delete` | FWD | — |
| POST | `/v1/learning-resource-tasks/{resource_type}` | FWD | — |
| GET | `/v1/learning-resource-tasks` | LOCAL | `/v1/learning-resource-tasks` |
| POST | `/v1/admin-generation-batches` | FWD | — |
| POST | `/v1/customize-resource` | FWD | — |
| GET | `/v1/customize-tasks` | LOCAL | `/v1/customize-tasks` |
| GET | `/v1/customize-tasks/{task_id}` | LOCAL | `/v1/customize-tasks/{task_id}` |
| GET | `/v1/customize-tasks/{task_id}/slides` | LOCAL | `/v1/customize-tasks/{task_id}/slides` |
| GET | `/v1/admin-generation-groups` | FWD | — |
| GET | `/v1/admin-generation-resources/{resource_id}` | FWD | — |
| GET | `/v1/learning-resource-tasks/{task_id}` | LOCAL | `/v1/learning-resource-tasks/{task_id}` |
| POST | `/v1/learning-resource-tasks/{task_id}/restart` | FWD | — |
| POST | `/v1/learning-resource-tasks/{task_id}/cancel` | FWD | — |
| DELETE | `/v1/learning-resource-tasks/{task_id}` | FWD | — |
| GET | `/v1/admin-generation-tasks/{task_type}/{task_id}/stream` | FWD | — |
| POST | `/v1/admin-generation-events/{task_type}/{task_id}/backfill-summaries` | FWD | — |
| GET | `/v1/admin-generation-events/{task_type}/{task_id}/summarize` | FWD | — |
| POST | `/v1/learning-resources/lectures` | FWD | — |
| POST | `/v1/learning-resources/quizzes` | FWD | — |
| POST | `/v1/learning-resources/practices` | FWD | — |
| GET | `/v1/learning-resources/{resource_id}/next-question` | FWD | — |
| POST | `/v1/learning-resources/{resource_id}/answers` | LOCAL | `/v1/learning-resources/{resource_id}/answers` |
| POST | `/v1/learning-resources/{resource_id}/reset` | LOCAL | `/v1/learning-resources/{resource_id}/reset` |
| POST | `/v1/learning-resources/{resource_id}/ability-reward` | LOCAL | `/v1/learning-resources/{resource_id}/ability-reward` |
| POST | `/v1/learning-resources/{resource_id}/answers/grade` | LOCAL | `/v1/learning-resources/{resource_id}/answers/grade` |
| GET | `/v1/learning-resources/{resource_id}/messages` | LOCAL | `/v1/learning-resources/{resource_id}/messages` |
| POST | `/v1/learning-resources/{resource_id}/chat` | FWD | — |
| POST | `/v1/presentations/{task_id}/notes/draft` | FWD | — |
| POST | `/v1/agent-runs` | FWD | — |
| POST | `/v1/agent-runs/stream` | FWD | — |
| GET | `/v1/agent-runs/{run_id}` | FWD | — |
| POST | `/v1/chat/attachments` | FWD | — |
| GET | `/v1/chat/attachments/{attachment_id}` | FWD | — |
| POST | `/v1/chat/sessions` | FWD | — |
| GET | `/v1/chat/sessions` | FWD | — |
| GET | `/v1/chat/sessions/{session_id}/messages` | FWD | — |
| PUT | `/v1/chat/sessions/{session_id}/rename` | FWD | — |
| PUT | `/v1/chat/sessions/{session_id}/archive` | FWD | — |
| DELETE | `/v1/chat/sessions/{session_id}` | FWD | — |
| POST | `/v1/graph-suggest` | FWD | — |
| POST | `/v1/chat` | FWD | — |
| POST | `/v1/chat/stream` | FWD | — |
| GET | `/v1/chat/sessions/{session_id}/active` | FWD | — |
| GET | `/v1/chat/sessions/{session_id}/resume` | FWD | — |
| DELETE | `/internal/v1/admin/presentations/{task_id}` | FWD | — |
| DELETE | `/internal/v1/admin/task-groups` | FWD | — |
| GET | `/internal/v1/agents` | FWD | — |
| POST | `/internal/v1/agent-runs` | FWD | — |
| POST | `/internal/v1/agent-runs/stream` | FWD | — |
| GET | `/internal/v1/agent-runs/{run_id}` | FWD | — |
| POST | `/internal/v1/chat` | FWD | — |
| POST | `/internal/v1/chat/stream` | FWD | — |

## Spire 本地有、Python 无同名 (额外面, 不影响覆盖)

- `ANY /v1/{*rest}`
- `ANY /internal/v1/{*rest}`

