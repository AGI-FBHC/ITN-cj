import asyncio
import json
from pathlib import Path
from functools import lru_cache
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.domain.models import (AgentRunRequest, AgentRunResponse, ChatRequest,
                               ChatResponse, WorkflowState)
from app.llm import LLMClient
from app.storage.run_repository import AgentRunRepository
from app.security import InternalPrincipal, require_internal_principal
from app.services.enhanced_chat_agent import EnhancedChatAgent
from app.presentations.store import PresentationStore
from app.workflow import AgentWorkflow

router = APIRouter(prefix="/internal/v1")


@router.delete("/admin/presentations/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_archived_presentation(
    task_id: UUID, principal: InternalPrincipal = Depends(require_internal_principal)
):
    store = PresentationStore(get_settings())
    output = await asyncio.to_thread(store.admin_delete_archived, task_id, principal.user_id)
    if output is None:
        raise HTTPException(status_code=404, detail="Archived presentation not found in administrator organization")
    if output:
        path = Path(output).resolve()
        output_root = get_settings().presentation_output_dir.resolve()
        if path.is_relative_to(output_root) and path.is_file():
            await asyncio.to_thread(path.unlink)


@router.delete("/admin/task-groups", status_code=status.HTTP_200_OK)
async def admin_delete_task_group(
    domainCode: str = Query(...), nodeCode: str = Query(...), groupName: str = Query(...),
    principal: InternalPrincipal = Depends(require_internal_principal),
):
    domain = str(domainCode or "").strip()
    node = str(nodeCode or "").strip()
    group = str(groupName or "").strip()
    if not domain or not node or not group:
        raise HTTPException(status_code=422, detail="domainCode/nodeCode/groupName are required")
    if group == "默认分组":
        raise HTTPException(status_code=400, detail="默认分组不允许彻底删除")

    from app.routers import public
    settings = get_settings()
    output_root = settings.presentation_output_dir.resolve()
    deleted = 0

    def cleanup() -> int:
        nonlocal deleted
        from app.storage.platform_db import platform_connect
        presentation_outputs: list[str] = []
        with platform_connect(settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT organization_id,account_type FROM users WHERE HEX(id)=%s",
                    (principal.user_id.hex.upper(),),
                )
                user = cursor.fetchone()
                if not user or str(user.get("account_type") or "").upper() != "ADMIN" or not user.get("organization_id"):
                    raise PermissionError("Only organization administrators can delete task groups")
                org = user["organization_id"]

                resource_filter = """
                  HEX(user_id)=%s
                  AND COALESCE(
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')),
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.domainCode'))
                  )=%s
                  AND COALESCE(
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')),
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.nodeCode'))
                  )=%s
                  AND BINARY COALESCE(
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')),
                    JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))
                  )=BINARY %s
                """
                cursor.execute(
                    f"SELECT HEX(id) id_hex,status FROM learning_resource_generation_tasks WHERE {resource_filter}",
                    (principal.user_id.hex.upper(), domain, node, group),
                )
                resource_rows = list(cursor.fetchall())
                deleted += len(resource_rows)
                for row in resource_rows:
                    try:
                        task_id = UUID(str(row["id_hex"]))
                    except (TypeError, ValueError):
                        continue
                    running = public._learning_resource_generation_tasks.pop(task_id, None)
                    if running and not running.done():
                        running.cancel()
                if resource_rows:
                    cursor.execute(
                        f"DELETE FROM learning_resource_generation_tasks WHERE {resource_filter}",
                        (principal.user_id.hex.upper(), domain, node, group),
                    )

                cursor.execute(
                    """
                    SELECT HEX(id) id_hex, output_path, status FROM presentation_tasks
                    WHERE organization_id=%s AND resource_scope='ORGANIZATION'
                      AND domain_code=%s AND category_node_code=%s
                      AND BINARY COALESCE(
                        resource_group,
                        JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))
                      )=BINARY %s
                    """,
                    (org, domain, node, group),
                )
                ppt_rows = list(cursor.fetchall())
                deleted += len(ppt_rows)
                for row in ppt_rows:
                    try:
                        task_id = UUID(str(row["id_hex"]))
                    except (TypeError, ValueError):
                        continue
                    running = public._presentation_tasks.pop(task_id, None)
                    if running and not running.done():
                        running.cancel()
                    if row.get("output_path"):
                        presentation_outputs.append(str(row["output_path"]))
                if ppt_rows:
                    cursor.execute(
                        """
                        DELETE FROM presentation_task_user_state
                        WHERE task_id IN (
                          SELECT id FROM presentation_tasks
                          WHERE organization_id=%s AND resource_scope='ORGANIZATION'
                            AND domain_code=%s AND category_node_code=%s
                            AND BINARY COALESCE(
                              resource_group,
                              JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))
                            )=BINARY %s
                        )
                        """,
                        (org, domain, node, group),
                    )
                    cursor.execute(
                        """
                        DELETE FROM presentation_tasks
                        WHERE organization_id=%s AND resource_scope='ORGANIZATION'
                          AND domain_code=%s AND category_node_code=%s
                          AND BINARY COALESCE(
                            resource_group,
                            JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))
                          )=BINARY %s
                        """,
                        (org, domain, node, group),
                    )
                connection.commit()

        for raw in presentation_outputs:
            if not raw:
                continue
            path = Path(raw).resolve()
            if path.is_relative_to(output_root) and path.is_file():
                path.unlink(missing_ok=True)
        return deleted

    try:
        deleted = await asyncio.to_thread(cleanup)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    return {"deleted": deleted}


