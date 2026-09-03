
import { useCallback, useMemo, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { BookCheck, ChevronDown, ChevronRight, ClipboardList, Database, FileUp, LayoutDashboard, Loader2, LogOut, Network, RefreshCw, Settings, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api, type LearnerProfileData, type RagDomain, type RagTree, type RagTreeNode } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useCachedData } from "@/hooks/useCachedData";
import { cn } from "@/lib/utils";
import { adminKnowledgeApi, type KcSearchResult } from "@/lib/adminKnowledgeApi";
import KnowledgeQuality from "@/pages/admin/KnowledgeQuality";
import KnowledgeGraphAdmin from "@/pages/admin/KnowledgeGraphAdmin";
import DocumentIngestion from "@/pages/admin/DocumentIngestion";
import OrganizationSettings from "@/pages/admin/OrganizationSettings";
import InstitutionUsers from "@/pages/admin/InstitutionUsers";
import ResourceCenterAdmin from "@/pages/admin/ResourceCenterAdmin";
import CollaborationWorkbench from "@/pages/CollaborationWorkbench";

type AdminSection = "overview" | "organization" | "learners" | "knowledge" | "quality" | "graph" | "resources" | "workbench" | "ingestion";
const nav: { id: AdminSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "工作台", icon: LayoutDashboard },
  { id: "organization", label: "机构配置", icon: Settings },
  { id: "learners", label: "机构用户", icon: Users },
  { id: "knowledge", label: "知识库管理", icon: Database },
  { id: "quality", label: "知识质量", icon: BookCheck },
  { id: "graph", label: "知识图谱", icon: Network },
  { id: "resources", label: "资源中心", icon: ClipboardList },
  { id: "workbench", label: "AI 教研工作台", icon: Sparkles },
  { id: "ingestion", label: "文档入库", icon: FileUp },
];

function StatusTag({ ok = true, children }: { ok?: boolean; children: string }) {
  return (
    <span className={cn("lf-pill", ok ? "lf-pill-ok" : "lf-pill-warn")}>
      <span className="lf-pill-dot" />
      {children}
    </span>
  );
}

