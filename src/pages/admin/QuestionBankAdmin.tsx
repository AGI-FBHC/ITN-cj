import { useCallback, useEffect, useState } from "react";
import { FileUp, Loader2, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  adminKnowledgeApi,
  type QuestionRecord,
} from "@/lib/adminKnowledgeApi";

const statusText: Record<string, string> = {
  proposed: "待审核",
  active: "已发布",
  rejected: "已拒绝",
  deprecated: "已下架",
};

export default function QuestionBankAdmin() {
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
      const result = await adminKnowledgeApi.questions({ status, keyword });
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "题库读取失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, status]);
  useEffect(() => {
    void load();
  }, [load]);
  const review = async (
    item: QuestionRecord,
    next: "active" | "rejected" | "deprecated",
  ) => {
    try {
      if (next === "deprecated")
        await adminKnowledgeApi.deprecateQuestion(item.id);
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
      if (!Array.isArray(parsed))
        throw new Error("导入文件根节点必须是题目数组");
      const result = await adminKnowledgeApi.importQuestions(
        parsed as Record<string, unknown>[],
      );
      toast.success(
        `导入完成：新增 ${result.created.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败");
    }
  };
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">题库管理</h2>
          <p className="mt-1 text-sm text-slate-500">
            人工维护、审核、发布和下架；AI 出题与练习功能当前未开放。
          </p>
        </div>
        <div className="flex gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-xs font-medium">
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
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white"
          >
            <Plus size={14} />
            新增题目
          </button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2 border border-slate-200 bg-white p-3">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索题干"
          className="h-9 min-w-56 flex-1 rounded border border-slate-300 px-3 text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded border border-slate-300 px-3 text-sm"
        >
          <option value="">全部状态</option>
          <option value="proposed">待审核</option>
          <option value="active">已发布</option>
          <option value="rejected">已拒绝</option>
          <option value="deprecated">已下架</option>
        </select>
        <span className="self-center text-xs text-slate-500">
          共 {total} 题
        </span>
      </div>
      <div className="overflow-x-auto border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">题干</th>
              <th className="px-4 py-3">题型</th>
              <th className="px-4 py-3">难度</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="max-w-xl px-4 py-3">
                  <p className="line-clamp-2 font-medium text-slate-800">
                    {item.stem}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    #{item.id} · {item.cognitive_level}
                  </p>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {item.question_type}
                </td>
                <td className="px-4 py-3">{item.difficulty}/5</td>
                <td className="px-4 py-3">
                  {statusText[item.status] || item.status}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => openEdit(item)}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                    >
                      <Pencil size={11} />
                      编辑
                    </button>
                    {item.status === "proposed" && (
                      <>
                        <button
                          onClick={() => void review(item, "active")}
                          className="rounded border border-emerald-300 px-2.5 py-1.5 text-xs text-emerald-700"
                        >
                          通过
                        </button>
                        <button
                          onClick={() => void review(item, "rejected")}
                          className="rounded border border-red-200 px-2.5 py-1.5 text-xs text-red-600"
                        >
                          拒绝
                        </button>
                      </>
                    )}
                    {item.status === "active" && (
                      <button
                        onClick={() => void review(item, "deprecated")}
                        className="rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      >
                        下架
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && (
          <div className="flex justify-center py-12 text-sm text-slate-500">
            <Loader2 className="mr-2 animate-spin" size={16} />
            加载中…
          </div>
        )}
      </div>
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-lg border bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h3 className="font-semibold">
                {editing ? "编辑判断题" : "新增判断题"}
              </h3>
              <button onClick={() => setCreating(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <label className="block text-xs text-slate-600">
                题干
                <textarea
                  value={stem}
                  onChange={(e) => setStem(e.target.value)}
                  rows={4}
                  className="mt-1.5 w-full rounded border border-slate-300 p-3 text-sm"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-600">
                  正确答案
                  <select
                    value={String(answer)}
                    onChange={(e) => setAnswer(e.target.value === "true")}
                    className="mt-1.5 h-10 w-full rounded border px-3 text-sm"
                  >
                    <option value="true">正确</option>
                    <option value="false">错误</option>
                  </select>
                </label>
                <label className="text-xs text-slate-600">
                  难度
                  <select
                    value={difficulty}
                    onChange={(e) => setDifficulty(Number(e.target.value))}
                    className="mt-1.5 h-10 w-full rounded border px-3 text-sm"
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-xs text-slate-600">
                解析
                <textarea
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  rows={3}
                  className="mt-1.5 w-full rounded border border-slate-300 p-3 text-sm"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t bg-slate-50 px-5 py-3">
              <button
                onClick={() => setCreating(false)}
                className="rounded border px-4 py-2 text-xs"
              >
                取消
              </button>
              <button
                onClick={() => void save()}
                className="rounded bg-blue-600 px-4 py-2 text-xs text-white"
              >
                {editing ? "保存修改" : "创建待审题"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
