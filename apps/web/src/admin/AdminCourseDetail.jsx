import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, StatusPill, useLoad } from './admin-ui.jsx';

export default function AdminCourseDetail() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.course(courseId), [courseId]);
  const [form, setForm] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');

  const course = state.data?.course;
  const lessons = state.data?.lessons || [];

  React.useEffect(() => {
    if (!course) return;
    setForm({
      name: course.name,
      description: course.description,
      level: course.level,
      duration: course.duration,
      sourceLabel: course.sourceLabel,
      icon: course.icon,
    });
  }, [course?.id, course?.updatedAt]);

  async function run(key, task, okMessage) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await task();
      if (okMessage) setMessage(okMessage);
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取课程…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!course || !form) return <ErrorBlock message="没有找到这门课程" onRetry={state.reload} />;

  const nextStatus = course.status === 'published' ? 'draft' : 'published';
  const lastIndex = lessons.length > 0 ? lessons[lessons.length - 1].index : -1;

  return (
    <div className="zx-admin-page">
      <button type="button" className="zx-back" onClick={() => navigate('/admin/courses')}>← 返回课程列表</button>
      <PageHead
        title={course.name}
        description={`${course.id} · ${lessons.length} 个课时 · 最后更新 ${course.updatedAt || '—'}`}
        actions={
          <>
            <StatusPill status={course.status} />
            <button
              type="button"
              className="zx-btn"
              disabled={busy === 'status'}
              onClick={() => run('status', () => adminApi.setCourseStatus(course.id, nextStatus),
                nextStatus === 'published' ? '已发布，学习者现在可以看到这门课程。' : '已下架，学习者暂时看不到这门课程。')}
            >
              {nextStatus === 'published' ? '发布课程' : '下架课程'}
            </button>
            <button
              type="button"
              className="zx-btn zx-btn-danger"
              disabled={busy === 'delete'}
              onClick={() => {
                if (!window.confirm(`删除《${course.name}》？只有从未被学习过的课程可以删除，否则请用下架。`)) return;
                run('delete', async () => {
                  await adminApi.deleteCourse(course.id);
                  navigate('/admin/courses');
                }, '');
              }}
            >
              删除课程
            </button>
          </>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <form
        className="zx-card"
        onSubmit={(event) => {
          event.preventDefault();
          run('save', () => adminApi.updateCourse(course.id, { ...form, duration: Number(form.duration) || 0 }), '课程信息已保存。');
        }}
      >
        <h2 className="zx-card-title">课程信息</h2>
        <div className="zx-form">
          <div className="zx-field">
            <label htmlFor="detail-name">课程名称</label>
            <input id="detail-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </div>
          <div className="zx-field">
            <label htmlFor="detail-level">难度</label>
            <input id="detail-level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })} />
          </div>
          <div className="zx-field">
            <label htmlFor="detail-duration">建议时长（分钟）</label>
            <input id="detail-duration" type="number" min="0" value={form.duration} onChange={(event) => setForm({ ...form, duration: event.target.value })} />
          </div>
          <div className="zx-field">
            <label htmlFor="detail-source">来源标注</label>
            <input id="detail-source" value={form.sourceLabel} onChange={(event) => setForm({ ...form, sourceLabel: event.target.value })} />
          </div>
          <div className="zx-field zx-field-full">
            <label htmlFor="detail-description">课程简介</label>
            <textarea id="detail-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'save'}>
            {busy === 'save' ? '正在保存…' : '保存课程信息'}
          </button>
        </div>
      </form>

      <div className="zx-card">
        <h2 className="zx-card-title">
          课时
          <button
            type="button"
            className="zx-btn zx-btn-sm zx-btn-primary"
            disabled={busy === 'add'}
            onClick={() => run('add', async () => {
              const created = await adminApi.addLesson(course.id);
              navigate(`/admin/courses/${course.id}/lessons/${created.index}`);
            })}
          >
            新增课时
          </button>
        </h2>
        <div className="zx-card-hint">课时按顺序显示在学习端。为避免打乱已完成的学习记录，只有最后一节可以删除。</div>
        <table className="zx-table">
          <thead>
            <tr>
              <th>#</th>
              <th>课时标题</th>
              <th>讲义分节</th>
              <th>题目</th>
              <th>更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {lessons.map((lesson) => (
              <tr key={lesson.index}>
                <td className="zx-num">{lesson.index + 1}</td>
                <td className="zx-cell-title">{lesson.title}</td>
                <td className="zx-num">{lesson.sectionCount}</td>
                <td className="zx-num">{lesson.questionCount}</td>
                <td className="zx-num">{lesson.updatedAt || '—'}</td>
                <td className="zx-actions">
                  <button
                    type="button"
                    className="zx-btn zx-btn-sm zx-btn-ghost"
                    onClick={() => navigate(`/admin/courses/${course.id}/lessons/${lesson.index}`)}
                  >
                    改内容
                  </button>
                  {lesson.index === lastIndex ? (
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-danger"
                      disabled={busy === `del-${lesson.index}`}
                      onClick={() => {
                        if (!window.confirm(`删除最后一节《${lesson.title}》？这一节的阅读与测验记录会一起清除。`)) return;
                        run(`del-${lesson.index}`, () => adminApi.deleteLesson(course.id, lesson.index), '已删除最后一个课时。');
                      }}
                    >
                      删除
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {lessons.length === 0 ? (
              <tr><td colSpan={6}><div className="zx-empty">还没有课时，点「新增课时」开始写第一节。</div></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
