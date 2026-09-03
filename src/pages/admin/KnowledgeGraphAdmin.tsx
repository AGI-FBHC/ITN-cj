import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { adminKnowledgeApi, type KcCategoryNode, type KcGraphEdge } from "@/lib/adminKnowledgeApi";
import { cn } from "@/lib/utils";

type Tab = "overview" | "review" | "edges" | "dag" | "builder";
type CategoryInfo = Pick<KcCategoryNode, "id" | "name" | "level" | "parent_id" | "node_type" | "chunk_count">;
const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "网络概览" },
  { id: "review", label: "审核队列" },
  { id: "edges", label: "建边情况" },
  { id: "dag", label: "DAG 图" },
  { id: "builder", label: "快速建图" },
];
const statusLabel: Record<string, string> = {
  active: "生效",
  proposed: "待审核",
  needs_review: "待重审",
  rejected: "已拒绝",
  deprecated: "已废弃",
  redundant: "冗余",
};
const typeLabel: Record<string, string> = {
  prerequisite: "先修",
  cross_domain_prerequisite: "跨域先修",
  related: "相关",
  contrasts_with: "易混淆",
};
function Status({ value }: { value: string }) {
  return <span className={cn("lf-pill", value === "active" ? "lf-pill-ok" : value === "proposed" || value === "needs_review" ? "lf-pill-warn" : value === "rejected" ? "lf-pill-danger" : "lf-pill-null")}>{statusLabel[value] || value}</span>;
}

function walkCategories(nodes: KcCategoryNode[], map = new Map<number, CategoryInfo>()) {
  nodes.forEach((node) => {
    map.set(node.id, node);
    walkCategories(node.children, map);
  });
  return map;
}

function EdgeDetails({ edge, names, onClose, onAction: _onAction }: { edge: KcGraphEdge; names: Map<number, CategoryInfo>; onClose: () => void; onAction: (action: "approve" | "reject" | "reverse") => void }) {
  return (
    <div className="lf-overlay fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="lf-glass h-full w-full max-w-md overflow-y-auto rounded-none">
        <div className="flex items-center justify-between border-b border-white/60 p-5">
          <h3 className="font-semibold">先修边审批详情</h3>
          <button onClick={onClose} className="p-1 text-ink-muted">
            <X size={18} />
          </button>
        </div>
        <dl className="grid grid-cols-[92px_1fr] gap-y-3 p-5 text-sm">
          <dt className="text-ink-muted">边 ID</dt>
          <dd>#{edge.id}</dd>
          <dt className="text-ink-muted">先修节点</dt>
          <dd>{names.get(edge.prereq_category_id)?.name || `#${edge.prereq_category_id}`}</dd>
          <dt className="text-ink-muted">目标节点</dt>
          <dd>{names.get(edge.category_id)?.name || `#${edge.category_id}`}</dd>
          <dt className="text-ink-muted">边类型</dt>
          <dd>{typeLabel[edge.edge_type] || edge.edge_type}</dd>
          <dt className="text-ink-muted">状态</dt>
          <dd>
            <Status value={edge.status} />
          </dd>
          <dt className="text-ink-muted">来源</dt>
          <dd>
            {edge.source}
            {edge.created_by ? ` · ${edge.created_by}` : ""}
          </dd>
          <dt className="text-ink-muted">置信度</dt>
          <dd>{Number(edge.confidence).toFixed(2)}</dd>
          <dt className="text-ink-muted">创建时间</dt>
          <dd>{edge.created_at ? new Date(edge.created_at).toLocaleString("zh-CN") : "—"}</dd>
          <dt className="text-ink-muted">理由 / 证据</dt>
          <dd className="whitespace-pre-wrap leading-6 text-ink-2">{edge.rationale || "—"}</dd>
        </dl>
        <div className="border-t border-white/60 p-5 text-xs text-ink-muted">当前阶段为只读网络，审核与改边功能暂不开放。</div>
      </div>
    </div>
  );
}

