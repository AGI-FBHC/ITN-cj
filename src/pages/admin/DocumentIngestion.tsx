import { useEffect, useRef, useState } from "react";
import {
  Check,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  adminKnowledgeApi,
  type PredealDomain,
  type PredealProgressEvent,
  type PredealTask,
} from "@/lib/adminKnowledgeApi";
import { cn } from "@/lib/utils";

const steps = [
  ["intake", "1. 文件接入"],
  ["create_document", "2. 文档登记"],
  ["archive", "3. 原始归档"],
  ["normalizer", "4. Markdown 规范化"],
  ["image_pipeline", "5. 图片处理"],
  ["structure_parser", "6. 结构解析"],
  ["chunk_compiler", "7. 切片编译"],
  ["chunk_db_sync", "8. 切片增量同步"],
  ["category_classify", "9. 知识点分类"],
  ["ragflow_packager", "10. RAGFlow 打包"],
  ["preflight", "11. 质量检查"],
  ["audit", "12. 审计记录"],
  ["ragflow_upload", "13. RAGFlow 同步"],
] as const;
const input =
  "mt-1.5 h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-500";

export default function DocumentIngestion() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [domains, setDomains] = useState<PredealDomain[]>([]);
  const [domain, setDomain] = useState("hello_agents");
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [sourceType, setSourceType] = useState("upload");
  const [sourceName, setSourceName] = useState("");
  const [publisher, setPublisher] = useState("");
  const [publishYear, setPublishYear] = useState("");
  const [version, setVersion] = useState("");
  const [reliability, setReliability] = useState("");
  const [language, setLanguage] = useState("zh-CN");
  const [storagePrefix, setStoragePrefix] = useState("");
  const [enableRagflow, setEnableRagflow] = useState(true);
  const [datasetName, setDatasetName] = useState("");
  const [enableVlm, setEnableVlm] = useState(true);
  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [events, setEvents] = useState<Record<string, PredealProgressEvent>>(
    {},
  );
  const [result, setResult] = useState<PredealTask["result"]>(null);
  const [history, setHistory] = useState<PredealTask[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      setHistory((await adminKnowledgeApi.predealTasks()).items);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "任务历史读取失败");
    } finally {
      setHistoryLoading(false);
    }
  };
  useEffect(() => {
    adminKnowledgeApi
      .predealDomains()
      .then((data) => {
        setDomains(data.domains);
        if (
          data.domains.length &&
          !data.domains.some((item) => item.id === domain)
        )
          setDomain(data.domains[0].id);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : "领域配置读取失败"),
      );
  }, []);
  useEffect(() => {
    void loadHistory();
  }, []);
  const choose = (next: File | null) => {
    setFile(next);
    if (next && !title) setTitle(next.name.replace(/\.(md|markdown)$/i, ""));
  };
  const pollUntilDone = async (id: string) => {
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      const task = await adminKnowledgeApi.predealTask(id);
      if (
        ["completed", "partial", "failed", "cancelled"].includes(task.status)
      ) {
        setResult(task.result);
        await loadHistory();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("预处理任务等待超时");
  };
  const submit = async () => {
    if (!file) return toast.error("请选择 Markdown 文件");
    if (!domain) return toast.error("请选择归属领域");
    const form = new FormData();
    form.append("file", file);
    form.append("domain", domain);
    const values: Record<string, string> = {
      title,
      document_type: documentType,
      source_type: sourceType,
      source_name: sourceName,
      publisher,
      publish_year: publishYear,
      version,
      reliability_score: reliability,
      language,
      storage_prefix: storagePrefix,
      dataset_name: datasetName,
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value.trim()) form.append(key, value.trim());
    });
    form.append("enable_ragflow", enableRagflow ? "1" : "0");
    form.append("enable_vlm", enableVlm ? "1" : "0");
    setRunning(true);
    setEvents({});
    setResult(null);
    try {
      const created = await adminKnowledgeApi.uploadDocument(form);
      setTaskId(created.task_id);
      try {
        await adminKnowledgeApi.streamPredealProgress(
          created.task_id,
          (event) => {
            if (event.type === "progress" && event.step_name)
              setEvents((current) => ({
                ...current,
                [event.step_name!]: event,
              }));
            if (event.type === "done") setResult(event.result);
          },
        );
      } catch {
        await pollUntilDone(created.task_id);
      }
      toast.success("文档预处理任务已结束");
      await loadHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "文档入库失败");
    } finally {
      setRunning(false);
    }
  };
  const act = async (task: PredealTask, action: "cancel" | "retry") => {
    try {
      if (action === "cancel")
        await adminKnowledgeApi.cancelPredealTask(task.id);
      else await adminKnowledgeApi.retryPredealTask(task.id);
      toast.success(
        action === "cancel" ? "已请求取消任务" : "任务已重新进入队列",
      );
      await loadHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "任务操作失败");
    }
  };
  return (
    <>
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-slate-900">文档入库</h2>
        <p className="mt-1 text-sm text-slate-500">
          交付包 predeal v2：幂等上传、增量切片、图片处理、知识点分类与 RAGFlow
          同步。
        </p>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,.85fr)]">
        <section className="border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="text-sm font-semibold">文件与入库参数</h3>
            <p className="mt-1 text-xs text-slate-400">
              参数字段与 `POST /api/v1/uploads` 保持一致
            </p>
          </div>
          <div className="p-5">
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown"
              className="hidden"
              onChange={(e) => choose(e.target.files?.[0] || null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choose(e.dataTransfer.files?.[0] || null);
              }}
              className="flex min-h-32 w-full flex-col items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500 hover:border-blue-400 hover:bg-blue-50/30"
            >
              <UploadCloud size={25} className="mb-2 text-slate-400" />
              {file ? (
                <>
                  <strong className="text-slate-700">{file.name}</strong>
                  <span className="mt-1 text-xs">
                    {Math.ceil(file.size / 1024)} KB
                  </span>
                </>
              ) : (
                <>
                  <span>点击或拖入 Markdown 文件</span>
                  <span className="mt-1 text-xs text-slate-400">
                    仅支持 .md / .markdown
                  </span>
                </>
              )}
            </button>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-xs text-slate-600">
                归属领域 *
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className={input}
                >
                  {domains.length ? (
                    domains.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} · {item.profile}
                      </option>
                    ))
                  ) : (
                    <option value={domain}>{domain}</option>
                  )}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                标题
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                文档类型
                <input
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  placeholder="留空使用领域默认值"
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                来源类型
                <input
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                来源名称
                <input
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                出版 / 发布组织
                <input
                  value={publisher}
                  onChange={(e) => setPublisher(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                发布年份
                <input
                  value={publishYear}
                  onChange={(e) => setPublishYear(e.target.value)}
                  type="number"
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                版本
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                可靠性评分
                <input
                  value={reliability}
                  onChange={(e) => setReliability(e.target.value)}
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                语言
                <input
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                存储前缀
                <input
                  value={storagePrefix}
                  onChange={(e) => setStoragePrefix(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-slate-600">
                RAGFlow 数据集名
                <input
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                  placeholder="留空按领域配置"
                  className={input}
                />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-5 border-y border-slate-100 py-4 text-xs text-slate-600">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enableRagflow}
                  onChange={(e) => setEnableRagflow(e.target.checked)}
                />
                同步到 RAGFlow
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enableVlm}
                  onChange={(e) => setEnableVlm(e.target.checked)}
                />
                启用 VLM 图片描述
              </label>
            </div>
            <button
              type="button"
              disabled={running}
              onClick={() => void submit()}
              className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  正在处理
                </>
              ) : (
                <>
                  <UploadCloud size={15} />
                  开始入库
                </>
              )}
            </button>
            <p className="mt-3 text-xs leading-5 text-slate-400">
              同名同内容会走幂等复用；同名不同内容按原实现执行增量更新。接口密钥由服务端环境读取，不在浏览器表单中传输。
            </p>
          </div>
        </section>
        <section className="border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h3 className="text-sm font-semibold">处理进度</h3>
            <p className="mt-1 text-xs text-slate-400">
              {taskId ? `任务 ${taskId}` : "提交文档后显示 13 步流水线"}
            </p>
          </div>
          <ol className="divide-y divide-slate-100">
            {steps.map(([key, label]) => {
              const event = events[key];
              const state = event?.status;
              return (
                <li key={key} className="flex items-start gap-3 px-5 py-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                      state === "completed" ||
                        state === "done" ||
                        state === "success"
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : state === "failed" || state === "error"
                          ? "border-red-500 bg-red-50 text-red-600"
                          : state === "running" || state === "started"
                            ? "border-blue-500 text-blue-600"
                            : "border-slate-200 text-slate-400",
                    )}
                  >
                    {state === "completed" ||
                    state === "done" ||
                    state === "success" ? (
                      <Check size={12} />
                    ) : state === "failed" || state === "error" ? (
                      <XCircle size={12} />
                    ) : state === "running" || state === "started" ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      steps.findIndex((item) => item[0] === key) + 1
                    )}
                  </span>
                  <span>
                    <span className="block text-xs font-medium text-slate-700">
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">
                      {event?.message || "等待执行"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
          {result && (
            <div
              className={cn(
                "m-4 border p-4",
                result.status === "failed"
                  ? "border-red-200 bg-red-50"
                  : "border-emerald-200 bg-emerald-50",
              )}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileText size={15} />
                {result.reused
                  ? "文档已复用"
                  : result.status === "failed"
                    ? "处理失败"
                    : "处理完成"}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-slate-400">文档编号</dt>
                  <dd className="mt-1 font-mono">
                    {result.document_id || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">数据库 ID</dt>
                  <dd className="mt-1">{result.db_document_id || "—"}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">切片</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {result.chunk_count || 0}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">图片</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {result.figure_count || 0}
                  </dd>
                </div>
              </dl>
              {result.errors?.length ? (
                <div className="mt-3 whitespace-pre-wrap text-xs text-red-700">
                  {result.errors.join("\n")}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
      <section className="mt-5 border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">本机构入库任务</h3>
            <p className="mt-1 text-xs text-slate-400">
              持久化历史、进度与分阶段恢复
            </p>
          </div>
          <button
            onClick={() => void loadHistory()}
            className="flex items-center gap-1 rounded border px-3 py-1.5 text-xs"
          >
            <RefreshCw
              size={13}
              className={historyLoading ? "animate-spin" : ""}
            />
            刷新
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3">文件</th>
                <th className="px-4 py-3">领域</th>
                <th className="px-4 py-3">状态 / 阶段</th>
                <th className="px-4 py-3">进度</th>
                <th className="px-4 py-3">时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.map((task) => (
                <tr key={task.id}>
                  <td className="px-4 py-3">
                    <p className="max-w-xs truncate font-medium text-slate-700">
                      {task.file_name}
                    </p>
                    <p className="font-mono text-[10px] text-slate-400">
                      {task.id}
                    </p>
                  </td>
                  <td className="px-4 py-3">{task.domain}</td>
                  <td className="px-4 py-3">
                    <p>{task.status}</p>
                    <p className="text-[10px] text-slate-400">
                      {task.current_stage || "—"}
                    </p>
                    {task.error_message && (
                      <p className="mt-1 max-w-xs truncate text-red-600">
                        {task.error_message}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">{task.progress ?? 0}%</td>
                  <td className="px-4 py-3 text-slate-500">
                    {task.created_at
                      ? new Date(task.created_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {["queued", "running"].includes(task.status) && (
                      <button
                        onClick={() => void act(task, "cancel")}
                        className="mr-1 inline-flex items-center gap-1 rounded border px-2 py-1"
                      >
                        <Square size={11} />
                        取消
                      </button>
                    )}
                    {["failed", "partial", "cancelled"].includes(
                      task.status,
                    ) && (
                      <button
                        onClick={() => void act(task, "retry")}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1"
                      >
                        <RotateCcw size={11} />
                        重试
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!historyLoading && !history.length && (
            <p className="py-8 text-center text-sm text-slate-400">
              暂无入库任务
            </p>
          )}
        </div>
      </section>
    </>
  );
}
