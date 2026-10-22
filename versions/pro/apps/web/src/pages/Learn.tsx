import { startTransition, useMemo, useRef, useState } from 'react';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Brain, Check, ChevronDown, ChevronRight, Loader2, Plus, Route, Trash2 } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import { useAgent } from '@/context/AgentContext';
import KnowledgeGraph3D from '@/components/learn/KnowledgeGraph3D';
import { ChatStream } from '@/components/agent/ChatStream';
import { Fern, GrassTuft } from '@/components/heal/Flora';
import { api } from '@/lib/api';
import { addMyCourse, hydrateMyCourses, readMyCourses, removeMyCourse } from '@/lib/myCourses';
import { cn } from '@/lib/utils';

const resourceTypeLabel: Record<string, string> = {
  lecture: '讲义',
  practice: '实操',
  quiz: '分阶题',
  ppt: '课件',
};

const statusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: '路径中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '路径中 · 待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
};

interface LearnViewState {
  selectedKp: string | null;
  selectedTopic: number | null;
  expandedKpIds: string[];
  showLearnedPath: boolean;
  showTopicEdges: boolean;
}

const learnViewKey = (learnerId: string) => `lf.learnView:v1:${learnerId}`;
const cameraReturnKey = (learnerId: string) => `lf.knowledgeGraph3dReturn:v1:${learnerId}`;

function consumeCameraReturn(learnerId: string): boolean {
  if (!learnerId || typeof window === 'undefined') return false;
  try {
    const key = cameraReturnKey(learnerId);
    const restore = window.sessionStorage.getItem(key) === 'breadcrumb';
    window.sessionStorage.removeItem(key);
    return restore;
  } catch { return false; }
}

function readLearnView(learnerId: string): LearnViewState | null {
  if (!learnerId || typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(learnViewKey(learnerId)) ?? 'null') as Partial<LearnViewState> | null;
    if (!parsed || !Array.isArray(parsed.expandedKpIds)) return null;
    return {
      selectedKp: typeof parsed.selectedKp === 'string' ? parsed.selectedKp : null,
      selectedTopic: typeof parsed.selectedTopic === 'number' ? parsed.selectedTopic : null,
      expandedKpIds: parsed.expandedKpIds.filter((id): id is string => typeof id === 'string'),
      showLearnedPath: Boolean(parsed.showLearnedPath),
      showTopicEdges: parsed.showTopicEdges !== false,
    };
  } catch { return null; }
}