function Overview({ edges, setTab, setStatus }: { edges: KcGraphEdge[]; setTab: (tab: Tab) => void; setStatus: (status: string) => void }) {
  const statuses = ["active", "proposed", "rejected", "deprecated"];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => {
              setStatus(status);
              setTab("edges");
            }}
            className="lf-stat-card p-5 text-left"
          >
            <p className="text-xs text-ink-muted">
              {statusLabel[status]} · {status}
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{edges.filter((edge) => edge.status === status).length}</p>
          </button>
        ))}
      </div>
      <div className="lf-card rounded-2xl">
        <div className="border-b border-white/60 px-5 py-4 text-sm font-bold text-ink">最近建边</div>
        <EdgeTable edges={edges.slice(0, 12)} compact />
      </div>
    </div>
  );
}

function EdgeTable({ edges, names = new Map(), compact = false, onOpen, selected, onSelect }: { edges: KcGraphEdge[]; names?: Map<number, CategoryInfo>; compact?: boolean; onOpen?: (edge: KcGraphEdge) => void; selected?: Set<number>; onSelect?: (id: number, checked: boolean) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[850px] text-left text-sm">
        <thead>
          <tr>
            {selected && <th className="w-12 px-4 py-3"></th>}
            <th className="px-4 py-3">先修节点</th>
            <th className="px-2 py-3">→</th>
            <th className="px-4 py-3">目标节点</th>
            <th className="px-4 py-3">类型</th>
            <th className="px-4 py-3">状态</th>
            <th className="px-4 py-3">来源</th>
            <th className="px-4 py-3">置信度</th>
            {!compact && <th className="px-4 py-3">理由</th>}
            <th className="px-4 py-3">时间</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => (
            <tr key={edge.id} onClick={() => onOpen?.(edge)} className={cn(onOpen && "cursor-pointer hover:bg-brand-tint/50")}>
              {selected && (
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(edge.id)} onChange={(e) => onSelect?.(edge.id, e.target.checked)} />
                </td>
              )}
              <td className="px-4 py-3 font-medium">{names.get(edge.prereq_category_id)?.name || `#${edge.prereq_category_id}`}</td>
              <td className="px-2 py-3 text-ink-muted">→</td>
              <td className="px-4 py-3 font-medium">{names.get(edge.category_id)?.name || `#${edge.category_id}`}</td>
              <td className="px-4 py-3 text-xs text-ink-2">{typeLabel[edge.edge_type] || edge.edge_type}</td>
              <td className="px-4 py-3">
                <Status value={edge.status} />
              </td>
              <td className="px-4 py-3 text-xs text-ink-muted">{edge.source}</td>
              <td className="px-4 py-3 tabular-nums">{Number(edge.confidence).toFixed(2)}</td>
              {!compact && <td className="max-w-xs truncate px-4 py-3 text-xs text-ink-muted">{edge.rationale || "—"}</td>}
              <td className="px-4 py-3 text-xs text-ink-muted">{edge.created_at ? new Date(edge.created_at).toLocaleDateString("zh-CN") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!edges.length && <div className="p-12 text-center text-sm text-ink-muted">暂无边数据</div>}
    </div>
  );
}

type ProposedSuggestion = {
  prereqCategoryId: number;
  categoryId: number;
  edgeType: string;
  rationale?: string;
};

