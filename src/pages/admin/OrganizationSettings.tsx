import { useEffect, useRef, useState } from 'react';
import { Copy, ImageUp, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type OrganizationBranding } from '@/lib/api';

export default function OrganizationSettings() {
  const [branding, setBranding] = useState<OrganizationBranding | null>(null);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const apply = (value: OrganizationBranding) => { setBranding(value); setName(value.name); setShortName(value.shortName); };
  useEffect(() => { api.getAdminOrganization().then(apply).catch((e) => toast.error(e.message)); }, []);
  const save = async () => { setBusy(true); try { apply(await api.updateAdminOrganization({ name, shortName })); toast.success('机构配置已保存'); } catch (e) { toast.error(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  const upload = async (file?: File) => { if (!file) return; setBusy(true); try { apply(await api.uploadOrganizationLogo(file)); toast.success('Logo 已安全处理并更新'); } catch (e) { toast.error(e instanceof Error ? e.message : '上传失败'); } finally { setBusy(false); } };
  const createInvite = async () => { setBusy(true); try { const result = await api.createOrganizationInvite({ label: '管理员创建', maxUses: 20, expiresInDays: 30 }); setInvite(result.invitationCode); } catch (e) { toast.error(e instanceof Error ? e.message : '邀请码生成失败'); } finally { setBusy(false); } };
  if (!branding) return <div className="lf-empty flex min-h-48 items-center justify-center text-sm"><Loader2 className="mr-2 animate-spin" size={16} />读取机构配置…</div>;
  return (
    <div className="lf-anim-in-up space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">机构配置</h2>
        <p className="mt-1.5 text-sm text-ink-muted">统一管理机构名称、简称、Logo 与成员邀请码。</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <section className="lf-card rounded-2xl p-5">
          <h3 className="text-sm font-bold text-ink">基础信息</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-ink-2">
              机构全称
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} className="lf-input mt-1.5" />
            </label>
            <label className="block text-xs font-semibold text-ink-2">
              机构简称
              <input value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={64} className="lf-input mt-1.5" />
            </label>
          </div>
          <button disabled={busy || !name.trim() || !shortName.trim()} onClick={() => void save()} className="lf-row-btn lf-row-btn-primary mt-5 disabled:opacity-50">
            保存机构信息
          </button>
        </section>
        <section className="lf-card rounded-2xl p-5">
          <h3 className="text-sm font-bold text-ink">机构 Logo</h3>
          <div className="mt-4 flex h-24 items-center justify-center rounded-xl border border-dashed border-ochre/40 bg-white/50">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.shortName} className="max-h-20 max-w-[220px] object-contain" />
            ) : (
              <span className="text-xs text-ink-muted">使用系统默认 Logo</span>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
          <div className="mt-3 flex gap-2">
            <button onClick={() => fileRef.current?.click()} className="lf-row-btn">
              <ImageUp size={13} />
              上传
            </button>
            {branding.logoUrl && (
              <button onClick={() => void api.deleteOrganizationLogo().then(apply)} className="lf-row-btn text-ink-muted">
                <Trash2 size={13} />
                恢复默认
              </button>
            )}
          </div>
        </section>
        <section className="lf-card rounded-2xl p-5 lg:col-span-2">
          <h3 className="text-sm font-bold text-ink">成员邀请码</h3>
          <p className="mt-1 text-xs text-ink-muted">默认 30 天有效、最多使用 20 次。明文只显示这一次，请安全发送给本机构成员。</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button disabled={busy} onClick={() => void createInvite()} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              生成邀请码
            </button>
            {invite && (
              <span className="lf-pill lf-pill-ok gap-2 px-3 py-1.5 font-mono text-xs tracking-wide">{invite}</span>
            )}
            {invite && (
              <button
                onClick={() => void navigator.clipboard.writeText(invite).then(() => toast.success('已复制'))}
                aria-label="复制邀请码"
                className="lf-row-btn"
              >
                <Copy size={13} />
                复制
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
