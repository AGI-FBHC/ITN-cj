import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, formatCount, Loading, Notice, PageHead, StatCard, useLoad } from './admin-ui.jsx';

export default function AdminOverview({ onOpenCourse }) {
  const state = useLoad(() => adminApi.overview(), []);

  if (state.loading && !state.data) return <Loading label="正在汇总学习数据…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  const { users, courses, lessons, quiz, learning } = state.data;
  const draftCourses = courses.total - courses.published;
  const profileRate = users.total > 0 ? Math.round((users.profiled / users.total) * 100) : 0;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="概览"
        description="学习端的真实使用情况，数据来自同一套仓颉服务。"
        actions={<button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新数据</button>}
      />

      <div className="zx-stats">
        <StatCard label="学习账号" value={formatCount(users.total)} hint={`近 7 天新增 ${formatCount(users.recent)}`} />
        <StatCard label="已建档账号" value={formatCount(users.profiled)} hint={`建档率 ${profileRate}%`} />
        <StatCard label="课程" value={formatCount(courses.total)} hint={draftCourses > 0 ? `${draftCourses} 门草稿未发布` : '全部已发布'} />
        <StatCard label="课时" value={formatCount(lessons.total)} hint="含讲义与测验" />
        <StatCard label="测验提交" value={formatCount(quiz.total)} hint={`平均分 ${formatCount(quiz.averageScore)}`} />
        <StatCard label="完成课时" value={formatCount(learning.completed)} hint={`近 7 天活跃 ${formatCount(learning.activeUsers)} 人`} />
      </div>

      {draftCourses > 0 ? (
        <div style={{ marginTop: 16 }}>
          <Notice kind="info">有 {draftCourses} 门课程仍是草稿，学习者看不到。发布后才会出现在课程列表里。</Notice>
        </div>
      ) : null}

      <div className="zx-card" style={{ marginTop: 16 }}>
        <h2 className="zx-card-title">接下来可以做什么</h2>
        <div className="zx-card-hint">管理端只保留必要环节：改完保存即生效，不设审核链，也不要反复确认。</div>
        <ul className="zx-admin-tips">
          <li>在「课程」里新建课程，上传或粘贴讲义后直接发布。</li>
          <li>课时内容支持结构化编辑，也可以切到 JSON 模式批量替换。</li>
          <li>在「用户」里查看学习者进度与测验分数，只读不改。</li>
        </ul>
        <button type="button" className="zx-btn zx-btn-primary" style={{ marginTop: 16 }} onClick={() => onOpenCourse(null)}>
          去管理课程
        </button>
      </div>
    </div>
  );
}
