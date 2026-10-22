/**
 * ResourceFileViewer — 管理员上传文档的在线阅读页
 * 字节通过带鉴权的 fetch 取回后转 object URL：PDF/图片/文本内嵌预览，Office 格式提供下载。
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Download, FileText, Loader2 } from 'lucide-react';
import PageBack from '@/components/PageBack';
import { fetchResourceFileBlob } from '@/lib/api';

export default function ResourceFileViewer() {
  const { resourceId = '' } = useParams();
  const [params] = useSearchParams();
  const title = params.get('title') || '文档预览';
  const [url, setUrl] = useState<string | null>(null);
  const [mime, setMime] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setMime('');
    setError(null);
    void fetchResourceFileBlob(resourceId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setMime(blob.type);
        setUrl(objectUrl);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '文件读取失败');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resourceId]);

  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isText = mime.startsWith('text/');
  const typeLabel = isPdf ? 'PDF 文档' : isImage ? '图片' : isText ? '文本' : 'Office 文档';

  return (
    <div className="mx-auto max-w-[1000px] px-5 pb-12 pt-8 md:px-6">
      <PageBack parent={{ label: '我的资源', to: '/resources' }} current={title} />

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint text-brand">
          <FileText size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-[22px] font-semibold text-ink">{title}</h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">{typeLabel}</p>
        </div>
        {url && (
          <a href={url} download={`${title}`} className="lf-btn-ghost shrink-0 text-[13px]">
            <Download size={14} />下载
          </a>
        )}
      </div>

      <div className="mt-5">
        {error ? (
          <div className="lf-card p-10 text-center text-[13px] text-ink-muted">{error}</div>
        ) : !url ? (
          <div className="lf-card flex items-center justify-center gap-2 py-20 text-[13px] text-ink-muted">
            <Loader2 size={16} className="animate-spin" />正在读取文档…
          </div>
        ) : isPdf || isText ? (
          <iframe
            src={url}
            title={title}
            className="h-[calc(100dvh-260px)] min-h-[520px] w-full rounded-[14px] border border-hairline bg-white"
          />
        ) : isImage ? (
          <div className="rounded-[14px] border border-hairline bg-white p-3">
            <img src={url} alt={title} className="mx-auto max-h-[calc(100dvh-280px)] w-auto" />
          </div>
        ) : (
          <div className="lf-card p-10 text-center">
            <p className="text-[13px] text-ink-muted">
              该格式暂不支持在线预览（PPT / Word / Excel），可下载后用本地软件打开。
            </p>
            <a href={url} download={`${title}`} className="lf-btn-primary mt-4 inline-flex">
              <Download size={14} />下载文档
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
