/**
 * LearnerHome `/me` — 学习者视角首页「我的学习」（单列聚焦版）
 * 顶部导航外壳下的单列内容：问候 → 继续学习(焦点) → 进度条 → 接下来先补两块 → 学习资源列表
 * 窄栏 + 大留白 + 一行一件事，去掉与导航/侧栏重复的板块。
 */
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Play, ArrowRight, BookOpen, Flame, PenLine, ListChecks, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { MY_COURSES_EVENT, hydrateMyCourses, readMyCourses } from '@/lib/myCourses';
import type { LearningResourceSummary, RagDomain } from '@/lib/api';
import { reportForLearner } from '@/data/reportBuilder';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { learnMapPath } from '@/lib/learnNav';
import { useLearningMap } from '@/hooks/useLearningMap';
import { getResourcesFor } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { SprigTop } from '@/components/heal/Flora';

type RecommendItem = {
  code: string;
  name: string;
  description: string;
  coverImage: string;
  points: number;
  chapters: number;
  documents: number;
  type: string;
  /** 推荐打分与学习进度（0–100），仅用于排序 */
  score?: number;
  progress?: number;
  /** 大模型给出的推荐理由 */
  reason?: string;
  /** 该领域的学习用户数（热学榜排序依据） */
  learners?: number;
};