export default function Learn() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentLearner } = useProfile();
  const [restoreMapState] = useState(() => consumeCameraReturn(currentLearner.id));
  /* 每次进入 learn 页面重置 3D 视图状态 */
  const restoredView: LearnViewState | null = null;
  /** 当前选中的课程（领域），知识网络与推荐资源都跟着它走；首页「继续学习」可通过 ?domain= 直达 */
  const [courseCode, setCourseCode] = useState(() => searchParams.get('domain') || '');
  const map = useLearningMap({ domainCode: courseCode, deferNetwork: !courseCode });
  /* 伴学助手：当前会话与历史会话列表 */
  const { sessions, currentSessionId, createAgentSession, switchAgentSession, isResponding: chatResponding } = useAgent();
  const knowledgePoints = map.domains;
  const reportPath = map.path;
  /** “我的已学路径”：高亮已学章节/资源 */
  /* 进入页面默认展示已学路径，先看学过的部分 */
  const [showLearnedPath, setShowLearnedPath] = useState(() => restoredView?.showLearnedPath ?? true);
  const [showTopicEdges, setShowTopicEdges] = useState(false);
  const [selectedKp, setSelectedKp] = useState<string | null>(() => restoredView?.selectedKp ?? null);
  const [expandedKpIds, setExpandedKpIds] = useState<Set<string>>(() => new Set(restoredView?.expandedKpIds ?? []));
  /** 3D：点击章节切换展开/收起，可同时展开多个 */
  const toggleExpandedKp = (id: string) => {
    setExpandedKpIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** 章节速览只展开单个章节 */
  const setSingleExpandedKp = (id: string | null) => {
    setExpandedKpIds(id === null ? new Set() : new Set([id]));
  };
  const [selectedTopic, setSelectedTopic] = useState<number | null>(() => restoredView?.selectedTopic ?? null);
  /** 左侧目录：课程展开 / 章节展开 */
  const [courseOpen, setCourseOpen] = useState(true);
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => new Set());
  /* 我的课程：只展示已加入书架（我的学习）的课程；空领域没有可展开内容 */
  const [courses, setCourses] = useState<Array<{ code: string; name: string; points: number }>>([]);
  useEffect(() => {
    let cancelled = false;
    api.listRagDomains()
      .then((list) => {
        if (cancelled) return;
        const rows = list
          .filter((item) => (item.knowledgePointCount ?? 0) > 0)
          .map((item) => ({ code: item.code, name: item.name, points: item.knowledgePointCount ?? 0 }));
        setCourses(rows);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  /* 我的学习书架：只有主动添加过的课程才出现在「我的课程」 */
  const [myCourseCodes, setMyCourseCodes] = useState<string[]>(() => readMyCourses(currentLearner.id));
  /* 书架同步完成前不渲染知识地图，避免把「还没同步到」误判成「没有课程」 */
  const [shelfReady, setShelfReady] = useState(false);
  useEffect(() => {
    setMyCourseCodes(readMyCourses(currentLearner.id));
    let cancelled = false;
    void hydrateMyCourses(currentLearner.id)
      .then((codes) => { if (!cancelled) setMyCourseCodes(codes); })
      .finally(() => { if (!cancelled) setShelfReady(true); });
    return () => { cancelled = true; };
  }, [currentLearner.id]);
  /* 没有课程时不加载任何默认领域；有课程时默认选中书架里的第一门 */
  useEffect(() => {
    if (!shelfReady) return;
    if (myCourseCodes.length === 0) {
      if (courseCode) setCourseCode('');
      return;
    }
    if (!myCourseCodes.includes(courseCode)) setCourseCode(myCourseCodes[0]);
  }, [shelfReady, myCourseCodes, courseCode]);
  const visibleCourses = useMemo(
    () => courses.filter((course) => myCourseCodes.includes(course.code)),
    [courses, myCourseCodes],
  );
  const switchCourse = (code: string) => {
    if (code === courseCode) {
      setCourseOpen((open) => !open);
      return;
    }
    setCourseCode(code);
    setCourseOpen(true);
    setSelectedKp(null);
    setSelectedTopic(null);
    setExpandedKpIds(new Set());
    setOpenChapters(new Set());
    setFocusTopic(null);
  };
  const removeCourse = (course: { code: string; name: string }) => {
    if (!window.confirm(`确定删除课程「${course.name}」吗？\n\n删除后不再出现在「我的课程」，学习记录仍会保留。`)) return;
    removeMyCourse(currentLearner.id, course.code);
    const next = myCourseCodes.filter((code) => code !== course.code);
    setMyCourseCodes(next);
    if (course.code === courseCode) {
      const fallback = courses.find((item) => next.includes(item.code));
      if (fallback) switchCourse(fallback.code);
    }
  };
  /* 首页卡片带着领域进来：只在参数变化时应用一次，之后左侧手动切换课程不再被拉回 */
  const domainParam = searchParams.get('domain');
  const appliedDomainParamRef = useRef<string | null>(null);
  /* 带 domain 深链进入的课程若不在书架（从课程介绍/首页「正在学习」进入），先自动加入 */
  useEffect(() => {
    if (!domainParam || !courses.length) return;
    if (!courses.some((course) => course.code === domainParam)) return;
    if (myCourseCodes.includes(domainParam)) return;
    addMyCourse(currentLearner.id, domainParam);
    setMyCourseCodes(readMyCourses(currentLearner.id));
  }, [domainParam, courses, myCourseCodes, currentLearner.id]);
  useEffect(() => {
    if (!domainParam || appliedDomainParamRef.current === domainParam) return;
    appliedDomainParamRef.current = domainParam;
    if (domainParam === courseCode) return;
    setCourseCode(domainParam);
    setSelectedKp(null);
    setSelectedTopic(null);
    setExpandedKpIds(new Set());
    setOpenChapters(new Set());
    setFocusTopic(null);
  }, [domainParam, courseCode]);

  /* 当前章节默认展开，跟随 3D 选中 */
  useEffect(() => {
    const current = selectedKp ?? map.activeKp;
    if (!current) return;
    setOpenChapters((prev) => (prev.has(current) ? prev : new Set(prev).add(current)));
  }, [selectedKp, map.activeKp]);
  /** 章节速览点击后，请求 3D 相机把该域节点转到正前方 */
  const [graphFocus, setGraphFocus] = useState<{ id: string; at: number } | null>(null);
  /** 深链：?unitTopic= 定位子知识点（展开功能节点层，与手点知识点一致） */
  const [focusTopic, setFocusTopic] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!currentLearner.id || currentLearner.id === 'loading') return;
    try {
      window.sessionStorage.setItem(learnViewKey(currentLearner.id), JSON.stringify({
        selectedKp,
        selectedTopic,
        expandedKpIds: Array.from(expandedKpIds),
        showLearnedPath,
        showTopicEdges,
      } satisfies LearnViewState));
    } catch { /* sessionStorage 不可用时保持当前内存状态 */ }
  }, [currentLearner.id, selectedKp, selectedTopic, expandedKpIds, showLearnedPath, showTopicEdges]);
  // kp 参数只应用一次：地图数据分多次到达会导致本 effect 反复执行，
  // 每次都重新触发相机聚焦会造成“展开后视角又变一次”，这里用 ref 去重。
  const appliedKpParamRef = useRef<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const kpParam = searchParams.get('kp');
    const unitTopic = searchParams.get('unitTopic');
    if (!kpParam) {
      appliedKpParamRef.current = null;
      return;
    }
    const domainNode = map.graphNodes.find((node) => node.kind === 'domain' && (node.id === kpParam || node.kpId === kpParam));
    const topicNode = map.graphNodes.find((node) => node.kind === 'topic' && node.id === kpParam);
    if (!domainNode && !topicNode) return;
    const chapterId = domainNode?.id ?? topicNode?.kpId ?? kpParam;
    const topicId = topicNode?.id ?? unitTopic ?? null;
    const deepKey = `${chapterId}:${topicId ?? ''}`;
    if (appliedKpParamRef.current === deepKey) return;
    appliedKpParamRef.current = deepKey;
    // 首页“今天就学这一件/去学这块”进入：先跳转页面（默认 3D 视图），
    // 页面就绪后再模拟点击“章节速览”对应章节（与真实点击同一套逻辑，相机只动一次）
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      setSelectedKp(chapterId);
      setSelectedTopic(null);
      setSingleExpandedKp(chapterId);
      setGraphFocus({ id: chapterId, at: Date.now() });
      // 深链到子知识点：展开功能节点层并选中（对应 3D 里点击知识点的效果）
      if (topicId) {
        const targetTopic = map.graphNodes.find((node) => node.kind === 'topic' && node.id === topicId);
        if (targetTopic) {
          setFocusTopic({ id: targetTopic.id, at: Date.now() });
          setSelectedTopic(targetTopic.topicIndex ?? null);
        }
      } else {
        setFocusTopic(null);
      }
    }, 450);
  }, [searchParams, knowledgePoints, map.graphNodes]);
  useEffect(() => () => {
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
  }, []);

  const pathStatusOf = (kpId: string): string | null => {
    const nodes = reportPath.filter((n) => n.kpId === kpId);
    if (nodes.some((n) => n.status === 'active')) return 'active';
    if (nodes.some((n) => n.status === 'todo')) return 'todo';
    if (nodes.length && nodes.every((n) => n.status === 'done')) return 'done';
    return null;
  };

  /* ---------- 右侧章节侧栏（W2）：选中章节 → 核心技能 + 推荐资源 ---------- */
  const sidebarChapter = (() => {
    if (selectedKp) {
      const picked = knowledgePoints.find((kp) => kp.id === selectedKp);
      if (picked) return picked;
    }
    const active = map.activeKp ? knowledgePoints.find((kp) => kp.id === map.activeKp) : null;
    if (active) return active;
    // 没选中也没有"在学"的章节时，退到最弱的一章 —— 与首页"今天就学这一件"同一套判断
    return [...knowledgePoints].sort((a, b) => (map.mastery[a.id] ?? 0) - (map.mastery[b.id] ?? 0))[0] ?? null;
  })();
  const sidebarTopics = sidebarChapter
    ? map.graphNodes
        .filter((node) => node.kind === 'topic' && node.kpId === sidebarChapter.id)
        .sort((a, b) => (a.topicIndex ?? 99) - (b.topicIndex ?? 99))
        .map((node) => ({
          id: node.id,
          label: node.label,
          progress: Math.round(map.topicProgress[node.id] ?? 0),
          mastery: Math.round(map.topicMastery[node.id] ?? 0),
          target: Math.round(map.nodeTargets[node.id]?.target ?? map.nodeTargets[sidebarChapter.id]?.target ?? 80),
        }))
    : [];
  /** 资源形态：运行时对象是 LearningResourceSummary（有 type），hook 的声明类型写窄了，两种都认 */
  const formOf = (resource: unknown): string => {
    const raw = (resource as { type?: string; form?: string });
    const kind = raw.type ?? raw.form ?? '';
    return kind === 'guide' ? 'practice' : kind;
  };
  type ResourceRow = { id: string; type: string; title: string; topic: string; learned?: boolean; started?: boolean };
  /* 章节 → 知识点只算一次：每次渲染都过滤整张图会拖慢滚动 */
  const topicsByChapter = useMemo(() => {
    const grouped = new Map<string, Array<{ id: string; label: string; index: number; progress: number }>>();
    map.graphNodes.forEach((node) => {
      if (node.kind !== 'topic') return;
      const list = grouped.get(node.kpId) ?? [];
      list.push({
        id: node.id,
        label: node.label,
        index: node.topicIndex ?? 99,
        progress: Math.round(map.topicProgress[node.id] ?? 0),
      });
      grouped.set(node.kpId, list);
    });
    grouped.forEach((list) => list.sort((a, b) => a.index - b.index));
    return grouped;
  }, [map.graphNodes, map.topicProgress]);
  const topicsOf = (chapterId: string) => topicsByChapter.get(chapterId) ?? [];
  const sidebarResources = (() => {
    const rows: ResourceRow[] = [];
    for (const topic of sidebarTopics) {
      for (const resource of map.resources[topic.id] ?? []) {
        rows.push({
          id: resource.id,
          type: formOf(resource),
          title: resource.title,
          topic: topic.label,
          learned: resource.learned,
          started: resource.started,
        });
      }
    }
    // 推荐顺序：在读 → 未学 → 已学（正在学的最该接着做）
    const rank = (row: ResourceRow) => (row.started && !row.learned ? 0 : row.learned ? 2 : 1);
    return rows.sort((a, b) => rank(a) - rank(b));
  })();
  return (
    <div className="mx-auto max-w-[1600px] px-6 pb-8 pt-4 md:px-10 lg:flex lg:h-[calc(100dvh-4rem)] lg:flex-col lg:overflow-hidden lg:pb-2">

      {/* ============ 桌面端：地图（结构）+ 详情（操作）+ 速览（扫描），三向联动 ============ */}
      {map.loading && knowledgePoints.length === 0 && (
        <div className="mt-8 flex flex-col items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm px-6 py-12 text-center text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          <span>正在加载学习内容…</span>
          <span className="text-[12px] text-ink-muted/70">若长时间没有响应，请尝试刷新网页。</span>
        </div>
      )}
      {!map.loading && shelfReady && myCourseCodes.length > 0 && knowledgePoints.length === 0 && (
        <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13.5px] text-ink-muted">
          暂无学习内容。完成资料填写后，可刷新页面重试。
        </div>
      )}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="mt-2 flex flex-col gap-0 lg:min-h-0 lg:flex-1"
      >
        {/* 三栏：左目录 / 中知识地图 + 推荐资源 / 右伴学助手 */}
        <div className="grid gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[240px_minmax(0,1fr)_380px]">
          {/* 左：课程 → 章节 → 知识点 */}
          <aside className="hidden lg:flex lg:h-full lg:min-h-0">
            <div className="h-full w-full overflow-y-auto rounded-[10px] border border-hairline bg-card-warm p-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <p className="px-2 pb-2 text-[12px] font-medium tracking-[0.08em] text-ink-muted">我的课程</p>
              {courses.length > 0 && visibleCourses.length === 0 && (
                <p className="px-2 pb-2 text-[11.5px] leading-5 text-ink-muted">还没有课程，去「发现课程」添加想学的课程。</p>
              )}
              <ul className="space-y-0.5">
                {visibleCourses.map((course) => {
                  const selected = course.code === courseCode;
                  return (
                    <li key={course.code} className="group">
                      <div
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors',
                          selected
                            ? 'bg-brand-tint text-brand'
                            : 'bg-paper-deep/45 text-ink hover:bg-paper-deep/80',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => switchCourse(course.code)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {selected && courseOpen
                            ? <ChevronDown size={13} className="shrink-0" />
                            : <ChevronRight size={13} className="shrink-0 opacity-70" />}
                          <span className={cn('min-w-0 flex-1 truncate', selected ? 'text-[15px] font-semibold' : 'text-[14px] font-medium')}>
                            {course.name}
                          </span>
                        </button>
                        <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{course.points}</span>
                        <button
                          type="button"
                          aria-label={`删除课程 ${course.name}`}
                          title="删除课程"
                          onClick={() => removeCourse(course)}
                          className="shrink-0 rounded p-0.5 text-ink-muted opacity-0 transition-opacity hover:text-brand-danger focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      {selected && courseOpen && (
                        <ul className="mt-0.5 space-y-0.5">
                  {knowledgePoints.map((chapter) => {
                    const chapterId = chapter.id;
                    const topics = topicsOf(chapterId);
                    const open = openChapters.has(chapterId);
                    const active = (selectedKp ?? map.activeKp) === chapterId;
                    const progress = Math.round(map.chapterProgress[chapterId] ?? 0);
                    return (
                      <li key={chapterId}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedKp(chapterId);
                            setSelectedTopic(null);
                            setSingleExpandedKp(chapterId);
                            setGraphFocus({ id: chapterId, at: Date.now() });
                            setOpenChapters((prev) => {
                              const next = new Set(prev);
                              if (next.has(chapterId)) next.delete(chapterId);
                              else next.add(chapterId);
                              return next;
                            });
                          }}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors',
                            active
                              ? 'bg-brand-tint/70 font-medium text-brand'
                              : 'text-ink-muted hover:bg-paper-deep/40 hover:text-ink',
                          )}
                        >
                          {open
                            ? <ChevronDown size={12} className="shrink-0 opacity-70" />
                            : <ChevronRight size={12} className="shrink-0 opacity-70" />}
                          <span className="min-w-0 flex-1 truncate text-[13.5px]">{chapter.name}</span>
                          <span className="shrink-0 font-mono text-[11px] text-ink-muted">{progress}%</span>
                        </button>
                        {open && topics.length > 0 && (
                          <ul className="mb-1 ml-4 border-l border-hairline pl-2">
                            {topics.map((topic) => {
                              const topicNode = map.graphNodes.find((node) => node.kind === 'topic' && node.id === topic.id);
                              const topicActive = selectedKp === chapterId && selectedTopic !== null && topicNode?.topicIndex === selectedTopic;
                              return (
                                <li key={topic.id}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedKp(chapterId);
                                      setSingleExpandedKp(chapterId);
                                      setSelectedTopic(topicNode?.topicIndex ?? null);
                                      setFocusTopic({ id: topic.id, at: Date.now() });
                                    }}
                                    className={cn(
                                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] transition-colors',
                                      topicActive ? 'font-medium text-brand' : 'text-ink-muted/80 hover:text-ink',
                                    )}
                                  >
                                    <span className="min-w-0 flex-1 truncate">{topic.label}</span>
                                    <span className="shrink-0 font-mono text-[10.5px]">{topic.progress}%</span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </aside>

          {/* 中：知识地图 + 推荐资源（原章节速览位置） */}
          <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {!shelfReady ? (
              <div className="flex h-[52dvh] min-h-[340px] items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-[13px] text-ink-muted lg:h-[500px]">
                <Loader2 size={16} className="mr-2 animate-spin" />
                正在加载我的课程…
              </div>
            ) : myCourseCodes.length === 0 ? (
              <div className="flex h-[52dvh] min-h-[340px] flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-hairline bg-card-warm px-6 text-center lg:h-[500px]">
                <p className="text-[13.5px] text-ink-muted">还没有添加课程，知识地图会在你添加课程后生成。</p>
                <button type="button" onClick={() => navigate('/discover')} className="lf-btn-primary !px-4 !py-2 text-[13px]">
                  去发现课程
                  <ArrowRight size={14} />
                </button>
              </div>
            ) : (
            <>
            <div className="relative">
              <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowLearnedPath((v: boolean) => !v)}
                  aria-pressed={showLearnedPath}
                  title="高亮已学章节/资源，不一定连续"
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] backdrop-blur-sm transition-colors',
                    showLearnedPath
                      ? 'border-brand/60 bg-brand-tint text-brand hover:bg-brand-tint'
                      : 'border-hairline/50 bg-white/90 text-ink-2 hover:bg-white hover:text-ink',
                  )}
                >
                  {showLearnedPath ? <Check size={12} /> : <Route size={12} />}
                  {showLearnedPath ? '隐藏已学路径' : '已学路径'}
                </button>
              </div>
              <KnowledgeGraph3D
                nodes={map.graphNodes}
                edges={map.graphEdges}
                selectedKpId={selectedKp}
                expandedKpIds={expandedKpIds}
                onSelectKp={(id) => { setSelectedKp(id); setSelectedTopic(null); }}
                onSelectTopic={setSelectedTopic}
                onExpandedKpChange={toggleExpandedKp}
                learned={map.learned}
                mastery={map.mastery}
                chapterProgress={map.chapterProgress}
                topicMastery={map.topicMastery}
                topicMasteryRaw={map.topicMasteryRaw}
                topicProgress={map.topicProgress}
                focusTarget={graphFocus}
                focusTopicTarget={focusTopic}
                showLearned={showLearnedPath}
                showTopicEdges={showTopicEdges}
                resources={map.resources}
                presentations={map.presentations}
                nodeTargets={map.nodeTargets}
                jobName={map.jobName}
                persistenceKey={currentLearner.id}
                restorePersistedCamera={restoreMapState && !searchParams.get('kp')}
                overviewOnMount
                heightClass="h-[52dvh] min-h-[340px] w-full lg:h-[500px]"
              />
            </div>

            {knowledgePoints.length > 0 && (
              <section className="mt-4">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-serif text-[18px] font-semibold text-ink">推荐资源</h2>
                  <span className="truncate text-[12.5px] text-ink-muted">{sidebarChapter?.name ?? ''}</span>
                </div>
                {sidebarResources.length === 0 ? (
                  <p className="rounded-[10px] border border-hairline bg-card-warm px-4 py-6 text-center text-[13px] text-ink-muted">
                    本章还没有可用资源
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {sidebarResources.slice(0, 6).map((resource) => (
                      <button
                        key={resource.id}
                        type="button"
                        onClick={() => navigate(`/learn/resource/${encodeURIComponent(resource.id)}`)}
                        className="lf-card flex items-center gap-3 rounded-[8px] p-3 text-left transition-colors hover:border-brand/45"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium text-ink">{resource.title}</span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
                            {resourceTypeLabel[resource.type] ?? resource.type} · {resource.topic}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] font-medium text-brand">
                          {resource.learned ? '已学完' : resource.started ? '继续' : '开始'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
            </>
            )}
          </div>

          {/* 右：伴学助手对话 */}
          <aside className="hidden flex-col overflow-hidden rounded-[10px] border border-hairline bg-card-warm lg:flex lg:h-full lg:min-h-0">
            <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-paper">
                <Brain size={13} />
              </span>
              <p className="shrink-0 text-[14px] font-semibold text-ink">伴学助手</p>
              <select
                aria-label="切换历史对话"
                disabled={chatResponding}
                value={currentSessionId ?? ''}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next) void switchAgentSession(next);
                  else void createAgentSession();
                }}
                className="min-w-0 flex-1 truncate rounded-md border border-hairline bg-white/80 px-1.5 py-0.5 text-[11px] text-ink outline-none disabled:opacity-60"
              >
                <option value="">新对话</option>
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>{item.title || '未命名对话'}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={chatResponding}
                onClick={() => void createAgentSession()}
                title="新建对话"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline text-ink-muted transition-colors hover:text-brand disabled:opacity-40"
              >
                <Plus size={12} />
              </button>
            </div>
            <ChatStream compact pageContext="/learn" />
          </aside>
        </div>
      </motion.div>

      {/* ============ 移动端：网络不适合小屏，单元卡片作为移动布局 ============ */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:hidden">
        {knowledgePoints.map((kp, i) => {
          const score = map.mastery[kp.id] ?? currentLearner.scores[kp.id] ?? 50;
          const confidenceValue = map.confidence[kp.id] ?? 40;
          const st = pathStatusOf(kp.id);
          const meta = st ? statusMeta[st] : null;
          const gap = Math.max(0, kp.targetLevel - score);
          return (
            <motion.div
              key={kp.id}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => navigate(`/learn?kp=${kp.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/learn?kp=${kp.id}`); }}
              className="lf-card lf-card-hover flex flex-col p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[16.5px] font-semibold text-ink">{kp.name}</h3>
                  <div className="mt-0.5 font-mono text-[10px] tracking-wide text-ink-muted">{kp.en}</div>
                </div>
                {meta && (
                  <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>
                    {meta.label}
                  </span>
                )}
              </div>

              <p className="mt-2 line-clamp-2 text-[12.5px] leading-[19px] text-ink-muted">{kp.description}</p>

              <div className="mt-3">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-paper-deep">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${score}%` }} />
                  <div className="absolute inset-y-0 w-[2px] bg-brand-amber" style={{ left: `${kp.targetLevel}%` }} title={`目标 ${kp.targetLevel}`} />
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-ink-muted">
                  <span>掌握 <span className="text-ink-2">{score}</span> · 距目标 <span className="text-ochre">{gap}</span></span>
                  <span>置信 {confidenceValue}%</span>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end border-t border-hairline pt-3">
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-brand">
                  进入课件 <ArrowRight size={13} />
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
