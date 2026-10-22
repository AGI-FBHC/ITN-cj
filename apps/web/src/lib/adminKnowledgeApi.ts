import { getToken } from "@/lib/api";

const KC = "/api/v1/admin/knowledge-core";
const PREDEAL = "/api/v1/admin/predeal";
const QUESTIONS = "/api/v1/admin/questions";

async function direct<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  )
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = (await response.json()) as {
        detail?: string | { msg?: string }[];
        message?: string;
        error?: string;
      };
      if (typeof payload.detail === "string") message = payload.detail;
      else if (Array.isArray(payload.detail))
        message =
          payload.detail
            .map((item) => item.msg)
            .filter(Boolean)
            .join("；") || message;
      else message = payload.message || payload.error || message;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type GapStatus = "no_chunks" | "below_threshold" | "ok";

export interface KcCategoryNode {
  /* 后端以字符串下发：knowledge_category.id 超过 JS 安全整数 */
  id: string;
  parent_id: string | null;
  node_code: string;
  name: string;
  description?: string | null;
  level: number;
  node_type: string;
  sort_order: number;
  chunk_count: number;
  threshold: number;
  gap: GapStatus;
  children: KcCategoryNode[];
}

export interface KcCategoryTree {
  domain_code: string;
  domain_id: number;
  total: number;
  tree: KcCategoryNode[];
}

export interface KcCoverageItem {
  category_id: number;
  parent_id: number | null;
  node_code: string;
  name: string;
  level: number;
  node_type: string;
  chunk_count: number;
  threshold: number;
  gap: GapStatus;
}

export interface KcCoverage {
  domain_id: number;
  domain_code: string;
  domain_name: string;
  summary: {
    total_nodes: number;
    total_chunks: number;
    no_chunks: number;
    below_threshold: number;
    ok: number;
  };
  items: KcCoverageItem[];
}

export interface KcChunkHit {
  chunk_id: number;
  chunk_code: string;
  document_id?: string | null;
  title_path: string;
  section_title: string;
  content: string;
  summary?: string | null;
  source: "mysql" | "parent" | "rag" | "context";
  confidence?: number | null;
  relation_type?: string | null;
  similarity?: number | null;
  rerank_score?: number | null;
}

export interface KcSearchResult {
  knowledge_point: string;
  domain_code: string;
  category_id?: number | null;
  category_name?: string | null;
  category_level?: number | null;
  node_type?: string | null;
  decision: "mysql" | "parent" | "rag" | "empty";
  threshold: number;
  chunks: KcChunkHit[];
  hit_chunks: KcChunkHit[];
  context_chunks: KcChunkHit[];
  stats: Record<string, number>;
  via_parent: boolean;
  warning?: string | null;
  prerequisites?: Record<string, unknown> | null;
  contrasts?: Record<string, unknown>[] | null;
}

export interface KcClassification {
  classification_id: number;
  chunk_id?: number | null;
  category_id: number;
  category_name: string;
  node_code: string;
  level: number;
  node_type: string;
  full_path: string;
  relation_type: string;
  confidence?: number | null;
  source: string;
  chunk_code: string;
  section_title: string;
  title_path: string;
  content_preview: string;
}

export interface KcClassificationAudit {
  domain_code: string;
  domain_id: number;
  total: number;
  limit: number;
  offset: number;
  items: KcClassification[];
}