function StatCard({ label, value, note, className }: { label: string; value: string | number; note: string; className?: string }) {
  return (
    <div className={cn("lf-stat-card", className)}>
      <p className="lf-stat-label">{label}</p>
      <div>
        <p className="lf-stat-value">{value}</p>
        <p className="lf-stat-note">{note}</p>
      </div>
    </div>
  );
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function LearnerTable({ learners, onEdit }: { learners: LearnerProfileData[]; onEdit: (learner: LearnerProfileData) => void }) {
  if (!learners.length) return <div className="lf-empty px-6 py-14 text-center text-sm">暂无可管理的学习者记录</div>;
  return (
    <div className="lf-table-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th className="px-4 py-3.5">姓名 / 编号</th>
              <th className="px-4 py-3.5">身份</th>
              <th className="px-4 py-3.5">目标方向</th>
              <th className="px-4 py-3.5">掌握度</th>
              <th className="px-4 py-3.5">更新时间</th>
              <th className="px-4 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {learners.map((learner) => (
              <tr key={learner.id}>
                <td className="px-4 py-3.5">
                  <div className="font-semibold text-ink">{learner.name || "未命名"}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{learner.code || learner.id.slice(0, 8)}</div>
                </td>
                <td className="px-4 py-3.5 text-ink-2">{learner.role || "未设置"}</td>
                <td className="px-4 py-3.5 text-ink-2">{learner.targetJob || learner.education || "未设置"}</td>
                <td className="px-4 py-3.5 tabular-nums text-ink">{Math.round(learner.overallMastery || 0)}%</td>
                <td className="px-4 py-3.5 text-xs text-ink-muted">{learner.updatedAt ? new Date(learner.updatedAt).toLocaleDateString("zh-CN") : "—"}</td>
                <td className="px-4 py-3.5 text-right">
                  <button type="button" onClick={() => onEdit(learner)} className="lf-row-btn">
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditLearner({ learner, onClose, onSaved }: { learner: LearnerProfileData; onClose: () => void; onSaved: (learner: LearnerProfileData) => void }) {
  const [name, setName] = useState(learner.name || "");
  const [role, setRole] = useState(learner.role || "");
  const [targetJob, setTargetJob] = useState(learner.targetJob || "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      onSaved(await api.updateLearner(learner.id, { name, role, targetJob }));
      toast.success("学习者信息已保存");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const fields: [string, string, (value: string) => void][] = [
    ["姓名", name, setName],
    ["角色", role, setRole],
    ["目标方向", targetJob, setTargetJob],
  ];
  return (
    <div className="lf-overlay fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="lf-glass w-full max-w-md rounded-2xl">
        <div className="flex items-center justify-between border-b border-white/60 px-5 py-4">
          <h2 className="text-base font-bold text-ink">编辑学习者</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-muted hover:bg-white/60">
            <X size={17} />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {fields.map(([label, value, setter]) => (
            <label key={label} className="block">
              <span className="mb-1.5 block text-xs font-semibold text-ink-2">{label}</span>
              <input value={value} onChange={(event) => setter(event.target.value)} className="lf-input" />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 rounded-b-2xl bg-white/40 px-5 py-3.5">
          <button type="button" onClick={onClose} className="lf-row-btn">
            取消
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function flattenVisibleTree(nodes: RagTreeNode[], expanded: Set<number>, depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(expanded.has(node.id) ? flattenVisibleTree(node.children || [], expanded, depth + 1) : [])]);
}

function DomainDetail({ tree, loading, error, onBack }: { tree: RagTree | null; loading: boolean; error: string | null; onBack: () => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [chunkNode, setChunkNode] = useState<RagTreeNode | null>(null);
  const [chunkResult, setChunkResult] = useState<KcSearchResult | null>(null);
  const [chunksLoading, setChunksLoading] = useState(false);
  const openChunks = async (node: RagTreeNode) => {
    if (!tree) return;
    setChunkNode(node);
    setChunksLoading(true);
    setChunkResult(null);
    try {
      setChunkResult(
        await adminKnowledgeApi.search({
          knowledgePoint: node.name,
          domain: tree.domain.code,
          categoryId: node.id,
          thresholdMode: "fixed",
          includeRag: false,
          includePrerequisites: false,
          includeContrasts: false,
          expandContext: false,
          limit: 30,
        }),
      );
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "切片读取失败");
    } finally {
      setChunksLoading(false);
    }
  };
  if (loading)
    return (
      <div className="lf-empty flex min-h-[320px] items-center justify-center text-sm">
        <Loader2 size={16} className="mr-2 animate-spin" />
        正在读取领域结构…
      </div>
    );
  if (error || !tree)
    return (
      <div className="lf-card rounded-2xl border-red-200/70 p-5 text-sm text-brand-danger">
        <button type="button" onClick={onBack} className="lf-row-btn mb-3 block">
          返回领域列表
        </button>
        {error || "领域数据不存在"}
      </div>
    );
  const rows = flattenVisibleTree(tree.nodes, expanded);
  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-xs text-ink-muted">
        <button type="button" onClick={onBack} className="lf-row-btn">
          知识库管理
        </button>
        <ChevronRight size={13} />
        <span className="font-semibold text-ink">{tree.domain.name}</span>
      </div>
      <PageHeading title={tree.domain.name} description={tree.domain.description || `领域代码：${tree.domain.code}`} action={<StatusTag>正常</StatusTag>} />
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="分类" value={tree.domain.categoryCount} note="目录节点" />
        <StatCard label="知识点" value={tree.totalKnowledgePoints} note="领域总量" />
        <StatCard label="文档" value={tree.domain.documentCount} note="已入库文档" />
        <StatCard label="知识切片" value={tree.totalChunks} note="可检索内容" />
        <StatCard label="图片" value={tree.domain.figureCount} note="图像资产" className="col-span-2 md:col-span-1" />
      </div>
      <div className="lf-table-card">
        <div className="flex items-center justify-between border-b border-white/60 px-5 py-4">
          <div>
            <h3 className="text-sm font-bold text-ink">分类结构</h3>
            <p className="mt-0.5 text-xs text-ink-muted">共 {tree.domain.categoryCount} 个目录节点，点击箭头按层展开</p>
          </div>
          <button type="button" disabled className="lf-row-btn hidden cursor-not-allowed opacity-40 sm:block">
            新增分类
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3">分类名称</th>
                <th className="hidden px-4 py-3 md:table-cell">节点代码</th>
                <th className="hidden px-4 py-3 md:table-cell">类型</th>
                <th className="w-20 px-4 py-3 text-right">切片数</th>
                <th className="w-24 px-4 py-3 text-right">切片</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, depth }) => (
                <tr
                  key={node.id}
                  onClick={() => void openChunks(node)}
                  title="点击查看该节点的知识切片"
                  className={cn("cursor-pointer transition-colors", chunkNode?.id === node.id ? "bg-brand-tint/50" : "hover:bg-brand-tint/30")}
                >
                  <td className="px-4 py-3.5">
                    <div className="flex min-w-0 items-center" style={{ paddingLeft: Math.min(depth, 3) * 18 }}>
                      {node.children?.length ? (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); toggle(node.id); }}
                          className="mr-1.5 shrink-0 rounded p-0.5 text-ink-muted hover:bg-brand-tint hover:text-brand"
                          aria-label={expanded.has(node.id) ? "收起分类" : "展开分类"}
                        >
                          {expanded.has(node.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      ) : (
                        <span className="mr-1.5 w-[18px] shrink-0" />
                      )}
                      <span className="truncate font-semibold text-ink">{node.name}</span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3.5 font-mono text-xs text-ink-muted md:table-cell">{node.nodeCode}</td>
                  <td className="hidden px-4 py-3.5 text-xs text-ink-muted md:table-cell">{node.nodeType}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{node.chunkCount ?? 0}</td>
                  <td className="px-4 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); void openChunks(node); }}
                      className={cn("lf-row-btn", chunkNode?.id === node.id && "lf-row-btn-primary")}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <div className="lf-empty m-4 py-10 text-center text-sm">该领域暂无分类结构</div>}
      </div>

      {chunkNode && (
        <div className="lf-anim-in-up mt-4">
          <div className="lf-card rounded-2xl">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/60 px-5 py-4">
              <h3 className="mr-auto text-sm font-bold text-ink">知识切片 · {chunkNode.name}</h3>
              {chunkResult && (
                <>
                  <span className={cn("lf-pill", chunkResult.decision === "mysql" ? "lf-pill-ok" : chunkResult.decision === "parent" ? "lf-pill-warn" : chunkResult.decision === "rag" ? "lf-pill-null" : "lf-pill-danger")}>
                    {chunkResult.decision === "mysql" ? "精确命中" : chunkResult.decision === "parent" ? "章节上卷" : chunkResult.decision === "rag" ? "RAG 兜底" : "无结果"}
                  </span>
                  <span className="lf-pill lf-pill-null">{chunkResult.chunks.length} 条切片</span>
                </>
              )}
            </div>
            {chunksLoading ? (
              <div className="flex items-center justify-center py-12 text-sm text-ink-muted">
                <Loader2 size={16} className="mr-2 animate-spin" />
                正在读取切片…
              </div>
            ) : chunkResult ? (
              chunkResult.chunks.length ? (
                <div className="divide-y divide-white/50">
                  {chunkResult.chunks.map((hit, index) => (
                    <div key={hit.chunk_id ?? index} className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-ink-muted">{hit.chunk_code}</span>
                        <span className={cn("lf-pill", hit.source === "mysql" ? "lf-pill-ok" : hit.source === "parent" ? "lf-pill-warn" : "lf-pill-null")}>
                          {hit.source === "mysql" ? "精确挂载" : hit.source === "parent" ? "章节上卷" : hit.source}
                        </span>
                        {hit.confidence != null && <span className="lf-pill lf-pill-null">置信 {Math.round(hit.confidence * 100)}%</span>}
                        {hit.relation_type && <span className="lf-pill lf-pill-null">{hit.relation_type}</span>}
                      </div>
                      <p className="mt-2 text-[13px] font-semibold text-ink">{hit.section_title || "（无小节标题）"}</p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-muted">{hit.title_path}</p>
                      <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] leading-6 text-ink-2">{hit.content.trim()}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="lf-empty px-6 py-10 text-center text-sm">
                  {chunkNode.children?.length ? "该分类暂无可展示切片（切片挂载在叶子知识点上，可点击子节点查看）" : "该知识点暂无切片"}
                </div>
              )
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function KnowledgeManagement({ domains }: { domains: RagDomain[] }) {
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [tree, setTree] = useState<RagTree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const filtered = useMemo(() => domains.filter((item) => `${item.name} ${item.code}`.toLowerCase().includes(query.trim().toLowerCase())), [domains, query]);
  const openDomain = async (code: string) => {
    setSelectedCode(code);
    setTree(null);
    setTreeError(null);
    setTreeLoading(true);
    try {
      setTree(await api.getRagTree(code));
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : "领域结构读取失败");
    } finally {
      setTreeLoading(false);
    }
  };
  if (selectedCode)
    return (
      <DomainDetail
        tree={tree}
        loading={treeLoading}
        error={treeError}
        onBack={() => {
          setSelectedCode(null);
          setTree(null);
        }}
      />
    );
  return (
    <>
      <PageHeading title="知识库管理" description="管理知识领域、分类结构和入库内容。" />
      <div className="lf-card mb-5 flex items-center justify-between gap-3 rounded-2xl p-3.5">
        <div className="w-full max-w-xs">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索领域名称或代码" className="lf-input" />
        </div>
        <button type="button" disabled className="lf-row-btn hidden cursor-not-allowed opacity-40 sm:block">
          新建领域
        </button>
      </div>
      <div className="space-y-3 md:hidden">
        {filtered.map((domain) => (
          <button key={domain.code} type="button" onClick={() => void openDomain(domain.code)} className="lf-card w-full rounded-2xl p-4 text-left lf-card-hover">
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate font-bold text-ink">{domain.name}</span>
                <span className="mt-1 block line-clamp-2 text-xs leading-5 text-ink-muted">{domain.description || "暂无说明"}</span>
              </span>
              <StatusTag>正常</StatusTag>
            </span>
            <span className="mt-4 grid grid-cols-4 rounded-xl bg-white/50 py-3 text-center">
              <span>
                <span className="block text-base font-bold tabular-nums text-ink">{domain.categoryCount}</span>
                <span className="text-[11px] text-ink-muted">分类</span>
              </span>
              <span>
                <span className="block text-base font-bold tabular-nums text-ink">{domain.knowledgePointCount}</span>
                <span className="text-[11px] text-ink-muted">知识点</span>
              </span>
              <span>
                <span className="block text-base font-bold tabular-nums text-ink">{domain.documentCount}</span>
                <span className="text-[11px] text-ink-muted">文档</span>
              </span>
              <span>
                <span className="block text-base font-bold tabular-nums text-ink">{domain.chunkCount}</span>
                <span className="text-[11px] text-ink-muted">切片</span>
              </span>
            </span>
            <span className="mt-3 flex items-center justify-between">
              <span className="font-mono text-xs text-ink-muted">{domain.code}</span>
              <span className="flex items-center gap-1 text-xs font-semibold text-brand">
                查看详情
                <ChevronRight size={13} />
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="lf-table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3.5">领域名称</th>
                <th className="px-4 py-3.5">领域代码</th>
                <th className="px-4 py-3.5 text-right">分类</th>
                <th className="px-4 py-3.5 text-right">知识点</th>
                <th className="px-4 py-3.5 text-right">文档</th>
                <th className="px-4 py-3.5 text-right">切片</th>
                <th className="px-4 py-3.5">状态</th>
                <th className="px-4 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((domain) => (
                <tr key={domain.code} onDoubleClick={() => void openDomain(domain.code)} className="cursor-pointer">
                  <td className="px-4 py-3.5">
                    <button type="button" onClick={() => void openDomain(domain.code)} className="font-bold text-ink hover:text-brand">
                      {domain.name}
                    </button>
                    <p className="mt-0.5 max-w-[280px] truncate text-xs text-ink-muted">{domain.description || "暂无说明"}</p>
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-muted">{domain.code}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{domain.categoryCount}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{domain.knowledgePointCount}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{domain.documentCount}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{domain.chunkCount}</td>
                  <td className="px-4 py-3.5">
                    <StatusTag>正常</StatusTag>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <button type="button" onClick={() => void openDomain(domain.code)} className="lf-row-btn">
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {!filtered.length && <div className="lf-empty px-6 py-14 text-center text-sm">没有符合条件的知识领域</div>}
    </>
  );
}

export default function Admin() {
  const location = useLocation();
  const { session, logout } = useAuth();
  const [editing, setEditing] = useState<LearnerProfileData | null>(null);
  const section = (location.pathname.split("/")[2] as AdminSection) || "overview";
  const active = section === "workbench" || nav.some((item) => item.id === section) ? section : "overview";
  const title = active === "workbench" ? "AI 教研工作台" : nav.find((item) => item.id === active)?.label || "工作台";
  /* SWR 缓存：首次进入展示缓存 + 后台刷新；手动刷新按钮强制绕过 TTL */
  const learnersQ = useCachedData<LearnerProfileData[]>('admin:learners', () => api.listLearners(), { ttlMs: 15_000 });
  const domainsQ = useCachedData<RagDomain[]>('admin:domains', () => api.listRagDomains(), { ttlMs: 30_000 });
  const coreQ = useCachedData<boolean>('admin:health:core', async () => { try { await adminKnowledgeApi.health(); return true; } catch { return false; } }, { ttlMs: 20_000 });
  const predealQ = useCachedData<boolean>('admin:health:predeal', async () => { try { await adminKnowledgeApi.predealDomains(); return true; } catch { return false; } }, { ttlMs: 20_000 });
  const learners = learnersQ.data ?? [];
  const domains = domainsQ.data ?? [];
  const loading = learnersQ.loading && !learnersQ.data;
  const error = learnersQ.error?.message ?? domainsQ.error?.message ?? null;
  const load = useCallback(() => {
    void Promise.all([
      learnersQ.refresh(true),
      domainsQ.refresh(true),
      coreQ.refresh(true),
      predealQ.refresh(true),
    ]);
  }, [learnersQ, domainsQ, coreQ, predealQ]);
  const averageMastery = useMemo(() => (learners.length ? Math.round(learners.reduce((sum, item) => sum + (item.overallMastery || 0), 0) / learners.length) : 0), [learners]);
  return (
    <div className="lf-fade-in min-h-screen font-sans text-ink lg:h-screen lg:overflow-hidden">
      <aside className="lf-sidebar fixed inset-y-0 left-0 z-40 hidden w-60 flex-col lg:flex">
        <Link to="/admin" className="flex items-center gap-2.5 px-5 py-5">
          <img src="/logo.png" alt="智训云枢" className="h-9 w-9 rounded-xl bg-white object-contain p-1 shadow-sm" />
          <span>
            <span className="block text-[15px] font-bold leading-tight text-ink">智训云枢</span>
            <span className="mt-0.5 block text-[10px] tracking-wide text-ink-muted">后台管理系统</span>
          </span>
        </Link>
        <div className="px-6 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">业务管理</div>
        <nav className="mt-1 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {nav.map(({ id, label, icon: Icon }) => (
            <NavLink key={id} to={`/admin/${id}`} className={({ isActive }) => cn("lf-nav-pill", isActive && "lf-nav-pill-active")}>
              <Icon size={16} />
              <span className="flex-1">{label}</span>
              {id === "overview" && <span className="lf-pill lf-pill-null px-2 py-0.5 text-[10px]">首页</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/60 p-3">
          <div className="lf-card mb-2 flex items-center gap-2.5 rounded-xl px-3 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
              <ShieldCheck size={15} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-bold text-ink">系统管理员</span>
              <span className="block truncate text-[10px] text-ink-muted">{session?.account?.replace(/^admin:/, "") || "admin"}</span>
            </span>
          </div>
          <button type="button" onClick={logout} className="lf-row-btn w-full justify-center text-brand-danger hover:border-brand-danger/40">
            <LogOut size={14} />
            退出登录
          </button>
        </div>
      </aside>
      <main className="lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:pl-60">
        <header className="lf-header-bar sticky top-0 z-30 flex h-16 items-center justify-between px-4 md:px-6">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-ink-muted">管理后台 / {title}</p>
            <h1 className="mt-0.5 text-base font-bold text-ink">{title}</h1>
          </div>
          <div className="flex items-center gap-2.5">
            <StatusTag ok={!error}>{error ? "接口异常" : "服务正常"}</StatusTag>
            <button type="button" onClick={() => void load()} disabled={loading} className="lf-page-pill">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              <span className="hidden sm:inline">刷新</span>
            </button>
          </div>
        </header>
        <div className="sticky top-16 z-20 flex overflow-x-auto px-4 pb-3 pt-3 lg:hidden">
          <div className="lf-seg mx-auto">
            {nav.map(({ id, label, icon: Icon }) => (
              <NavLink key={id} to={`/admin/${id}`} className={({ isActive }) => cn("lf-seg-item", isActive && "lf-seg-item-active")}>
                <Icon size={13} />
                {label}
              </NavLink>
            ))}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1760px] min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
          {error && <div className="lf-card mb-5 rounded-2xl border-ochre/40 bg-ochre-tint/60 px-4 py-3 text-xs font-medium text-[#9A5B3C]">{error}</div>}
          {active === "overview" && (
            <>
              <PageHeading title="工作台" description="平台业务数据与服务接入概况。" />
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard label="学习者" value={loading ? "—" : learners.length} note="可管理账号" />
                <StatCard label="平均掌握度" value={loading ? "—" : `${averageMastery}%`} note="学习者平均值" />
                <StatCard label="知识领域" value={loading ? "—" : domains.length} note="已启用领域" />
                <StatCard label="知识切片" value={loading ? "—" : domains.reduce((sum, item) => sum + item.chunkCount, 0)} note="当前索引总量" />
              </div>
              <div className="lf-table-card mt-6">
                <div className="border-b border-white/60 px-5 py-4">
                  <h3 className="text-sm font-bold text-ink">模块接入状态</h3>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {([
                      ["学习者管理", true, "已接入"],
                      ["知识库读取", true, "Spring 数据接口"],
                      ["知识质量管理", coreQ.data === true, "KnowledgeCore"],
                      ["图谱审核", coreQ.data === true, "KnowledgeCore"],
                      ["文档预处理", predealQ.data === true, "predeal v2"],
                    ] as [string, boolean, string][]).map(([label, ok, detail]) => (
                      <tr key={label}>
                        <td className="px-5 py-3.5 font-semibold text-ink">{label}</td>
                        <td className="px-5 py-3.5">
                          <StatusTag ok={ok}>{ok ? "正常" : "服务未连接"}</StatusTag>
                        </td>
                        <td className="px-5 py-3.5 text-right text-xs text-ink-muted">{detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {active === "organization" && <OrganizationSettings />}
          {active === "learners" && <InstitutionUsers />}
          {active === "knowledge" && <KnowledgeManagement domains={domains} />}
          {active === "quality" && <KnowledgeQuality />}
          {active === "graph" && <KnowledgeGraphAdmin />}
          {active === "resources" && <ResourceCenterAdmin />}
          {active === "workbench" && <CollaborationWorkbench />}
          {active === "ingestion" && <DocumentIngestion />}
          {editing && <EditLearner learner={editing} onClose={() => setEditing(null)} onSaved={() => void learnersQ.refresh(true)} />}
        </div>
      </main>
    </div>
  );
}
