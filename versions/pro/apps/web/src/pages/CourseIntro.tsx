/**
 * CourseIntro `/discover/:code` — 课程介绍页
 * 展示领域（课程/书籍）的封面、简介、统计与章节目录，点「开始学习」进入学习地图。
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, FileText, Layers, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type RagDomain, type RagTree } from '@/lib/api';
import { addMyCourse } from '@/lib/myCourses';
import { useProfile } from '@/context/ProfileContext';

export default function CourseIntro() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [domain, setDomain] = useState<RagDomain | null>(null);
  const [tree, setTree] = useState<RagTree | null>(null);
  const [cover, setCover] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      api.listRagDomains().catch(() => [] as RagDomain[]),
      api.getRagTree(code).catch(() => null),
      api.getRagDomainCover(code).then((result) => result.coverImage).catch(() => ''),
    ])
      .then(([domains, ragTree, coverImage]) => {
        if (cancelled) return;
        const hit = domains.find((item) => item.code === code)
          ?? ragTree?.domain
          ?? null;
        if (!hit) {
          setError('没有找到这门课程');
          return;
        }
        setDomain(hit);
        setTree(ragTree);
        setCover(coverImage || '');
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '课程信息读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code]);

  const chapters = tree?.nodes ?? [];
  const stats = [
    { icon: Layers, label: '章节', value: chapters.length },
    { icon: BookOpen, label: '知识点', value: domain?.knowledgePointCount ?? 0 },
    { icon: FileText, label: '来源文档', value: domain?.documentCount ?? 0 },
    { icon: FileText, label: '知识切片', value: domain?.chunkCount ?? 0 },
  ];

  /* 我的学习里没有该课程时，先把它加入书架 */
  const ensureInMyLearning = () => {
    if (!domain) return false;
    return addMyCourse(currentLearner.id, domain.code);
  };

  const startLearning = () => {
    if (!domain) return;
    if (ensureInMyLearning()) toast.success(`已把《${domain.name}》添加到我的学习`);
    navigate(`/learn?domain=${encodeURIComponent(domain.code)}`);
  };

  /* 添加到我的学习：加入后进入学习页 */
  const addToMyLearning = () => {
    if (!domain) return;
    const added = ensureInMyLearning();
    toast.success(added ? `已把《${domain.name}》添加到我的学习` : `《${domain.name}》已在你的学习库中`);
    navigate(`/learn?domain=${encodeURIComponent(domain.code)}`);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-[1080px] px-5 py-16 md:px-8">
        <div className="flex items-center justify-center gap-2 text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />正在加载课程介绍…
        </div>
      </div>
    );
  }

  if (error || !domain) {
    return (
      <div className="mx-auto max-w-[760px] px-5 py-20 text-center md:px-8">
        <h1 className="font-serif text-[24px] font-semibold text-ink">课程暂时打不开</h1>
        <p className="mt-2 text-[13px] text-brand-danger">{error || '课程不存在'}</p>
        <Link to="/discover" className="lf-btn-primary mt-5 inline-flex">返回发现课程</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1080px] px-5 pb-16 pt-8 md:px-8">
      <Link to="/discover" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:text-brand">
        <ArrowLeft size={14} />发现课程
      </Link>

      <section className="lf-card mt-4 overflow-hidden p-6">
        <div className="flex flex-wrap gap-6">
          <div className="h-[212px] w-[158px] shrink-0 overflow-hidden rounded-[10px] bg-brand-tint">
            {cover ? (
              <img src={cover} alt={domain.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-brand-tint to-brand-amber-tint p-4">
                <BookOpen size={18} className="text-brand" />
                <span className="font-serif text-[34px] font-semibold leading-none text-brand">{domain.name.slice(0, 2)}</span>
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-brand/25 bg-brand-tint px-2 py-0.5 font-mono text-[10.5px] text-brand">{domain.domainType || '课程'}</span>
              <span className="font-mono text-[10.5px] text-ink-muted">{domain.code}</span>
            </div>
            <h1 className="mt-2 font-serif text-[28px] font-bold text-ink">{domain.name}</h1>
            <p className="mt-2 max-w-[560px] text-[13px] leading-6 text-ink-2">{domain.description || '暂无课程简介。'}</p>

            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="rounded-[10px] bg-paper-deep/70 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10.5px] text-ink-muted"><item.icon size={12} />{item.label}</div>
                  <div className="mt-1 font-mono text-[19px] font-semibold text-ink">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-2.5">
              <button type="button" onClick={startLearning} className="lf-btn-primary !px-4 !py-2 text-[13px]">
                开始学习<ArrowRight size={14} />
              </button>
              <button type="button" onClick={addToMyLearning} className="lf-btn-ghost !px-4 !py-2 text-[13px]">添加到我的学习</button>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-ink">课程目录</h2>
          <span className="font-mono text-[11px] text-ink-muted">{chapters.length} 个章节</span>
        </div>
        {chapters.length ? (
          <div className="grid gap-2.5 md:grid-cols-2">
            {chapters.map((chapter, index) => (
              <div key={chapter.id} className="lf-card flex items-center gap-3 rounded-[8px] p-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-tint font-mono text-[11px] font-semibold text-brand">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink">{chapter.name}</div>
                  <div className="mt-1 font-mono text-[10.5px] text-ink-muted">
                    {chapter.children?.length ?? 0} 个子节点
                    {(chapter.chunkCount ?? 0) > 0 ? ` · ${chapter.chunkCount} 个切片` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[10px] border border-dashed border-hairline bg-card-warm py-10 text-center text-[12.5px] text-ink-muted">
            这门课程还没有章节目录，进入学习地图后可以按知识点逐步学习。
          </div>
        )}
      </section>
    </div>
  );
}