export interface KcGraphEdge {
  id: number;
  domain_id: number;
  /* 后端以字符串下发，避免大 id 在 JS 中被舍入 */
  category_id: string;
  prereq_category_id: string;
  edge_type: string;
  source_domain_id?: number | null;
  confidence: number;
  rationale?: string | null;
  status: string;
  source: string;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PredealDomain {
  id: string;
  /** 知识领域编码（knowledge_domain.code），决定 RAGFlow 数据集名 */
  code?: string;
  profile: string;
  language: string;
}
export interface PredealTask {
  id: string;
  file_name: string;
  domain: string;
  status:
    "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  current_stage?: string;
  progress?: number;
  error_code?: string | null;
  error_message?: string | null;
  cancel_requested?: boolean;
  created_at?: string;
  updated_at?: string;
  params: Record<string, unknown>;
  result?: {
    status: string;
    document_key?: string;
    db_document_id?: number;
    document_id?: string;
    chunk_count?: number;
    figure_count?: number;
    sync_report?: Record<string, unknown>;
    ragflow?: Record<string, unknown>;
    errors?: string[];
    artifacts_dir?: string;
    reused?: boolean;
  } | null;
}

export interface PredealProgressEvent {
  type: "progress" | "done";
  step_name?: string;
  step_num?: number;
  status?: string;
  message?: string;
  label?: string;
  result?: PredealTask["result"];
}

export interface QuestionRecord {
  id: number;
  question_type: string;
  difficulty: number;
  cognitive_level: string;
  stem: string;
  options: Array<{ key: string; text: string }> | null;
  reference_answer: unknown;
  explanation: string | null;
  status: "proposed" | "active" | "rejected" | "deprecated";
  source_type: string;
  updated_at: string;
  knowledge_points?: Array<{
    category_id: number;
    role: string;
    weight: number;
  }>;
}

export interface QuestionPage {
  total: number;
  page: number;
  size: number;
  items: QuestionRecord[];
}

async function streamPredealProgress(
  taskId: string,
  onEvent: (event: PredealProgressEvent) => void,
) {
  const headers = new Headers({ Accept: "text/event-stream" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(
    `${PREDEAL}/progress/${encodeURIComponent(taskId)}`,
    { headers },
  );
  if (!response.ok || !response.body)
    throw new Error(`进度流连接失败 (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach((block) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) onEvent(JSON.parse(data) as PredealProgressEvent);
    });
  }
}

function query(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "")
      search.set(key, String(value));
  });
  return `${path}?${search.toString()}`;
}

export const adminKnowledgeApi = {
  health: () => direct<{ status: string }>(`${KC}/health`),
  tree: (domain: string, thresholdMode: "fixed" | "auto" = "fixed") =>
    direct<KcCategoryTree>(
      query(`${KC}/knowledge/categories`, {
        domain,
        threshold_mode: thresholdMode,
      }),
    ),
  coverage: (domain: string, thresholdMode: "fixed" | "auto" = "fixed") =>
    direct<KcCoverage>(
      query(`${KC}/knowledge/coverage`, {
        domain,
        threshold_mode: thresholdMode,
      }),
    ),
  search: (params: {
    knowledgePoint: string;
    domain: string;
    categoryId?: number | string;
    threshold?: number;
    thresholdMode: "fixed" | "auto";
    minConfidence?: number;
    includeRag: boolean;
    includePrerequisites: boolean;
    includeContrasts: boolean;
    expandContext: boolean;
    limit?: number;
  }) =>
    direct<KcSearchResult>(
      query(`${KC}/knowledge/chunks`, {
        knowledge_point: params.knowledgePoint,
        domain: params.domain,
        category_id: params.categoryId,
        threshold: params.threshold,
        threshold_mode: params.thresholdMode,
        min_confidence: params.minConfidence,
        include_rag: params.includeRag,
        include_prerequisites: params.includePrerequisites,
        include_contrasts: params.includeContrasts,
        expand_context: params.expandContext,
        limit: params.limit,
      }),
    ),
  classificationAudit: (params: {
    domain: string;
    maxConfidence: number;
    source?: string;
    relationType?: string;
    limit?: number;
    offset?: number;
  }) =>
    direct<KcClassificationAudit>(
      query(`${KC}/knowledge/classifications/audit`, {
        domain: params.domain,
        max_confidence: params.maxConfidence,
        source: params.source,
        relation_type: params.relationType,
        limit: params.limit ?? 100,
        offset: params.offset ?? 0,
      }),
    ),
  correctClassification: (body: {
    action: "assign" | "delete" | "move" | "set_confidence";
    classification_id?: number;
    chunk_id?: number;
    old_category_id?: number;
    new_category_id?: number;
    confidence?: number;
  }) =>
    direct<{ ok: boolean; detail: string }>(
      `${KC}/knowledge/classifications/correct`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  edges: (
    params: { domainId?: number; status?: string; edgeType?: string } = {},
  ) =>
    direct<KcGraphEdge[]>(
      query(`${KC}/knowledge/graph/edges`, {
        domain_id: params.domainId,
        status: params.status,
        edge_type: params.edgeType,
      }),
    ),
  reviewEdges: (edgeIds: number[], approve: boolean) =>
    direct<Record<string, unknown>>(`${KC}/knowledge/graph/review`, {
      method: "POST",
      body: JSON.stringify({ edge_ids: edgeIds, approve }),
    }),
  approveEdge: (id: number) =>
    direct<Record<string, unknown>>(
      `${KC}/knowledge/graph/edges/${id}/approve`,
      { method: "POST" },
    ),
  rejectEdge: (id: number) =>
    direct<Record<string, unknown>>(
      `${KC}/knowledge/graph/edges/${id}/reject`,
      { method: "POST" },
    ),
  reverseEdge: (id: number) =>
    direct<Record<string, unknown>>(
      `${KC}/knowledge/graph/edges/${id}/reverse`,
      { method: "POST" },
    ),
  deleteEdge: (id: number) =>
    direct<Record<string, unknown>>(
      `${KC}/knowledge/graph/edges/${id}`,
      { method: "DELETE" },
    ),
  validateGraph: (domainId?: number) =>
    direct<{
      is_consistent: boolean;
      errors: string[];
      edge_count: number;
      active_prereq_count: number;
    }>(query(`${KC}/knowledge/graph/validate`, { domain_id: domainId }), {
      method: "POST",
    }),
  addPrerequisite: (body: {
    categoryId: number;
    prereqCategoryId: number;
    domainId?: number;
    edgeType?: string;
    source?: string;
    rationale?: string;
    createdBy?: string;
    directActive?: boolean;
  }) =>
    direct<{ edge: KcGraphEdge; warnings: string[] }>(
      `${KC}/knowledge/graph/prerequisites`,
      {
        method: "POST",
        body: JSON.stringify({
          category_id: body.categoryId,
          prereq_category_id: body.prereqCategoryId,
          domain_id: body.domainId,
          edge_type: body.edgeType ?? "prerequisite",
          source: body.source ?? "human",
          rationale: body.rationale,
          created_by: body.createdBy,
          direct_active: body.directActive ?? false,
        }),
      },
    ),
  predealDomains: () =>
    direct<{ domains: PredealDomain[] }>(`${PREDEAL}/domains`),
  uploadDocument: (form: FormData) =>
    direct<{ task_id: string; status: string }>(`${PREDEAL}/v1/uploads`, {
      method: "POST",
      body: form,
    }),
  predealTask: (taskId: string) =>
    direct<PredealTask>(`${PREDEAL}/task/${encodeURIComponent(taskId)}`),
  predealTasks: (page = 0, size = 20) =>
    direct<{ items: PredealTask[]; total: number; page: number; size: number }>(
      query(`${PREDEAL}/v1/uploads`, { page, size }),
    ),
  predealEvents: (taskId: string) =>
    direct<{
      items: Array<{
        sequence_no: number;
        stage: string;
        level: string;
        message: string;
        created_at: string;
      }>;
    }>(`${PREDEAL}/v1/uploads/${encodeURIComponent(taskId)}/events`),
  cancelPredealTask: (taskId: string) =>
    direct<{ task_id: string; cancel_requested: boolean }>(
      `${PREDEAL}/v1/uploads/${encodeURIComponent(taskId)}/cancel`,
      { method: "POST" },
    ),
  retryPredealTask: (taskId: string) =>
    direct<{ task_id: string; status: string }>(
      `${PREDEAL}/v1/uploads/${encodeURIComponent(taskId)}/retry`,
      { method: "POST" },
    ),
  questionOverview: () =>
    direct<{
      total: number;
      by_status: Record<string, number>;
      by_type: Record<string, number>;
      by_difficulty: Record<string, number>;
    }>(`${QUESTIONS}/stats/overview`),
  questions: (
    params: {
      status?: string;
      keyword?: string;
      page?: number;
      size?: number;
      categoryId?: number | string;
    } = {},
  ) =>
    direct<QuestionPage>(
      query(QUESTIONS, {
        status: params.status,
        keyword: params.keyword,
        page: params.page ?? 0,
        size: params.size ?? 50,
        category_id: params.categoryId,
      }),
    ),
  createQuestion: (body: Record<string, unknown>) =>
    direct<QuestionRecord>(QUESTIONS, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  importQuestions: (items: Record<string, unknown>[]) =>
    direct<{ created: unknown[]; skipped: unknown[]; failed: unknown[] }>(
      `${QUESTIONS}/import`,
      {
        method: "POST",
        body: JSON.stringify(items),
      },
    ),
  updateQuestion: (id: number, body: Record<string, unknown>) =>
    direct<QuestionRecord>(`${QUESTIONS}/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  reviewQuestion: (id: number, status: "active" | "rejected") =>
    direct<QuestionRecord>(`${QUESTIONS}/${id}/review?status=${status}`, {
      method: "POST",
    }),
  deprecateQuestion: (id: number) =>
    direct<QuestionRecord>(`${QUESTIONS}/${id}/deprecate`, { method: "POST" }),
  streamPredealProgress,
};
