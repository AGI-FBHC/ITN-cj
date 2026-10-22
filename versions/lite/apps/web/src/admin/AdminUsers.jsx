import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, formatCount, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

export default function AdminUsers() {
  const state = useLoad(() => adminApi.users(), []);
  const [keyword, setKeyword] = React.useState('');
  const [onlyActive, setOnlyActive] = React.useState(true);

  if (state.loading && !state.data) return <Loading label="正在读取学习者数据…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  const all = state.data.users || [];
  const key = keyword.trim().toLowerCase();
  const users = all.filter((user) => {
    if (onlyActive && user.progressCount === 0 && !user.profiled) return false;
    if (!key) return true;
    return `${user.account || ''} ${user.displayName || ''}`.toLowerCase().includes(key);
  });
  const hidden = all.length - users.length;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="用户"
        description={`最新 ${all.length} 个学习账号（最多显示 200 个）。学习数据只读，管理端不做修改。`}
        actions={<button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新</button>}
      />

      <div className="zx-card">
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="zx-field" style={{ width: 280 }}>
            <label htmlFor="user-search">按账号或昵称筛选</label>
            <input
              id="user-search"
              value={keyword}
              placeholder="输入关键字"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <label htmlFor="only-active" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, fontWeight: 600, color: '#4b4560', paddingBottom: 8 }}>
            <input
              id="only-active"
              type="checkbox"
              checked={onlyActive}
              onChange={(event) => setOnlyActive(event.target.checked)}
              style={{ accentColor: '#6038ef', width: 15, height: 15 }}
            />
            只看已建档或有学习记录的账号
          </label>
        </div>
        {hidden > 0 ? <div className="zx-card-hint">已隐藏 {hidden} 个未开始学习的游客账号。</div> : null}

        {users.length === 0 ? (
          <Notice kind="info">没有匹配的学习账号。</Notice>
        ) : (
          <table className="zx-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>建档</th>
                <th>完成课时</th>
                <th>进度条目</th>
                <th>平均分</th>
                <th>最近活跃</th>
                <th>注册时间</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="zx-cell-title">{user.displayName || '未命名学习者'}</div>
                    <div className="zx-cell-sub">{user.account || '游客账号'}</div>
                  </td>
                  <td>{user.profiled ? <span className="zx-pill zx-pill-live">已建档</span> : <span className="zx-pill zx-pill-draft">未建档</span>}</td>
                  <td className="zx-num">{formatCount(user.completedCount)}</td>
                  <td className="zx-num">{formatCount(user.progressCount)}</td>
                  <td className="zx-num">{user.averageScore ? `${user.averageScore} 分` : '—'}</td>
                  <td className="zx-num">{user.lastActive || '—'}</td>
                  <td className="zx-num">{(user.createdAt || '').slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