DEFAULT_CHAT_SYSTEM_PROMPT = (
    "\u4f60\u662f\u4e00\u4e2a\u901a\u7528Agent\uff0c\u80fd\u591f\u56de\u7b54\u5404\u7c7b\u95ee\u9898\u5e76\u4e3b\u52a8\u4f7f\u7528\u5de5\u5177\u83b7\u53d6\u4fe1\u606f\u3002"
    "\u56de\u7b54\u6e05\u6670\u3001\u7ed3\u6784\u5316\uff0c\u5fc5\u8981\u65f6\u4f7f\u7528\u5217\u8868\u548c\u5206\u70b9\u3002"
    "\u9047\u5230\u9700\u8981\u5b9e\u65f6\u4fe1\u606f\u7684\u95ee\u9898\uff0c\u4e3b\u52a8\u4f7f\u7528\u641c\u7d22\u5de5\u5177\u3002"
    "\u5982\u679c\u641c\u7d22\u7ed3\u679c\u4e2d\u5305\u542b\u654f\u611f\u6216\u4e0d\u5f53\u5185\u5bb9\uff0c\u4e0d\u8981\u5f15\u7528\u6216\u590d\u8ff0\uff0c\u53ea\u63d0\u53d6\u4e0e\u95ee\u9898\u76f8\u5173\u7684\u4fe1\u606f\u3002"
    "\u5982\u679c\u6d89\u53ca\u654f\u611f\u8bdd\u9898\uff0c\u793c\u8c8c\u8bf4\u660e\u65e0\u6cd5\u56de\u7b54\u5e76\u5efa\u8bae\u6362\u4e2a\u89d2\u5ea6\u63d0\u95ee\u3002"
)


@lru_cache
def repository() -> AgentRunRepository:
    return AgentRunRepository(get_settings())


def workflow() -> AgentWorkflow:
    return AgentWorkflow(LLMClient(get_settings()), repository())


def initial_state(principal: InternalPrincipal, request: AgentRunRequest) -> WorkflowState:
    return WorkflowState(user_id=principal.user_id, learning_goal_id=request.learning_goal_id,
                         content=request.content, profile=request.profile, input=request.input)


@router.get("/agents")
async def list_agents(_: InternalPrincipal = Depends(require_internal_principal)):
    return {"agents": [{"id": item.agent_id, "name": item.name} for item in workflow().agents]}


@router.post("/agent-runs", response_model=AgentRunResponse)
async def run_agents(request: AgentRunRequest,
                     principal: InternalPrincipal = Depends(require_internal_principal)):
    state = await workflow().run(initial_state(principal, request))
    return AgentRunResponse(run_id=state.run_id, status=state.status,
                            result=state.final_content, errors=state.errors)


@router.post("/agent-runs/stream")
async def stream_agents(request: AgentRunRequest,
                        principal: InternalPrincipal = Depends(require_internal_principal)):
    state = initial_state(principal, request)

    async def events():
        async for event in workflow().stream(state):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/agent-runs/{run_id}")
async def get_run(run_id: UUID, principal: InternalPrincipal = Depends(require_internal_principal)):
    result = repository().get(run_id, principal.user_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent run not found")
    return result


def llm_client() -> LLMClient:
    return LLMClient(get_settings())


def chat_agent(provider: str = "kimi") -> EnhancedChatAgent:
    return EnhancedChatAgent(llm_client(), get_settings(), provider=provider, max_iterations=get_settings().chat_tool_max_iterations)


def chat_messages(request: ChatRequest) -> list[dict[str, str]]:
    system = request.system_prompt or DEFAULT_CHAT_SYSTEM_PROMPT
    messages = [{"role": "system", "content": system}]
    messages.extend({"role": item.role, "content": item.content} for item in request.messages)
    return messages


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest,
               principal: InternalPrincipal = Depends(require_internal_principal)):
    reply, _ = await chat_agent(provider=request.model_provider).run(
        chat_messages(request), user_id=principal.user_id)
    return ChatResponse(reply=reply)


@router.post("/chat/stream")
async def stream_chat(request: ChatRequest,
                      principal: InternalPrincipal = Depends(require_internal_principal)):
    messages = chat_messages(request)

    async def events():
        has_output = False
        try:
            events_stream = chat_agent(provider=request.model_provider).stream(
                messages, include_reasoning=request.include_reasoning, user_id=principal.user_id)
            async for event in events_stream:
                if event["type"] == "reasoning":
                    has_output = True
                    payload = {"type": "chat_reasoning_delta", "content": event["text"]}
                elif event["type"] == "content":
                    has_output = True
                    payload = {"type": "chat_delta", "content": event["text"]}
                elif event["type"] == "tool_call_started":
                    has_output = True
                    payload = {"type": "tool_call_started", "tool": event["tool"],
                               "name": event["name"], "arguments": event["arguments"]}
                elif event["type"] == "tool_call_completed":
                    has_output = True
                    payload = {"type": "tool_call_completed", "tool": event["tool"],
                               "name": event["name"], "success": event["success"],
                               "preview": event["preview"]}
                else:
                    continue
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'chat_completed'}, ensure_ascii=False)}\n\n"
        except Exception:
            if has_output:
                yield f"data: {json.dumps({'type': 'chat_completed'}, ensure_ascii=False)}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'chat_failed', 'code': 'CHAT_EXECUTION_FAILED'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