/** 推荐卡片：封面 + 标题 + 章节/知识点/文档统计 */
function RecommendDomainCard({ item }: { item: RecommendItem }) {
  return (
    <Link
      to={`/discover/${encodeURIComponent(item.code)}`}
      className="lf-card group flex flex-col overflow-hidden rounded-[8px] !p-0 transition-colors hover:border-brand/45"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden">
        {item.coverImage ? (
          <img
            src={item.coverImage}
            alt={`${item.name} 封面`}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-brand-tint to-paper" />
        )}
        <div className={cn('absolute inset-0', item.coverImage ? 'bg-gradient-to-t from-black/55 via-transparent to-transparent' : 'hidden')} />
        <span className="absolute bottom-2.5 left-2.5 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
          {item.type}
        </span>
        {typeof item.score === 'number' && item.score > 0 && (
          <span className="absolute right-2.5 top-2.5 rounded-md bg-brand/90 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
            匹配 {item.score}%
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <h4 className="line-clamp-1 text-[13.5px] font-semibold text-ink">{item.name}</h4>
        {item.reason && <p className="line-clamp-1 text-[10.5px] text-ink-muted">{item.reason}</p>}
        <div className="flex flex-wrap items-center gap-x-3 text-[10.5px] text-ink-muted">
          <span>共 {item.chapters} 个章节</span>
          <span>{item.points} 个知识点</span>
        </div>
        <div className="mt-auto flex items-center justify-between text-[11.5px]">
          <span className="text-ink-muted">{item.documents} 份入库文档</span>
          <span className="inline-flex items-center gap-0.5 font-medium text-brand">
            去看看 <ChevronRight size={12} />
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * 学习进度全部来自服务端：书架（learner_course_enrollments）+ 资源/知识网络进度。
 * 没有任何选课与学习记录时，「正在学习」就是空状态，不再注入演示数据。
 */

/** 画像（岗位/方向/目标）→ 课程关键词映射，用于计算「画像与课程名称的匹配度」 */
const PROFILE_COURSE_HINTS: Array<{ test: RegExp; keywords: string[] }> = [
  { test: /(agent|智能体|大模型|llm|ai|人工智能)/i, keywords: ['智能体', 'agent', '大模型', 'llm', '模型', 'rag', '多智能体', '提示词', '应用开发'] },
  { test: /(算法|机器学习|深度学习)/i, keywords: ['算法', '机器学习', '深度学习', '模型', '数据'] },
  { test: /(前端|web|h5|小程序)/i, keywords: ['前端', 'web', 'javascript', 'html', 'css', '小程序'] },
  { test: /(后端|java|python|go|服务端|架构)/i, keywords: ['后端', 'java', 'python', '服务', '接口', '架构'] },
  { test: /(数据|分析|统计|挖掘)/i, keywords: ['数据', '分析', '统计', '挖掘'] },
  { test: /(运维|测试|安全|devops)/i, keywords: ['运维', '测试', '安全', '部署', 'devops'] },
  { test: /(产品|运营|设计|交互)/i, keywords: ['产品', '运营', '设计', '交互', '用户'] },
];

/* 领域封面是 base64 大字段：按 code 缓存在内存里，刷新/重进首页不再重复请求 */
const domainCoverCache = new Map<string, string>();

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
};

const formMeta = {
  lecture: { label: '讲义', Icon: BookOpen, color: '#4E7860' },
  guide: { label: '实操指南', Icon: ListChecks, color: '#B77552' },
  quiz: { label: '分阶题', Icon: PenLine, color: '#E7B45A' },
} as const;

/* 顶部轮播封面：本地图片（public/banner），不依赖外部图床 */
const BANNER_SLIDES = [
  { tag: '1024 程序员节', title: '致敬每一行代码', src: '/banner/banner-1.webp' },
  { tag: '专题 · 智能体', title: '智能体入门：从概念到落地', src: '/banner/topic-multi-agent.jpg' },
  { tag: '专题 · 协作', title: '多智能体协作实战', src: '/banner/topic-collab.jpg' },
  { tag: '专题 · 评估', title: '效果评估与指标设计', src: '/banner/topic-metrics.jpg' },
  { tag: '专题 · 检索', title: 'RAG 知识库构建', src: '/banner/topic-knowledge.jpg' },
];

/** 折线点 → 平滑贝塞尔路径（Catmull-Rom），用于本周学习曲线 */
function smoothLine(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6},`
      + ` ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6},`
      + ` ${p2.x} ${p2.y}`;
  }
  return d;
}

/** 正在学习：空状态 */
function EmptyStudy({ text, cta, to }: { text: string; cta: string; to: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10">
      <svg width="180" height="112" viewBox="0 0 180 112" fill="none" aria-hidden>
        <rect x="34" y="18" width="104" height="70" rx="8" stroke="#C9DCCF" strokeWidth="3" />
        <path d="M24 94h124" stroke="#C9DCCF" strokeWidth="3" strokeLinecap="round" />
        <path d="M74 88h14l4 6H70z" fill="#E9F2EC" />
        <circle cx="86" cy="50" r="13" stroke="#A8D4BA" strokeWidth="3" />
        <path d="M92 43a9 9 0 1 0 0 14 10 10 0 0 1 0-14z" fill="#A8D4BA" />
        <circle cx="62" cy="42" r="2.4" fill="#DCE6DE" />
        <circle cx="108" cy="58" r="2.4" fill="#DCE6DE" />
      </svg>
      <p className="mt-2 text-[12.5px] text-ink-muted">
        {text}
        <Link to={to} className="ml-1 font-medium text-brand hover:underline">{cta}</Link>
      </p>
    </div>
  );
}

export default function LearnerHome() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { session } = useAuth();
  /* 游客只是来体验画像，没有真实学习记录：不展示任何学习进度 */
  const isGuest = session?.roles?.includes('guest') === true;
  /* 我的学习书架：推荐区只推书架里没有的课程，书架一变就重新检查 */
  const [shelfCodes, setShelfCodes] = useState<string[]>(() => readMyCourses(currentLearner.id));
  useEffect(() => {
    const sync = () => setShelfCodes(readMyCourses(currentLearner.id));
    sync();
    window.addEventListener(MY_COURSES_EVENT, sync);
    return () => window.removeEventListener(MY_COURSES_EVENT, sync);
  }, [currentLearner.id]);
  /* 书架以服务端为准：登录/切账号时拉取，并把本地历史补写到服务端 */
  useEffect(() => {
    let cancelled = false;
    void hydrateMyCourses(currentLearner.id).then((codes) => {
      if (!cancelled) setShelfCodes(codes);
    });
    return () => { cancelled = true; };
  }, [currentLearner.id]);

  const learning = useCourseLearning();
  const learningMap = useLearningMap();

  /*
   * 知识网络首屏并行读 5 个接口（rag/tree、analytics、模板目录、本人资源、PPT 进度），慢的时候要好几秒。
   * 这段时间若直接按“没有章节”渲染，页面就会说“还没有学习记录”“0 块”“0 份”——那是假话：
   * 学习者其实已经有章节进度和定制资源。所以加载期只说“正在读”，读完再下结论。
   */
  const mapLoading = learningMap.loading && learningMap.path.length === 0;
  const isPreset = !currentLearner.custom;
  const report = isPreset ? reportForLearner(currentLearner) : null;
  const resources = isPreset ? getResourcesFor(dataIdOf(currentLearner)) : learning.resources;

  /* 真实用户：路径/进度/盲区全部来自知识网络真实数据；预设画像保留原演示报告 */
  const path = isPreset ? report!.path : learningMap.path;
  const doneCount = isGuest ? 0 : (isPreset ? path.filter((p) => p.status === 'done').length : learningMap.learned.size);
  const activeNode = isPreset
    ? path.find((p) => p.status === 'active') ?? path.find((p) => p.status === 'todo')
    : path.find((p) => p.status === 'active') ?? path[0] ?? null;
  const mapActive = learningMap.activeKp ? learningMap.domains.find((domain) => domain.id === learningMap.activeKp) : null;
  // 与当前知识网络对齐：最近学习章节优先，否则取掌握度最低的章节作为推荐入口
  const weakestChapter = [...learningMap.domains].sort(
    (a, b) => (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0),
  )[0];
  const todayChapter = mapActive ?? weakestChapter ?? null;
  // 学情描述：基于该章节与其内部知识点的真实统计动态生成，不写死固定话术
  const todayDiagnosis = (() => {
    if (!todayChapter) {
      if (isPreset) return currentLearner.diagnosisSummary.replace(/^DIA-01 诊断：/, '');
      return mapLoading ? '正在读取你的学习进度…' : '还没有学习记录，从知识网络选一个章节开始你的第一课。';
    }
    const chapterId = todayChapter.id;
    const progress = learningMap.chapterProgress[chapterId] ?? 0;
    const mastery = learningMap.mastery[chapterId] ?? 0;
    const topics = learningMap.graphNodes.filter((n) => n.kind === 'topic' && n.kpId === chapterId);
    const topicStats = topics.map((t) => ({
      name: t.label,
      mastery: learningMap.topicMastery[t.id] ?? 0,
      progress: learningMap.topicProgress[t.id] ?? 0,
    }));
    const started = topicStats.filter((t) => t.progress > 0 || t.mastery > 0).length;
    if (progress <= 0 && mastery <= 0 && started === 0) {
      return `本章「${todayChapter.name}」还没有学习记录，建议从这里开始第一课，用分阶题巩固掌握。`;
    }
    const strongest = [...topicStats].sort((a, b) => b.mastery - a.mastery || b.progress - a.progress)[0];
    const weakest = [...topicStats].sort((a, b) => a.mastery - b.mastery || a.progress - b.progress)[0];
    const parts = [`本章学习进度 ${Math.round(progress)}%，掌握度 ${Math.round(mastery)}%。`];
    if (topicStats.length) parts.push(`已覆盖 ${started}/${topicStats.length} 个知识点。`);
    if (strongest && weakest && strongest.name !== weakest.name) {
      parts.push(`其中「${strongest.name}」掌握最好，「${weakest.name}」还需要加强，建议从「${weakest.name}」继续，用分阶题巩固。`);
    } else if (strongest) {
      parts.push(`当前可从「${strongest.name}」继续，用分阶题巩固掌握。`);
    }
    return parts.join(' ');
  })();
  const primaryLoading = learning.loading && !learning.course && learningMap.loading && !learningMap.activeKp;

  const todayTopics = todayChapter
    ? learningMap.graphNodes
        .filter((node) => node.kind === 'topic' && node.kpId === todayChapter.id)
        .sort((left, right) => (left.topicIndex ?? 99) - (right.topicIndex ?? 99))
    : [];
  const continueTopic = todayTopics.find((topic) => (learningMap.topicProgress[topic.id] ?? 0) < 100) ?? todayTopics[0] ?? null;
  const activeTitle = primaryLoading || mapLoading ? '正在加载学习进度…' : todayChapter ? todayChapter.name : learning.nextChapter ? `第 ${learning.nextChapter.index} 章 · ${learning.nextChapter.title}` : activeNode?.title ?? '开启你的第一课';
  const activePath = primaryLoading ? '/me' : todayChapter ? learnMapPath(currentLearner.id, todayChapter.id, continueTopic?.id) : learning.nextResource ? learningResourcePath(learning.nextResource) : activeNode ? `/learn/${activeNode.kpId}` : '/learn';
  const activeButton = primaryLoading || mapLoading ? '加载中…' : todayChapter ? (continueTopic ? `继续：${continueTopic.label}` : `继续：${todayChapter.name}`) : learning.nextResource ? `继续：${learning.nextResource.title}` : activeNode ? `继续：${activeNode.resourceRef ?? activeNode.title}` : '开始学习';
  const goActive = () => {
    if (isPreset) { navigate(activePath); return; }
    if (todayChapter) { navigate(learnMapPath(currentLearner.id, todayChapter.id, continueTopic?.id)); return; }
    if (learning.nextResource) { navigate(learningResourcePath(learning.nextResource)); return; }
    navigate(learnMapPath(currentLearner.id));
  };
  const activeEst = todayChapter ? undefined : (learning.nextResource ? undefined : activeNode?.est);

  /* ===== 顶部概览：本周学习（后端按天聚合，今天-6 … 今天共 7 桶） ===== */
  const weekMinutes = isGuest ? 0 : Math.round((learningMap.stats.weeklyMinutes ?? []).reduce((sum, m) => sum + (Number(m) || 0), 0));
  const weeklyGoalMinutes = Math.max(30, Math.round((currentLearner.weeklyHours || 1) * 60));
  const weekPct = Math.min(100, Math.round((weekMinutes / weeklyGoalMinutes) * 100));
  const weekBars = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - i));
    return {
      label: '日一二三四五六'[date.getDay()],
      minutes: Math.round(Number(learningMap.stats.weeklyMinutes[i]) || 0),
      isToday: i === 6,
    };
  });
  const weekMax = Math.max(1, ...weekBars.map((bar) => bar.minutes));
  /* 折线坐标：300×64 视口，上留 12px、下留 8px */
  const weekPoints = weekBars.map((bar, index) => ({
    x: (index * 300) / Math.max(1, weekBars.length - 1),
    y: 56 - (bar.minutes / weekMax) * 44,
  }));
  const weekLinePath = smoothLine(weekPoints);

  /* 顶部轮播：每 4.5 秒翻一页，鼠标悬停时暂停 */
  const [bannerIndex, setBannerIndex] = useState(0);
  const [bannerPaused, setBannerPaused] = useState(false);
  useEffect(() => {
    if (bannerPaused) return undefined;
    const timer = window.setInterval(() => {
      setBannerIndex((index) => (index + 1) % BANNER_SLIDES.length);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [bannerPaused]);
  const goBanner = (step: number) => {
    setBannerIndex((index) => (index + step + BANNER_SLIDES.length) % BANNER_SLIDES.length);
  };

  /* ===== 正在学习：课程 / 资源 ===== */
  const [studyTab, setStudyTab] = useState<'course' | 'resource'>('course');
  const [studyPage, setStudyPage] = useState(0);
  const inProgressResources = isPreset
    ? []
    : learning.resources.filter((r) => !r.learned && (r.started || (r.progressRatio ?? 0) > 0));

  /* ===== 正在学习：按知识库「大知识（领域）」聚合，一块大知识一个框 ===== */
  const [domainCards, setDomainCards] = useState<Array<{
    code: string;
    name: string;
    description: string;
    points: number;
    learned: number;
    progress: number;
    coverImage: string;
  }>>([]);
  /* 游客没有学习记录，首屏直接显示空态，不出现骨架屏 */
  const [domainCardsLoading, setDomainCardsLoading] = useState(!isGuest);
  const [recommend, setRecommend] = useState<{ learn: RecommendItem[]; hot: RecommendItem[] }>({ learn: [], hot: [] });
  /** 本人定制的资源（scope=own）：生成过就应出现在「正在学习」里 */
  const [ownResources, setOwnResources] = useState<LearningResourceSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    /* 游客没有学习记录：「正在学习」直接是空态，不等领域/封面接口返回 */
    if (isGuest) {
      setDomainCards([]);
      setDomainCardsLoading(false);
    }
    void (async () => {
      try {
        const [domains, index, userRes, popularity, ownRes] = await Promise.all([
          api.listRagDomains().catch(() => []),
          api.getCategoryIndex().catch(() => []),
          api.listLearningResources().catch(() => ({ resources: [] as LearningResourceSummary[] })),
          api.getDomainPopularity().catch(() => ({ items: [] as Array<{ code: string; learners: number }> })),
          api.listLearningResources({ scope: 'own' }).catch(() => ({ resources: [] as LearningResourceSummary[] })),
        ]);
        if (!cancelled) setOwnResources(ownRes.resources ?? []);
        const learnersByCode = new Map(popularity.items.map((item) => [item.code, item.learners]));
        /* 领域 → 其下全部知识点编码（L3；没有 L3 时退回 L2 章节） */
        const domainPoints = new Map<string, Set<string>>();
        index.forEach((node) => {
          if (node.level !== 3) return;
          const set = domainPoints.get(node.domainCode) ?? new Set<string>();
          set.add(node.nodeCode);
          domainPoints.set(node.domainCode, set);
        });
        /* 知识点 → 完成度（0–1）：同一知识点多份资源取最高，learned 视为 100% */
        const pointProgress = new Map<string, number>();
        for (const resource of [...(userRes.resources ?? []), ...(ownRes.resources ?? [])]) {
          if (!resource.kpId) continue;
          const value = resource.learned ? 1 : Math.min(1, Math.max(0, resource.progressRatio ?? 0));
          pointProgress.set(resource.kpId, Math.max(pointProgress.get(resource.kpId) ?? 0, value));
        }
        /* 知识网络已算好的知识点进度（含测评/PPT 综合），覆盖资源口径 */
        Object.entries(learningMap.topicProgress).forEach(([nodeCode, value]) => {
          pointProgress.set(nodeCode, Math.max(pointProgress.get(nodeCode) ?? 0, Math.min(100, value) / 100));
        });
        /* 知识点 → 所属领域；生成过定制资源的领域也算「正在学习」 */
        const nodeDomain = new Map<string, string>();
        index.forEach((node) => nodeDomain.set(node.nodeCode, node.domainCode));
        const ownDomainCodes = new Set<string>();
        (ownRes.resources ?? []).forEach((resource) => {
          const code = resource.kpId ? nodeDomain.get(resource.kpId) : undefined;
          if (code) ownDomainCodes.add(code);
        });
        const shelfSet = new Set(shelfCodes);
        const cards = domains.flatMap((domain) => {
          const codes = Array.from(domainPoints.get(domain.code) ?? []);
          const total = codes.length || domain.knowledgePointCount || 0;
          let sum = 0;
          let learned = 0;
          codes.forEach((code) => {
            const value = pointProgress.get(code) ?? 0;
            sum += value;
            if (value > 0) learned += 1;
          });
          /* 在学的领域：已加入我的学习 / 已有真实进度 / 已生成定制资源 */
          if (sum <= 0 && !shelfSet.has(domain.code) && !ownDomainCodes.has(domain.code)) return [];
          return [{
            code: domain.code,
            name: domain.name,
            description: domain.description,
            points: total,
            learned,
            /* 分母是领域全部知识点，未学的计 0：不会被单份已完成资源拉到 100% */
            progress: total > 0 ? Math.min(100, Math.round((sum / total) * 100)) : 0,
          }];
        }).sort((left, right) => {
          /* 最近加入书架的课程排前面 */
          const rank = (code: string) => {
            const index = shelfCodes.indexOf(code);
            return index === -1 ? shelfCodes.length : index;
          };
          return rank(left.code) - rank(right.code);
        });
        /* 领域封面：列表接口只给 hasCover，按需单独取 data URL（已取过的走内存缓存） */
        const coverMap = new Map<string, string>();
        await Promise.all(
          domains
            .filter((domain) => domain.hasCover)
            .map(async (domain) => {
              const cached = domainCoverCache.get(domain.code);
              if (cached) { coverMap.set(domain.code, cached); return; }
              const cover = await api.getRagDomainCover(domain.code).catch(() => null);
              if (cover?.coverImage) {
                domainCoverCache.set(domain.code, cover.coverImage);
                coverMap.set(domain.code, cover.coverImage);
              }
            }),
        );
        if (!cancelled) {
          setDomainCards(cards.map((card) => ({ ...card, coverImage: coverMap.get(card.code) ?? '' })));
          const toItem = (domain: RagDomain): RecommendItem => ({
            code: domain.code,
            name: domain.name,
            description: domain.description,
            coverImage: coverMap.get(domain.code) ?? '',
            points: domain.knowledgePointCount || 0,
            chapters: domain.categoryCount || 0,
            documents: domain.documentCount || 0,
            type: domain.domainType || '课程',
            learners: learnersByCode.get(domain.code) ?? 0,
          });
          /* 推荐学习：优先「正在学」的领域 → 当前学习所在领域 → 未开始的探索；
             学完的领域降权，内容体量大的略微加权，专题略加分 */
          const activeCode = learningMap.activeKp ? (nodeDomain.get(learningMap.activeKp) ?? null) : null;
          const progressOf = (code: string, fallbackTotal: number) => {
            const codes = Array.from(domainPoints.get(code) ?? []);
            const total = codes.length || fallbackTotal || 0;
            if (!total) return 0;
            let sum = 0;
            codes.forEach((nodeCode) => { sum += pointProgress.get(nodeCode) ?? 0; });
            return Math.min(100, Math.round((sum / total) * 100));
          };
          /* 画像文本：岗位 / 角色 / 标签 / 目标 / 背景 / 优势 / 盲区 */
          const profileText = [
            currentLearner.targetJob,
            currentLearner.role,
            currentLearner.tag,
            currentLearner.goal,
            currentLearner.background,
            ...(currentLearner.strengths ?? []),
            ...(currentLearner.blindSpots ?? []),
          ].filter(Boolean).join(' ').toLowerCase();
          const profileHints = PROFILE_COURSE_HINTS.filter((hint) => hint.test.test(profileText));
          const ranked = domains.map((domain) => {
            const item = toItem(domain);
            const progress = progressOf(domain.code, item.points);
            let score = 0;
            if (domain.code === activeCode) score += 40;
            if (progress > 0 && progress < 100) score += 50;
            else if (progress === 0) score += 20;
            /* 空领域（没有知识点/章节）不值得优先推荐 */
            if (item.points > 0) score += Math.min(10, Math.round(item.points / 20));
            else score -= 10;
            if ((domain.domainType || '课程') === '专题') score += 5;
            /* 画像与课程名称/描述的匹配度：命中的相关关键词越多，加分越高（最多 40） */
            const courseText = `${domain.name} ${domain.description || ''}`.toLowerCase();
            let profileScore = 0;
            profileHints.forEach((hint) => {
              const hits = hint.keywords.filter((keyword) => courseText.includes(keyword.toLowerCase())).length;
              profileScore += Math.min(40, hits * 10);
            });
            score += profileScore;
            return { ...item, score, progress };
          });
          /* 「正在学习」与「我的学习」里已有的领域不再进推荐，避免重复 */
          const studyingCodes = new Set(cards.map((card) => card.code));
          const inShelf = new Set(shelfCodes);
          const recommendPool = ranked.filter((item) => !studyingCodes.has(item.code) && !inShelf.has(item.code));
          const baseLearn = [...recommendPool]
            .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
            .slice(0, 6);
          /* 热学榜：学习用户数优先，其次入库文档数、知识点数 */
          const baseHot = [...ranked]
            .sort((left, right) => (
              (right.learners ?? 0) - (left.learners ?? 0)
              || (right.documents - left.documents)
              || (right.points - left.points)
            ))
            .slice(0, 5);
          setRecommend({ learn: baseLearn, hot: baseHot });

          /* 画像 ↔ 课程名称/描述的匹配交给大模型打分；失败或超时沿用上面的规则排序 */
          void api.recommendCourses({
            profile: {
              tag: currentLearner.tag,
              role: currentLearner.role,
              targetJob: currentLearner.targetJob,
              goal: currentLearner.goal,
              background: currentLearner.background,
              strengths: currentLearner.strengths,
              blindSpots: currentLearner.blindSpots,
              learningProgress: ranked
                .filter((item) => item.progress > 0)
                .map((item) => `${item.name} 已学 ${item.progress}%`)
                .join('；'),
            },
            courses: recommendPool.map((item) => ({
              code: item.code,
              name: item.name,
              description: item.description,
              type: item.type,
              knowledgePoints: item.points,
            })),
          }).then((result) => {
            const scoreByCode = new Map(result.items.map((row) => [row.code, row.score]));
            const reasonByCode = new Map(result.items.map((row) => [row.code, row.reason]));
            if (cancelled || scoreByCode.size === 0) return;
            /* 模型给了分的排前面；模型漏掉的课程按原规则分排在后面，不丢卡片 */
            const llmRanked = [...recommendPool]
              .sort((left, right) => (
                (scoreByCode.get(right.code) ?? -1) - (scoreByCode.get(left.code) ?? -1)
                || (right.score ?? 0) - (left.score ?? 0)
              ))
              .slice(0, 6)
              .map((item) => ({
                ...item,
                score: scoreByCode.get(item.code) ?? item.score,
                reason: reasonByCode.get(item.code) ?? item.reason,
              }));
            if (llmRanked.length) setRecommend((prev) => ({ ...prev, learn: llmRanked }));
          }).catch(() => {
            /* 大模型不可用时保留规则推荐 */
          });
        }
      } catch {
        if (!cancelled) {
          setDomainCards([]);
          setRecommend({ learn: [], hot: [] });
        }
      } finally {
        if (!cancelled) setDomainCardsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearner.id, learningMap.topicProgress, shelfCodes, isGuest]);

  /* ===== 正在学习 → 资源：与课程卡片同款排版，只展示库里真实有进度的资源 ===== */
  /* 资源页签 = 本人定制资源 + 有进度的资源（去重），刚生成还没打开的资料也能看到 */
  const resourceSource = isPreset
    ? resources
    : [
        ...ownResources,
        ...inProgressResources.filter((item) => !ownResources.some((own) => own.id === item.id)),
      ];
  const resourceCards = (resourceSource as Array<GeneratedResource | LearningResourceSummary>)
    .map((resource, index) => {
      const real = resource as LearningResourceSummary;
      const form = isPreset ? (resource as GeneratedResource).form : (real.type === 'practice' ? 'guide' : real.type);
      const meta = formMeta[form];
      const title = isPreset ? (resource as GeneratedResource).title : real.title;
      const kpName = isPreset
        ? getKnowledgePoint((resource as GeneratedResource).kpId).name
        : (learningMap.domains.find((domain) => domain.id === real.kpId)?.name ?? real.topic);
      const learned = !isPreset && real.learned;
      const started = !isPreset && real.started;
      return {
        key: `${form}-${title}-${index}`,
        meta,
        title,
        kpName,
        to: isPreset ? `/resources?tab=${form}` : learningResourcePath(real),
        progress: learned ? 100 : Math.max(0, Math.min(100, Math.round((real.progressRatio ?? 0) * 100))),
        learned,
        started,
        /* 真实资源按最近更新时间排序；演示数据没有时间戳，保持原顺序 */
        updatedAt: isPreset ? '' : (real.updatedAt ?? ''),
      };
    })
    .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    .slice(0, 6);

  /* ===== 正在学习：每页 3 张，鼠标悬停时显示左右切换 ===== */
  const STUDY_PAGE_SIZE = 3;
  const studyPages = Math.max(1, Math.ceil(domainCards.length / STUDY_PAGE_SIZE));
  const studyPageIndex = Math.min(studyPage, studyPages - 1);
  const studyPageItems = domainCards.slice(
    studyPageIndex * STUDY_PAGE_SIZE,
    studyPageIndex * STUDY_PAGE_SIZE + STUDY_PAGE_SIZE,
  );

  return (
    <div className="mx-auto max-w-[1120px] px-5 pb-12 pt-8 md:px-6">
      {/* ============ 顶部：继续学习 banner（左）+ 学习概览（右） ============ */}
      <motion.section {...fadeUp} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        {/* 左：资源轮播（整块图片撑满） */}
        <div
          className="group relative aspect-[16/9] self-start overflow-hidden rounded-[10px] bg-paper-deep"
          onMouseEnter={() => setBannerPaused(true)}
          onMouseLeave={() => setBannerPaused(false)}
        >
          {BANNER_SLIDES.map((slide, index) => (
            <figure
              key={slide.title}
              aria-hidden={index !== bannerIndex}
              className={cn(
                'absolute inset-0 transition-opacity duration-700',
                index === bannerIndex ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              <img
                src={slide.src}
                alt={slide.title}
                className="h-full w-full object-cover"
              />
              <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#1E3227]/90 via-[#1E3227]/35 to-transparent p-4 pb-8">
                <span className="text-[9.5px] uppercase tracking-[0.12em] text-paper/65">{slide.tag}</span>
                <p className="mt-0.5 truncate text-[14px] font-semibold text-paper">{slide.title}</p>
              </figcaption>
            </figure>
          ))}

            {/* 左右翻页 */}
            <button
              type="button"
              aria-label="上一页"
              onClick={() => goBanner(-1)}
              className="absolute left-2 top-1/2 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-[#1E3227]/50 text-paper opacity-0 transition-all duration-200 hover:bg-[#1E3227]/75 focus-visible:opacity-100 group-hover:opacity-100 sm:flex"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="下一页"
              onClick={() => goBanner(1)}
              className="absolute right-2 top-1/2 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-[#1E3227]/50 text-paper opacity-0 transition-all duration-200 hover:bg-[#1E3227]/75 focus-visible:opacity-100 group-hover:opacity-100 sm:flex"
            >
              <ChevronRight size={15} />
            </button>

            {/* 分页点 */}
            <div className="absolute inset-x-0 bottom-2.5 flex items-center justify-center gap-1.5">
              {BANNER_SLIDES.map((slide, index) => (
                <button
                  key={slide.title}
                  type="button"
                  aria-label={`第 ${index + 1} 页：${slide.title}`}
                  aria-current={index === bannerIndex}
                  onClick={() => setBannerIndex(index)}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300',
                    index === bannerIndex ? 'w-4 bg-paper' : 'w-1.5 bg-paper/50 hover:bg-paper/80',
                  )}
                />
              ))}
            </div>
        </div>

        {/* 右：个人信息 + 本周学习 */}
        <div className="flex flex-col gap-4">
          <div className="lf-card p-4">
            <div className="flex items-center gap-2.5">
              <Avatar className="h-10 w-10 border border-hairline">
                <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
                <AvatarFallback className="bg-brand-tint text-[12px] text-brand">
                  {currentLearner.name.slice(0, 1)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-ink">你好，{currentLearner.name}</p>
              </div>
              <Link
                to="/me/profile"
                title="修改学习目标"
                className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:text-brand"
              >
                <PenLine size={13} />
                修改学习目标
              </Link>
            </div>
            <div className="mt-3 grid grid-cols-3 divide-x divide-hairline text-center">
              <div className="px-1">
                <p className="font-mono text-[16px] font-semibold text-ink">{isGuest ? 0 : learningMap.stats.streakDays}</p>
                <p className="mt-0.5 text-[10.5px] text-ink-muted">连续天数</p>
              </div>
              <div className="px-1">
                <p className="font-mono text-[16px] font-semibold text-ink">{isGuest ? 0 : learningMap.stats.totalStudyMinutes}</p>
                <p className="mt-0.5 text-[10.5px] text-ink-muted">累计分钟</p>
              </div>
              <div className="px-1">
                <p className="font-mono text-[16px] font-semibold text-ink">{doneCount}</p>
                <p className="mt-0.5 text-[10.5px] text-ink-muted">已学章节</p>
              </div>
            </div>
          </div>

          <div className="lf-card flex-1 p-4">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="text-ink-muted">本周学习</span>
              <span className="font-mono text-brand">{weekPct}%</span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="font-display text-[30px] font-semibold leading-none text-ink">{weekMinutes}</span>
              <span className="text-[12px] text-ink-muted">/ {weeklyGoalMinutes} 分钟</span>
            </div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-paper-deep">
              <div className="h-full rounded-full bg-brand transition-all duration-700" style={{ width: `${weekPct}%` }} />
            </div>

            {/* 最近 7 天：折线 */}
            <div className="mt-3">
              <svg
                viewBox="0 0 300 64"
                preserveAspectRatio="none"
                className="h-[62px] w-full overflow-visible"
                role="img"
                aria-label="最近 7 天学习分钟数"
              >
                <defs>
                  <linearGradient id="lfWeekFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4E7860" stopOpacity="0.26" />
                    <stop offset="100%" stopColor="#4E7860" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path d={`${weekLinePath} L 300 64 L 0 64 Z`} fill="url(#lfWeekFill)" />
                <path
                  d={weekLinePath}
                  fill="none"
                  stroke="#4E7860"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {weekPoints.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x}
                    cy={point.y}
                    r={weekBars[index].isToday ? 3.4 : 2.4}
                    fill={weekBars[index].isToday ? '#E7B45A' : '#FBFAF5'}
                    stroke={weekBars[index].isToday ? '#E7B45A' : '#4E7860'}
                    strokeWidth="1.6"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`${weekBars[index].label} · ${weekBars[index].minutes} 分钟`}</title>
                  </circle>
                ))}
              </svg>
              <div className="mt-1 grid grid-cols-7 text-center">
                {weekBars.map((bar, index) => (
                  <span
                    key={index}
                    className={cn('text-[9.5px]', bar.isToday ? 'font-semibold text-ochre' : 'text-ink-muted')}
                  >
                    {bar.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 text-[11.5px] text-ink-muted">
              <span>{isGuest ? 0 : learning.learnedCount} 份资料已学</span>
              <Link to="/report" className="inline-flex items-center gap-0.5 font-medium text-brand transition-colors hover:underline">
                看成长 <ArrowRight size={11} />
              </Link>
            </div>
          </div>
        </div>
      </motion.section>

      {/* ============ 正在学习（课程 / 资源） ============ */}
      <motion.section {...fadeUp} className="relative mt-10">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[21px] font-semibold text-ink">正在学习</h2>
          <SprigTop className="pointer-events-none h-[54px] w-[90px] shrink-0 opacity-90" />
        </div>

        <div className="mt-3 flex items-center gap-5 border-b border-hairline">
          {([['course', '课程'], ['resource', '资源']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStudyTab(key)}
              className={cn(
                '-mb-px border-b-2 pb-2 text-[13.5px] transition-colors',
                studyTab === key
                  ? 'border-brand font-semibold text-brand'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {studyTab === 'course' ? (
          domainCardsLoading ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="lf-card aspect-video animate-pulse rounded-[8px] bg-paper-deep/40" />
              ))}
            </div>
          ) : domainCards.length > 0 ? (
            /* 一块大知识（知识库领域）一个框：略宽于高的矩形卡片 */
            <div className="group/study relative mt-4">
              {studyPages > 1 && (
                <>
                  <button
                    type="button"
                    aria-label="上一组课程"
                    onClick={() => setStudyPage((page) => Math.max(0, page - 1))}
                    disabled={studyPageIndex === 0}
                    className="absolute -left-3 top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-paper/95 text-ink-muted opacity-0 shadow-sm transition-opacity duration-200 hover:text-brand focus-visible:opacity-100 disabled:hidden group-hover/study:opacity-100 sm:flex"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="下一组课程"
                    onClick={() => setStudyPage((page) => Math.min(studyPages - 1, page + 1))}
                    disabled={studyPageIndex >= studyPages - 1}
                    className="absolute -right-3 top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-paper/95 text-ink-muted opacity-0 shadow-sm transition-opacity duration-200 hover:text-brand focus-visible:opacity-100 disabled:hidden group-hover/study:opacity-100 sm:flex"
                  >
                    <ChevronRight size={14} />
                  </button>
                </>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {studyPageItems.map((domain) => (
                <Link
                  key={domain.code}
                  to={`/knowledge?domain=${encodeURIComponent(domain.code)}`}
                  className="lf-card group flex flex-col overflow-hidden rounded-[8px] !p-0 transition-colors hover:border-brand/45"
                >
                  <div className="relative aspect-[16/9] w-full overflow-hidden">
                    {domain.coverImage ? (
                      <img
                        src={domain.coverImage}
                        alt={`${domain.name} 封面`}
                        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-brand-tint to-paper" />
                    )}
                    <div className={cn('absolute inset-0', domain.coverImage ? 'bg-gradient-to-t from-black/55 via-transparent to-transparent' : 'hidden')} />
                    <span className="absolute bottom-2.5 left-2.5 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
                      课程
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 p-3.5">
                    <div className="min-w-0">
                      <h3 className="truncate text-[13.5px] font-semibold text-ink">{domain.name}</h3>
                      <p className="mt-0.5 text-[10.5px] text-ink-muted">
                        {domain.learned} / {domain.points} 个知识点 · {domain.progress}%
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        navigate(`/learn?domain=${encodeURIComponent(domain.code)}`);
                      }}
                      className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-brand-hover"
                    >
                      继续学习
                    </button>
                  </div>
                </Link>
              ))}
              </div>
            </div>
          ) : (
            <EmptyStudy text="没有在学习的课程，" cta="马上去挑选吧！" to="/learn" />
          )
        ) : resourceCards.length > 0 ? (
          /* 资源与课程同款卡片：类型 / 标题 / 所属知识点 / 进度 */
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {resourceCards.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                className="lf-card group flex aspect-[3/2] flex-col justify-between gap-3 rounded-[8px] p-5 transition-colors hover:border-brand/45"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                    style={{ color: item.meta.color, borderColor: `${item.meta.color}45`, backgroundColor: `${item.meta.color}0D` }}
                  >
                    <item.meta.Icon size={18} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-2 font-serif text-[16px] font-semibold leading-6 text-ink">{item.title}</h3>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                      <span className="shrink-0 font-medium" style={{ color: item.meta.color }}>{item.meta.label}</span>
                      <span className="truncate">· {item.kpName}</span>
                    </p>
                  </div>
                </div>
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-deep">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${Math.max(2, item.progress)}%`, backgroundColor: item.meta.color }}
                      />
                    </div>
                    <span className="font-mono text-[10.5px] text-ink-muted">
                      {item.progress > 0 ? `${item.progress}%` : '<1%'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11.5px] text-ink-muted">
                    <span>{item.learned ? '已学完' : item.started ? '学习中' : '未开始'}</span>
                    <span className="inline-flex items-center gap-0.5 font-medium text-brand">
                      {item.started ? '继续学习' : '去学习'} <ChevronRight size={12} />
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyStudy text="还没有学习资源，" cta="去我的学习看看！" to="/learn" />
        )}
      </motion.section>

      {recommend.learn.length > 0 && (() => {
        /* 固定展示 2 门课，不做左右翻页 */
        const learnNow = recommend.learn.slice(0, 2);
        const hot = recommend.hot;
        return (
          <motion.section {...fadeUp} className="mt-10">
            <div className="mb-3">
              <h3 className="font-serif text-[17px] font-semibold text-ink">为你挑选的课程</h3>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_296px]">
              <div>
                {/* 固定两张，封面保持原始 16:9，不裁切图片 */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {learnNow.map((item) => <RecommendDomainCard key={item.code} item={item} />)}
                </div>
              </div>
              <aside className="flex h-full flex-col rounded-[8px] border border-[#F3DDC7] bg-gradient-to-b from-[#FFF2E6] to-[#FFF9F3] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="flex items-center gap-1.5 font-serif text-[16px] font-semibold text-[#C2410C]">
                      <Flame size={15} />
                      持续热学榜
                    </h4>
                    <p className="mt-1 text-[11px] text-[#B45309]/80">近期热门领域，学习人气之选</p>
                  </div>
                  <Link to="/rankings" className="shrink-0 text-[11px] text-[#C2410C]/80 hover:text-[#C2410C]">更多 ›</Link>
                </div>
                <ol className="mt-3 space-y-3">
                  {hot.map((item, index) => (
                    <li key={item.code}>
                      <Link to={`/discover/${encodeURIComponent(item.code)}`} className="group flex items-center gap-2">
                        <span
                          className={cn(
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                            index === 0 && 'bg-brand text-white',
                            index === 1 && 'bg-[#E7B45A] text-white',
                            index > 1 && 'bg-[#EFE7DA] text-[#8A7A63]',
                          )}
                        >
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            {index < 2 && (
                              <span className="shrink-0 rounded bg-[#FDE2C8] px-1 py-0.5 text-[9px] font-semibold text-[#B45309]">热门</span>
                            )}
                            <span className="truncate text-[12.5px] font-medium text-ink group-hover:text-brand">{item.name}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px] text-ink-muted">
                            {item.type} · {item.learners ?? 0} 人在学
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </aside>
            </div>
          </motion.section>
        );
      })()}

    </div>
  );
}
