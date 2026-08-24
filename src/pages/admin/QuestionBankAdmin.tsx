import { useCallback, useEffect, useState } from "react";
import { FileUp, Loader2, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { adminKnowledgeApi, type QuestionRecord } from "@/lib/adminKnowledgeApi";

const statusText: Record<string, string> = {
  proposed: "待审核",
  active: "已发布",
  rejected: "已拒绝",
  deprecated: "已下架",
};

const statusPill: Record<string, string> = {
  proposed: "lf-pill lf-pill-warn",
  active: "lf-pill lf-pill-ok",
  rejected: "lf-pill lf-pill-danger",
  deprecated: "lf-pill lf-pill-null",
};

export default function QuestionBankAdmin({ categoryId, scopeLabel }: { categoryId?: number; scopeLabel?: string } = {}) {
  const [items, setItems] = useState<QuestionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QuestionRecord | null>(null);
  const [stem, setStem] = useState("");
  const [answer, setAnswer] = useState(true);
  const [explanation, setExplanation] = useState("");
  const [difficulty, setDifficulty] = useState(3);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminKnowledgeApi.questions({ status, keyword, categoryId });
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "题库读取失败");
    } finally {
      setLoading(false);
    }
  }, [categoryId, keyword, status]);
  useEffect(() => {
    void load();
  }, [load]);
  const review = async (item: QuestionRecord, next: "active" | "rejected" | "deprecated") => {
    try {
      if (next === "deprecated") await adminKnowledgeApi.deprecateQuestion(item.id);
      else await adminKnowledgeApi.reviewQuestion(item.id, next);
      toast.success("题目状态已更新");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  };
  const openCreate = () => {
    setEditing(null);
    setStem("");
    setAnswer(true);
    setExplanation("");
    setDifficulty(3);
    setCreating(true);
  };
  const openEdit = (item: QuestionRecord) => {
    setEditing(item);
    setStem(item.stem);
    setAnswer(Boolean(item.reference_answer));
    setExplanation(item.explanation || "");
    setDifficulty(item.difficulty);
    setCreating(true);
  };
  const save = async () => {
    if (!stem.trim()) return;
    try {
      const payload = {
        question_type: "true_false",
        difficulty,
        cognitive_level: "understand",
        stem: stem.trim(),
        reference_answer: answer,
        explanation: explanation.trim() || null,
        status: "proposed",
        source_type: "human",
        created_by: "admin",
      };
      if (editing) await adminKnowledgeApi.updateQuestion(editing.id, payload);
      else await adminKnowledgeApi.createQuestion(payload);
      toast.success(editing ? "题目已更新" : "题目已创建并进入待审核队列");
      setCreating(false);
      setStem("");
      setExplanation("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建失败");
    }
  };
  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error("导入文件根节点必须是题目数组");
      const result = await adminKnowledgeApi.importQuestions(parsed as Record<string, unknown>[]);
      toast.success(`导入完成：新增 ${result.created.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败");
    }
  };
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">题库管理</h2>
          <p className="mt-1 text-sm text-ink-muted">{scopeLabel ? `${scopeLabel} · ` : ""}人工维护、审核、发布和下架；AI 出题当前未开放。</p>
        </div>
        <div className="flex gap-2">
          <label className="lf-row-btn cursor-pointer">
            <FileUp size={14} />
            导入 JSON
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                void importJson(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <button onClick={openCreate} className="lf-row-btn lf-row-btn-primary">
            <Plus size={14} />
            新增题目
          </button>
        </div>
      </div>
      <div className="lf-card mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索题干" className="lf-input min-w-56 flex-1" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="lf-select w-auto">
          <option value="">全部状态</option>
          <option value="proposed">待审核</option>
          <option value="active">已发布</option>
          <option value="rejected">已拒绝</option>
          <option value="deprecated">已下架</option>
        </select>
        <span className="lf-pill lf-pill-null self-center">共 {total} 题</span>
      </div>
      <div className="lf-table-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3.5">题干</th>
                <th className="px-4 py-3.5">题型</th>
                <th className="px-4 py-3.5">难度</th>
                <th className="px-4 py-3.5">状态</th>
                <th className="px-4 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="max-w-xl px-4 py-3.5">
                    <p className="line-clamp-2 font-semibold text-ink">{item.stem}</p>
                    <p className="mt-1 text-[11px] text-ink-muted">#{item.id} · {item.cognitive_level}</p>
                  </td>
                  <td className="px-4 py-3.5 text-ink-2">{item.question_type}</td>
                  <td className="px-4 py-3.5 tabular-nums text-ink">{item.difficulty}/5</td>
                  <td className="px-4 py-3.5">
                    <span className={statusPill[item.status] || "lf-pill lf-pill-null"}>{statusText[item.status] || item.status}</span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button onClick={() => openEdit(item)} className="lf-row-btn">
                        <Pencil size={11} />
                        编辑
                      </button>
                      {item.status === "proposed" && (
                        <>
                          <button onClick={() => void review(item, "active")} className="lf-row-btn lf-row-btn-primary">
                            通过
                          </button>
                          <button onClick={() => void review(item, "rejected")} className="lf-row-btn lf-row-btn-danger">
                            拒绝
                          </button>
                        </>
                      )}
                      {item.status === "active" && (
                        <button onClick={() => void review(item, "deprecated")} className="lf-row-btn text-ink-muted">
                          下架
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && (
          <div className="flex justify-center py-12 text-sm text-ink-muted">
            <Loader2 className="mr-2 animate-spin" size={16} />
            加载中…
          </div>
        )}
        {!loading && !items.length && <div className="lf-empty m-4 py-12 text-center text-sm">当前目录暂无题目</div>}
      </div>
      {creating && (
        <div className="lf-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="lf-glass w-full max-w-lg rounded-2xl">
            <div className="flex items-center justify-between border-b border-white/60 px-5 py-4">
              <h3 className="font-bold text-ink">{editing ? "编辑判断题" : "新增判断题"}</h3>
              <button onClick={() => setCreating(false)} className="rounded-lg p-1.5 text-ink-muted hover:bg-white/60">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-2">题干</span>
                <textarea value={stem} onChange={(e) => setStem(e.target.value)} rows={4} className="lf-textarea" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-ink-2">正确答案</span>
                  <select value={String(answer)} onChange={(e) => setAnswer(e.target.value === "true")} className="lf-select">
                    <option value="true">正确</option>
                    <option value="false">错误</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-ink-2">难度</span>
                  <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))} className="lf-select">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-2">解析</span>
                <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={3} className="lf-textarea" />
              </label>
            </div>
            <div className="flex justify-end gap-2 rounded-b-2xl bg-white/40 px-5 py-3.5">
              <button onClick={() => setCreating(false)} className="lf-row-btn">
                取消
              </button>
              <button onClick={() => void save()} className="lf-row-btn lf-row-btn-primary">
                {editing ? "保存修改" : "创建待审题"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
