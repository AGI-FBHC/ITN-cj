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
import { api, type RagDomain } from "@/lib/api";
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
const input = "mt-1.5 w-full lf-input";

export default function DocumentIngestion() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [yamlDomains, setYamlDomains] = useState<PredealDomain[]>([]);
  const [domain, setDomain] = useState("");
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
    /* 归属领域用知识领域（code 决定 RAGFlow 数据集名 {code}_v1）；
       predeal 的 YAML 配置只用来挑选底层流水线。 */
    void Promise.allSettled([
      api.listRagDomains(),
      adminKnowledgeApi.predealDomains(),
    ]).then(([knowledge, predeal]) => {
      if (knowledge.status === "fulfilled") {
        setDomains(knowledge.value);
        setDomain((current) => current || knowledge.value[0]?.code || "");
      } else {
        toast.error("知识领域读取失败");
      }
      if (predeal.status === "fulfilled") setYamlDomains(predeal.value.domains);
    });
  }, []);
  useEffect(() => {
    void loadHistory();
  }, []);
  useEffect(() => {
    if (result?.status !== "failed") return;
    setEvents((current) => {
      const next: Record<string, PredealProgressEvent> = {};
      Object.entries(current).forEach(([key, event]) => {
        next[key] =
          event.status === "start" ? { ...event, status: "failed" } : event;
      });
      return next;
    });
  }, [result]);
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
    throw new Error("文档入库任务等待超时");
  };
  const submit = async () => {
    if (!file) return toast.error("请选择 Markdown 文件");
    if (!domain) return toast.error("请选择归属领域");
    const form = new FormData();
    form.append("file", file);
    /* 有同名 YAML 的领域走专属流水线，其余统一走 custom_ingest 暂存后按标题绑定 */
    const pipelineDomain =
      yamlDomains.find((item) => item.code === domain)?.id || "custom_ingest";
    const domainLabel = domains.find((item) => item.code === domain)?.name || domain;
    form.append("domain", pipelineDomain);
    form.append("domain_code", domain);
    form.append("domain_name", domainLabel);
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
      dataset_name: datasetName.trim() || `${domainLabel}_v1`,
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
      toast.success("文档入库任务已结束");
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
        <h2 className="text-2xl font-bold tracking-tight text-ink">文档入库</h2>
        <p className="mt-1 text-sm text-ink-muted">
          文档切片入库 v2：幂等上传、增量切片、图片处理、知识点分类与 RAGFlow
          同步。
        </p>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,.85fr)]">
        <section className="lf-card rounded-2xl">
          <div className="border-b border-white/60 px-5 py-4">
            <h3 className="text-sm font-semibold">文件与入库参数</h3>
            <p className="mt-1 text-xs text-ink-muted">
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
              className="flex min-h-32 w-full flex-col items-center justify-center border border-dashed border-ochre/40 bg-white/50 text-sm text-ink-muted transition-colors hover:border-ochre/70 hover:bg-ochre-tint/40"
            >
              <UploadCloud size={25} className="mb-2 text-ink-muted" />
              {file ? (
                <>
                  <strong className="text-ink">{file.name}</strong>
                  <span className="mt-1 text-xs">
                    {Math.ceil(file.size / 1024)} KB
                  </span>
                </>
              ) : (
                <>
                  <span>点击或拖入 Markdown 文件</span>
                  <span className="mt-1 text-xs text-ink-muted">
                    仅支持 .md / .markdown
                  </span>
                </>
              )}
            </button>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-xs text-ink-2">
                归属领域 *
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className={input}
                >
                  {domains.length ? (
                    domains.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.name} · {item.code}
                      </option>
                    ))
                  ) : (
                    <option value={domain}>{domain || "暂无领域"}</option>
                  )}
                </select>
              </label>
              <label className="text-xs text-ink-2">
                标题
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                文档类型
                <input
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  placeholder="留空使用领域默认值"
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                来源类型
                <input
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                来源名称
                <input
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                出版 / 发布组织
                <input
                  value={publisher}
                  onChange={(e) => setPublisher(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                发布年份
                <input
                  value={publishYear}
                  onChange={(e) => setPublishYear(e.target.value)}
                  type="number"
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                版本
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
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
              <label className="text-xs text-ink-2">
                语言
                <input
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                存储前缀
                <input
                  value={storagePrefix}
                  onChange={(e) => setStoragePrefix(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-xs text-ink-2">
                RAGFlow 数据集名
                <input
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                  placeholder={`留空使用 ${domains.find((item) => item.code === domain)?.name || domain || "领域"}_v1`}
                  className={input}
                />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-5 border-y border-white/60 py-4 text-xs text-ink-2">
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
              className="lf-btn-primary mt-5 h-10 w-full disabled:opacity-50"
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
            <p className="mt-3 text-xs leading-5 text-ink-muted">
              同名同内容会走幂等复用；同名不同内容按原实现执行增量更新。接口密钥由服务端环境读取，不在浏览器表单中传输。
            </p>
          </div>
        </section>
        <section className="lf-card rounded-2xl">
          <div className="border-b border-white/60 px-5 py-4">
            <h3 className="text-sm font-semibold">处理进度</h3>
            <p className="mt-1 text-xs text-ink-muted">
              {taskId ? `任务 ${taskId}` : "提交文档后显示 13 步流水线"}
            </p>
          </div>
          <ol className="divide-y divide-white/60">
            {steps.map(([key, label]) => {
              const event = events[key];
              const state = event?.status;
              const done =
                state === "completed" ||
                state === "done" ||
                state === "success" ||
                state === "end";
              const failed = state === "failed" || state === "error";
              const running =
                state === "running" ||
                state === "started" ||
                state === "start";
              return (
                <li key={key} className="flex items-start gap-3 px-5 py-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                      done
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : failed
                          ? "border-red-500 bg-red-50 text-red-600"
                          : running
                            ? "lf-seg-item-active"
                            : "lf-seg-item",
                    )}
                  >
                    {done ? (
                      <Check size={12} />
                    ) : failed ? (
                      <XCircle size={12} />
                    ) : running ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      steps.findIndex((item) => item[0] === key) + 1
                    )}
                  </span>
                  <span>
                    <span className="block text-xs font-medium text-ink">
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-ink-muted">
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
                  <dt className="text-ink-muted">文档编号</dt>
                  <dd className="mt-1 font-mono">
                    {result.document_id || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">数据库 ID</dt>
                  <dd className="mt-1">{result.db_document_id || "—"}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">切片</dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {result.chunk_count || 0}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">图片</dt>
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
      <section className="lf-card mt-5 rounded-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">本机构入库任务</h3>
            <p className="mt-1 text-xs text-ink-muted">
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
            <thead>
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
                    <p className="max-w-xs truncate font-medium text-ink">
                      {task.file_name}
                    </p>
                    <p className="font-mono text-[10px] text-ink-muted">
                      {task.id}
                    </p>
                  </td>
                  <td className="px-4 py-3">{task.domain}</td>
                  <td className="px-4 py-3">
                    <p>{task.status}</p>
                    <p className="text-[10px] text-ink-muted">
                      {task.current_stage || "—"}
                    </p>
                    {task.error_message && (
                      <p className="mt-1 max-w-xs truncate text-red-600">
                        {task.error_message}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">{task.progress ?? 0}%</td>
                  <td className="px-4 py-3 text-ink-muted">
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
            <p className="py-8 text-center text-sm text-ink-muted">
              暂无入库任务
            </p>
          )}
        </div>
      </section>
    </>
  );
}