function SimpleChapterCanvas({
  categories,
  edges,
  sourceId,
  targetId,
  onPick,
}: {
  categories: Map<number, CategoryInfo>;
  edges: KcGraphEdge[];
  sourceId: number | null;
  targetId: number | null;
  onPick: (id: number) => void;
}) {
  const chapters = useMemo(
    () =>
      [...categories.values()]
        .filter((node) => node.level === 2 && (node.node_type === "category" || node.node_type === "domain"))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [categories],
  );
  const chapterIds = useMemo(() => new Set(chapters.map((node) => node.id)), [chapters]);
  const chapterEdges = useMemo(
    () => edges.filter((edge) => chapterIds.has(edge.prereq_category_id) && chapterIds.has(edge.category_id)),
    [edges, chapterIds],
  );
  const positions = useMemo(() => {
    const result = new Map<number, { x: number; y: number }>();
    const count = chapters.length;
    if (!count) return result;
    const cx = 600;
    const cy = 340;
    const radius = Math.max(150, Math.min(260, 190 + (count - 6) * 4));
    chapters.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      result.set(node.id, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });
    return result;
  }, [chapters]);

  return (
    <div className="lf-card rounded-2xl">
      <div className="border-b border-white/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch size={15} className="text-brand" />
          <h3 className="text-sm font-bold text-ink">章节网络 · 快速建边</h3>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-muted">这里只展示章节节点和章节之间的已有边。点第一个章节设为前置，再点第二个章节设为目标。</p>
      </div>
      <div className="overflow-x-auto p-3">
        <svg viewBox="0 0 1200 680" className="h-[560px] min-w-[900px] w-full rounded-xl border border-white/70 bg-white/40">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8" />
            </marker>
          </defs>
          {chapterEdges.map((edge) => {
            const from = positions.get(edge.prereq_category_id);
            const to = positions.get(edge.category_id);
            if (!from || !to) return null;
            const color = edge.edge_type === "cross_domain_prerequisite" ? "#7c3aed" : edge.edge_type === "related" ? "#0ea5e9" : edge.edge_type === "contrasts_with" ? "#ea580c" : "#94a3b8";
            return (
              <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth="2" strokeDasharray={edge.status === "proposed" ? "6 4" : undefined} markerEnd="url(#arrow)" opacity={0.72}>
                <title>{categories.get(edge.prereq_category_id)?.name} → {categories.get(edge.category_id)?.name}</title>
              </line>
            );
          })}
          {chapters.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const isSource = sourceId === node.id;
            const isTarget = targetId === node.id;
            const color = isSource ? "#d97706" : isTarget ? "#059669" : "#2563eb";
            return (
              <g key={node.id} transform={`translate(${pos.x},${pos.y})`} onClick={() => onPick(node.id)} className="cursor-pointer">
                <circle r="30" fill={isSource || isTarget ? color : "#fff"} stroke={color} strokeWidth={isSource || isTarget ? 4 : 2} />
                <text y="-38" textAnchor="middle" fontSize="12" fill={isSource || isTarget ? color : "#334155"} fontWeight={isSource || isTarget ? 700 : 500}>
                  {node.name}
                </text>
                <text y="4" textAnchor="middle" fontSize="10" fill={isSource || isTarget ? "#fff" : "#64748b"}>
                  #{node.id}
                </text>
                <title>{node.name} · 章节</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="border-t border-slate-100 px-4 py-3 text-xs text-ink-muted">
        {sourceId == null
          ? "请先点选前置章节"
          : targetId == null
            ? "已选前置章节，请再点选目标章节"
            : `当前连线：${categories.get(sourceId)?.name ?? sourceId} → ${categories.get(targetId)?.name ?? targetId}`}
      </div>
    </div>
  );
}

function DagQuickBuilder({
  categories,
  edges,
  onSaved,
  sourceId,
  targetId,
  onSourceIdChange,
  onTargetIdChange,
}: {
  categories: Map<number, CategoryInfo>;
  edges: KcGraphEdge[];
  onSaved: () => Promise<void>;
  sourceId: number | null;
  targetId: number | null;
  onSourceIdChange: (id: number | null) => void;
  onTargetIdChange: (id: number | null) => void;
}) {
  const options = useMemo(
    () =>
      [...categories.values()]
        .filter((node) => node.level === 2 && (node.node_type === "category" || node.node_type === "domain"))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [categories],
  );
  const existingKeys = useMemo(() => new Set(edges.map((edge) => `${edge.prereq_category_id}->${edge.category_id}`)), [edges]);
  const [edgeType, setEdgeType] = useState("prerequisite");
  const [rationale, setRationale] = useState("");
  const [directActive, setDirectActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<ProposedSuggestion[]>([]);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);

  const applyDraft = (index: number) => {
    const draft = suggestions[index];
    if (!draft) return;
    onSourceIdChange(draft.prereqCategoryId);
    onTargetIdChange(draft.categoryId);
    setEdgeType(draft.edgeType);
    setRationale(draft.rationale || "");
    setDraftIndex(index);
  };

  const save = async () => {
    const prereqId = sourceId;
    const categoryId = targetId;
    if (!prereqId || !categoryId) return toast.error("请选择前置节点和目标节点");
    if (prereqId === categoryId) return toast.error("前置节点不能等于目标节点");
    if (existingKeys.has(`${prereqId}->${categoryId}`)) return toast.error("该边已经存在");
    setBusy(true);
    try {
      const result = await adminKnowledgeApi.addPrerequisite({
        prereqCategoryId: prereqId,
        categoryId,
        edgeType,
        rationale: rationale.trim() || "管理员在 DAG 快速建图面板手动添加",
        source: "human",
        directActive,
      });
      toast.success(result.edge.status === "active" ? "建边已生效" : "建边已进入待审核队列");
      setRationale("");
      setDraftIndex(null);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "建边失败");
    } finally {
      setBusy(false);
    }
  };

  const runAiSuggest = async () => {
    if (!options.length) return toast.error("当前没有可建边的知识点");
    setAiBusy(true);
    setSuggestions([]);
    try {
      const compactNodes = options.slice(0, 160).map((node) => ({
        id: node.id,
        name: node.name,
        level: node.level,
        chunks: node.chunk_count,
      }));
      const existingEdges = edges.slice(0, 300).map((edge) => ({
        from: edge.prereq_category_id,
        to: edge.category_id,
        type: edge.edge_type,
        status: edge.status,
      }));
      const reply = await api.agentChat({
        modelProvider: "mimo",
        systemPrompt:
          "你是知识网络教研助手。根据给出的知识点清单和已有边，建议合理的先修、相关或易混淆边。只返回 JSON 数组，不要 Markdown，不要解释。每条格式：{\"prereqCategoryId\": number, \"categoryId\": number, \"edgeType\": \"prerequisite\" | \"related\" | \"contrasts_with\", \"rationale\": string}",
        messages: [
          {
            role: "user",
            content: `知识点：${JSON.stringify(compactNodes)}
已有边：${JSON.stringify(existingEdges)}`,
          },
        ],
      });
      const cleaned = (reply.reply || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start < 0 || end <= start) throw new Error("AI 返回格式无法解析");
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ProposedSuggestion[];
      const seen = new Set<string>();
      const valid = parsed.filter((item) => {
        if (!item.prereqCategoryId || !item.categoryId || item.prereqCategoryId === item.categoryId) return false;
        const key = `${item.prereqCategoryId}->${item.categoryId}`;
        if (existingKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return categories.has(item.prereqCategoryId) && categories.has(item.categoryId);
      });
      if (!valid.length) throw new Error("没有新建议，或建议与现有边重复");
      setSuggestions(valid.slice(0, 8));
      applyDraft(0);
      toast.success(`AI 给出 ${valid.length} 条建议，已填入第一条`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI 建议生成失败");
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="lf-card rounded-2xl">
      <div className="border-b border-white/60 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="text-brand" />
            <h3 className="text-sm font-bold text-ink">快速建图</h3>
          </div>
          <button onClick={() => void runAiSuggest()} disabled={aiBusy} className="lf-row-btn lf-row-btn-primary">
            {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            AI 建议
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-muted">先选前置/目标节点，再写一条边；AI 建议会尝试给出候选。</p>
      </div>
      <div className="space-y-3 p-4 text-xs">
        <label className="block">
          <span className="mb-1 block text-ink-muted">前置 / 先修节点</span>
          <select value={sourceId ?? ""} onChange={(e) => onSourceIdChange(e.target.value ? Number(e.target.value) : null)} className="lf-select w-full">
            <option value="">请选择前置节点</option>
            {options.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} · L{node.level} · #{node.id}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-ink-muted">目标节点</span>
          <select value={targetId ?? ""} onChange={(e) => onTargetIdChange(e.target.value ? Number(e.target.value) : null)} className="lf-select w-full">
            <option value="">请选择目标节点</option>
            {options.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} · L{node.level} · #{node.id}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-ink-muted">边类型</span>
            <select value={edgeType} onChange={(e) => setEdgeType(e.target.value)} className="lf-select w-full">
              {Object.entries(typeLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-5 flex items-center gap-2">
            <input type="checkbox" checked={directActive} onChange={(e) => setDirectActive(e.target.checked)} />
            直接生效
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-ink-muted">建边理由（可选）</span>
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} className="lf-input w-full resize-none" placeholder="为什么这条关系成立" />
        </label>
        {suggestions.length > 0 && (
          <div className="rounded-xl border border-brand/20 bg-brand-tint/20 p-2">
            <div className="mb-1 text-[11px] font-semibold text-brand">AI 候选</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((item, index) => (
                <button
                  key={`${item.prereqCategoryId}-${item.categoryId}-${index}`}
                  type="button"
                  onClick={() => applyDraft(index)}
                  className={cn("lf-row-btn", draftIndex === index ? "lf-row-btn-primary" : "")}
                >
                  {categories.get(item.prereqCategoryId)?.name || item.prereqCategoryId} → {categories.get(item.categoryId)?.name || item.categoryId}
                </button>
              ))}
            </div>
          </div>
        )}
        <button onClick={() => void save()} disabled={busy} className="lf-btn-primary w-full justify-center">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          添加这条边
        </button>
      </div>
    </div>
  );
}

function GraphCanvas({
  edges,
  categories,
  edgeMode = false,
  selectedIds,
  onPickNode,
}: {
  edges: KcGraphEdge[];
  categories: Map<number, CategoryInfo>;
  edgeMode?: boolean;
  selectedIds?: Set<number>;
  onPickNode?: (id: number) => void;
}) {
  const [layout, setLayout] = useState<"topology" | "band">("topology");
  const [statuses, setStatuses] = useState(new Set(["active"]));
  const [types, setTypes] = useState(new Set(["prerequisite", "cross_domain_prerequisite", "related"]));
  const [confidence, setConfidence] = useState(0.7);
  const [focus, setFocus] = useState<number | null>(null);
  const filtered = useMemo(() => edges.filter((edge) => statuses.has(edge.status) && types.has(edge.edge_type) && edge.confidence >= confidence), [edges, statuses, types, confidence]);
  const nodes = useMemo(() => [...new Set(filtered.flatMap((edge) => [edge.prereq_category_id, edge.category_id]))], [filtered]);
  const focusSet = useMemo(() => {
    if (focus == null) return null;
    const seen = new Set([focus]);
    let changed = true;
    while (changed) {
      changed = false;
      filtered.forEach((edge) => {
        if (seen.has(edge.category_id) && !seen.has(edge.prereq_category_id)) {
          seen.add(edge.prereq_category_id);
          changed = true;
        }
        if (seen.has(edge.prereq_category_id) && !seen.has(edge.category_id)) {
          seen.add(edge.category_id);
          changed = true;
        }
      });
    }
    return seen;
  }, [focus, filtered]);
  const positions = useMemo(() => {
    const result = new Map<number, { x: number; y: number }>();
    if (!nodes.length) return result;
    if (layout === "topology") {
      const indegree = new Map(nodes.map((id) => [id, 0]));
      filtered.forEach((edge) => indegree.set(edge.category_id, (indegree.get(edge.category_id) || 0) + 1));
      const levels = new Map<number, number>();
      const queue = nodes.filter((id) => !indegree.get(id));
      queue.forEach((id) => levels.set(id, 0));
      for (let i = 0; i < queue.length; i += 1) {
        const id = queue[i];
        filtered
          .filter((edge) => edge.prereq_category_id === id)
          .forEach((edge) => {
            levels.set(edge.category_id, Math.max(levels.get(edge.category_id) || 0, (levels.get(id) || 0) + 1));
            indegree.set(edge.category_id, (indegree.get(edge.category_id) || 0) - 1);
            if (indegree.get(edge.category_id) === 0) queue.push(edge.category_id);
          });
      }
      nodes.forEach((id) => {
        if (!levels.has(id)) levels.set(id, 0);
      });
      const groups = new Map<number, number[]>();
      nodes.forEach((id) => {
        const level = levels.get(id) || 0;
        groups.set(level, [...(groups.get(level) || []), id]);
      });
      const maxLevel = Math.max(...groups.keys(), 0);
      groups.forEach((ids, level) =>
        ids.forEach((id, index) =>
          result.set(id, {
            x: 90 + level * (1000 / Math.max(maxLevel, 1)),
            y: 70 + index * Math.min(90, 570 / Math.max(ids.length, 1)),
          }),
        ),
      );
    } else {
      const groups = new Map<number, number[]>();
      nodes.forEach((id) => {
        const key = categories.get(id)?.parent_id || 0;
        groups.set(key, [...(groups.get(key) || []), id]);
      });
      [...groups.entries()].forEach(([, ids], band) =>
        ids.forEach((id, index) =>
          result.set(id, {
            x: 100 + index * Math.min(150, 980 / Math.max(ids.length, 1)),
            y: 90 + band * Math.min(120, 570 / Math.max(groups.size, 1)),
          }),
        ),
      );
    }
    return result;
  }, [nodes, filtered, layout, categories]);
  const toggleSet = (current: Set<string>, value: string, set: (next: Set<string>) => void) => {
    const next = new Set(current);
    next.has(value) ? next.delete(value) : next.add(value);
    set(next);
  };
  return (
    <div className="lf-card rounded-2xl">
      <div className="flex flex-wrap items-center gap-4 border-b border-white/60 p-4 text-xs">
        <label>
          <input type="radio" checked={layout === "topology"} onChange={() => setLayout("topology")} /> 拓扑分层
        </label>
        <label>
          <input type="radio" checked={layout === "band"} onChange={() => setLayout("band")} /> 章节带
        </label>
        <span className="text-ink-muted">状态：</span>
        {["active", "proposed", "redundant"].map((value) => (
          <label key={value}>
            <input type="checkbox" checked={statuses.has(value)} onChange={() => toggleSet(statuses, value, setStatuses)} /> {value}
          </label>
        ))}
        <span className="text-ink-muted">类型：</span>
        {["prerequisite", "cross_domain_prerequisite", "related"].map((value) => (
          <label key={value}>
            <input type="checkbox" checked={types.has(value)} onChange={() => toggleSet(types, value, setTypes)} /> {typeLabel[value]}
          </label>
        ))}
        <label className="flex items-center gap-2">
          置信度 ≥ <input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
          <span className="tabular-nums">{confidence.toFixed(2)}</span>
        </label>
        {focus != null && (
          <button onClick={() => setFocus(null)} className="text-brand">
            退出焦点模式
          </button>
        )}
      </div>
      <div className="overflow-x-auto p-3">
        <svg viewBox="0 0 1200 720" className="h-[620px] min-w-[900px] w-full rounded-xl border border-white/70 bg-white/40">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8" />
            </marker>
          </defs>
          {filtered.map((edge) => {
            const from = positions.get(edge.prereq_category_id);
            const to = positions.get(edge.category_id);
            if (!from || !to) return null;
            const dim = focusSet && (!focusSet.has(edge.prereq_category_id) || !focusSet.has(edge.category_id));
            return (
              <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={edge.edge_type === "cross_domain_prerequisite" ? "#7c3aed" : edge.edge_type === "related" ? "#0ea5e9" : "#94a3b8"} strokeWidth="2" strokeDasharray={edge.status === "proposed" ? "6 4" : undefined} markerEnd="url(#arrow)" opacity={dim ? 0.1 : 0.75}>
                <title>
                  {categories.get(edge.prereq_category_id)?.name} → {categories.get(edge.category_id)?.name}
                </title>
              </line>
            );
          })}
          {nodes.map((id) => {
            const pos = positions.get(id);
            if (!pos) return null;
            const info = categories.get(id);
            const radius = 20 + Math.min(13, Math.log2((info?.chunk_count || 0) + 1) * 3);
            const dim = focusSet && !focusSet.has(id);
            return (
              <g key={id} transform={`translate(${pos.x},${pos.y})`} onClick={() => (onPickNode ? onPickNode(id) : setFocus(id))} className="cursor-pointer" opacity={dim ? 0.12 : 1}>
                <circle r={radius} fill={selectedIds?.has(id) ? "#d97706" : focus === id ? "#2563eb" : "#fff"} stroke={selectedIds?.has(id) ? "#d97706" : "#2563eb"} strokeWidth={selectedIds?.has(id) ? 3 : 2} />
                <text y={radius + 16} textAnchor="middle" fontSize="11" fill="#334155">
                  {(info?.name || `#${id}`).slice(0, 12)}
                </text>
                <text y="4" textAnchor="middle" fontSize="10" fill={focus === id ? "#fff" : "#64748b"}>
                  {info?.chunk_count || 0}
                </text>
                <title>
                  {info?.name || `#${id}`} · {info?.chunk_count || 0} 切片
                </title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="border-t border-slate-100 px-4 py-3 text-xs text-ink-muted">
        {edgeMode ? "编辑模式：先点前置节点，再点目标节点；右侧表单会同步当前选中。" : `显示 ${nodes.length} 个节点、${filtered.length} 条边；点击节点聚焦上下游，节点大小按 log(切片数) 缩放。`}
      </div>
    </div>
  );
}

export default function KnowledgeGraphAdmin() {
  const [tab, setTab] = useState<Tab>("overview");
  const [edges, setEdges] = useState<KcGraphEdge[]>([]);
  const [categories, setCategories] = useState(new Map<number, CategoryInfo>());
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set<number>());
  const [detail, setDetail] = useState<KcGraphEdge | null>(null);
  const [builderSourceId, setBuilderSourceId] = useState<number | null>(null);
  const [builderTargetId, setBuilderTargetId] = useState<number | null>(null);
  const handleBuilderPick = useCallback(
    (id: number) => {
      if (builderSourceId == null || builderSourceId === id) {
        setBuilderSourceId(id);
        setBuilderTargetId(null);
        return;
      }
      if (builderTargetId == null) {
        setBuilderTargetId(id);
        return;
      }
      setBuilderSourceId(builderTargetId);
      setBuilderTargetId(id);
    },
    [builderSourceId, builderTargetId],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEdges, tree] = await Promise.all([adminKnowledgeApi.edges(), adminKnowledgeApi.tree("agent")]);
      setEdges(nextEdges.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))));
      setCategories(walkCategories(tree.tree));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "网络数据读取失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const review = edges.filter((edge) => edge.status === "proposed" || edge.status === "needs_review");
  const filtered = edges.filter((edge) => (!status || edge.status === status) && (!type || edge.edge_type === type) && (!search.trim() || `${categories.get(edge.prereq_category_id)?.name} ${categories.get(edge.category_id)?.name}`.toLowerCase().includes(search.trim().toLowerCase())));
  const action = async (kind: "approve" | "reject" | "reverse", edgeIds: number[]) => {
    if (!edgeIds.length) return toast.error("请先选择要处理的边");
    if (!window.confirm(`确认${kind === "approve" ? "通过" : kind === "reject" ? "拒绝" : "反转"} ${edgeIds.length} 条先修边？`)) return;
    try {
      if (edgeIds.length > 1 && kind !== "reverse") await adminKnowledgeApi.reviewEdges(edgeIds, kind === "approve");
      else
        for (const id of edgeIds) {
          if (kind === "approve") await adminKnowledgeApi.approveEdge(id);
          else if (kind === "reject") await adminKnowledgeApi.rejectEdge(id);
          else await adminKnowledgeApi.reverseEdge(id);
        }
      toast.success("网络审核操作已完成");
      setSelected(new Set());
      setDetail(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "网络操作失败");
    }
  };
  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">知识网络管理</h2>
          <p className="mt-1 text-sm text-ink-muted">查看先修边、候选队列与 DAG；快速建图作为独立功能项，可直接在 2D 网络图上点选前置/目标节点建边。</p>
        </div>
        <button onClick={() => void refresh()} disabled={loading} className="lf-page-pill">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>
      <div className="lf-seg mb-6">
        {tabs.map((item) => (
          <button key={item.id} onClick={() => setTab(item.id)} className={cn("lf-seg-item", tab === item.id && "lf-seg-item-active")}>
            {item.label}
            {item.id === "review" && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{review.length}</span>}
          </button>
        ))}
      </div>
      {loading && !edges.length ? (
        <div className="lf-empty flex min-h-72 items-center justify-center text-sm">
          <Loader2 size={16} className="mr-2 animate-spin" />
          正在读取网络数据…
        </div>
      ) : tab === "overview" ? (
        <Overview edges={edges} setTab={setTab} setStatus={setStatus} />
      ) : tab === "review" ? (
        <div className="lf-card rounded-2xl">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/60 p-4">
            <label className="text-xs">
              <input type="checkbox" checked={review.length > 0 && review.every((edge) => selected.has(edge.id))} onChange={(e) => setSelected(e.target.checked ? new Set(review.map((edge) => edge.id)) : new Set())} /> 全选
            </label>
            <span className="text-xs text-ink-muted">当前仅供查看候选边；审核、反转和同步操作暂不开放。</span>
          </div>
          <EdgeTable
            edges={review}
            names={categories}
            onOpen={setDetail}
            selected={selected}
            onSelect={(id, checked) =>
              setSelected((current) => {
                const next = new Set(current);
                checked ? next.add(id) : next.delete(id);
                return next;
              })
            }
          />
        </div>
      ) : tab === "edges" ? (
        <div className="lf-card rounded-2xl">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/60 p-4">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="lf-select w-auto">
              <option value="">全部状态</option>
              {["active", "proposed", "needs_review", "rejected", "deprecated", "redundant"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)} className="lf-select w-auto">
              <option value="">全部类型</option>
              {Object.keys(typeLabel).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索知识点名称" className="lf-input w-52" />
            <span className="text-xs text-ink-muted">{filtered.length} 条</span>
          </div>
          <EdgeTable edges={filtered} names={categories} onOpen={setDetail} />
        </div>
      ) : tab === "builder" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <SimpleChapterCanvas
            categories={categories}
            edges={edges}
            sourceId={builderSourceId}
            targetId={builderTargetId}
            onPick={handleBuilderPick}
          />
          <DagQuickBuilder
            categories={categories}
            edges={edges}
            onSaved={refresh}
            sourceId={builderSourceId}
            targetId={builderTargetId}
            onSourceIdChange={setBuilderSourceId}
            onTargetIdChange={setBuilderTargetId}
          />
        </div>
      ) : (
        <GraphCanvas edges={edges} categories={categories} />
      )}
      {detail && <EdgeDetails edge={detail} names={categories} onClose={() => setDetail(null)} onAction={(kind) => void action(kind, [detail.id])} />}
    </>
  );
}
