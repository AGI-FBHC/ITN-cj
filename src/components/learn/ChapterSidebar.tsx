import { ArrowRight, BookOpen, ListChecks, PenLine, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * 章节侧栏（W2）：把旧版 LearningPath 侧栏的两块拿回来 —— 核心技能 + 推荐资源。
 *
 * 数据全部来自 useLearningMap 已经在手的那份（章节 → 知识点 → 各自资源），
 * 不新增接口：核心技能 = 该章的三级知识点（带进度/掌握/目标），推荐资源 = 这些知识点下挂的资源，
 * 按「在读 → 未学 → 已学」排序，点一行直接进资源页。
 *
 * 为什么放在地图右侧：3D 图只回答"这一章在知识网络里的位置"，
 * "这一章有什么、先学哪个"是两件不同的事，挤在同一个画布里谁都看不清。
 */

export interface SidebarTopic {
  id: string
  label: string
  progress: number
  mastery: number
  target: number
}

export interface SidebarResource {
  id: string
  type: "lecture" | "practice" | "quiz" | string
  title: string
  topic: string
  learned?: boolean
  started?: boolean
}

const typeMeta: Record<string, { label: string; Icon: typeof BookOpen; color: string }> = {
  lecture: { label: "讲义", Icon: BookOpen, color: "#4E7860" },
  practice: { label: "实操", Icon: ListChecks, color: "#B77552" },
  quiz: { label: "分阶题", Icon: PenLine, color: "#E7B45A" },
}

export default function ChapterSidebar({
  chapterName,
  chapterProgress,
  chapterMastery,
  chapterTarget,
  topics,
  resources,
  onPickTopic,
  onPickResource,
  onPickWeakest,
  loading,
  className,
}: {
  chapterName: string | null
  chapterProgress: number
  chapterMastery: number
  chapterTarget: number
  topics: SidebarTopic[]
  resources: SidebarResource[]
  onPickTopic: (topicId: string) => void
  onPickResource: (resourceId: string) => void
  onPickWeakest: () => void
  loading?: boolean
  className?: string
}) {
  const patch = (resource: SidebarResource) => {
    const meta = typeMeta[resource.type] ?? { label: resource.type, Icon: BookOpen, color: "#7A877F" }
    return (
      <button
        key={resource.id}
        type="button"
        onClick={() => onPickResource(resource.id)}
        className="group flex w-full items-start gap-3 rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors hover:border-hairline hover:bg-card-warm"
      >
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border"
          style={{ color: meta.color, borderColor: `${meta.color}40`, backgroundColor: `${meta.color}0D` }}
        >
          <meta.Icon size={14} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{resource.title}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
            {meta.label} · {resource.topic}
            {resource.learned ? " · 已学" : resource.started ? " · 在读" : ""}
          </span>
        </span>
        <ArrowRight size={13} className="mt-1.5 shrink-0 text-ink-muted/40 transition-colors group-hover:text-brand" />
      </button>
    )
  }

  return (
    <aside className={cn("flex flex-col gap-4", className)}>
      <div className="lf-card p-5">
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <Sparkles size={14} className="text-brand" />
          本章导航
        </div>
        {chapterName ? (
          <>
            <h2 className="mt-2.5 font-serif text-[18px] font-semibold leading-[26px] text-ink">{chapterName}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
              <span>进度 {chapterProgress}%</span>
              <span>掌握 {chapterMastery}%</span>
              <span>目标 {chapterTarget}%</span>
              <span>{topics.length} 个知识点</span>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2.5 text-[13px] leading-[20px] text-ink-2">
              {loading ? "正在读取你的知识网络…" : "点地图里的章节，或下面速览的一行，这里会给出该章的核心技能与推荐资源。"}
            </p>
            {!loading && (
              <button type="button" onClick={onPickWeakest} className="lf-btn-ghost mt-3 !px-3.5 !py-1.5 text-[12.5px]">
                从最弱的一章开始
                <ArrowRight size={13} />
              </button>
            )}
          </>
        )}
      </div>

      {chapterName && (
        <>
          <div className="lf-card p-5">
            <div className="text-[12px] text-ink-muted">核心技能</div>
            <div className="mt-3 space-y-3">
              {topics.map((topic) => (
                <button
                  key={topic.id}
                  type="button"
                  onClick={() => onPickTopic(topic.id)}
                  className="block w-full text-left"
                >
                  <div className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="truncate text-ink-2 transition-colors hover:text-brand">{topic.label}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                      {topic.progress}% / 目标 {topic.target}%
                    </span>
                  </div>
                  <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-hairline">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-brand"
                      style={{ width: `${Math.min(100, topic.progress)}%` }}
                    />
                  </div>
                </button>
              ))}
              {topics.length === 0 && <p className="text-[12.5px] text-ink-muted">这一章还没有拆到知识点。</p>}
            </div>
          </div>

          <div className="lf-card p-5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-ink-muted">推荐资源</span>
              {resources.length > 0 && (
                <span className="font-mono text-[11px] text-ink-muted">本章 {resources.length} 份</span>
              )}
            </div>
            <div className="mt-2 -mx-2.5 space-y-0.5">
              {resources.slice(0, 5).map(patch)}
            </div>
            {resources.length === 0 && (
              <p className="mt-2 text-[12.5px] leading-[19px] text-ink-muted">
                这一章还没有资源：进「学 · 练」生成一份讲义或分阶题，学完就会出现在这里。
              </p>
            )}
            {resources.length > 5 && (
              <p className="mt-2 text-[11.5px] text-ink-muted">先列前 5 份（在读 → 未学 → 已学）</p>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
