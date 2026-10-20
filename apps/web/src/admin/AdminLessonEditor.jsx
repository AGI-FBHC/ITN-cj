import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

function readJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function sectionsOf(content) {
  const list = Array.isArray(content.sections) ? content.sections : [];
  return list.map((section, index) => ({
    id: section.id || `section-${index}`,
    eyebrow: section.eyebrow || '',
    heading: section.heading || '',
    text: section.text || '',
  }));
}

function slidesOf(content) {
  const list = Array.isArray(content.slides) ? content.slides : [];
  return list.map((slide) => ({
    title: slide.title || '',
    subtitle: slide.subtitle || '',
    bullets: Array.isArray(slide.bullets) ? slide.bullets : [],
    notes: slide.notes || '',
  }));
}

function questionsOf(quiz) {
  const list = Array.isArray(quiz) ? quiz : [];
  return list.map((question, index) => ({
    id: question.id || `question-${index}`,
    question: question.question || '',
    options: Array.isArray(question.options) && question.options.length > 0 ? question.options.map(String) : ['', ''],
    correct: Number.isInteger(question.correct) ? question.correct : 0,
    explanation: question.explanation || '',
    theoryTitle: question.theoryTitle || '',
  }));
}

function emptySection() {
  return { id: `section-${Date.now().toString(36)}`, eyebrow: '核心概念', heading: '', text: '' };
}

function emptySlide() {
  return { title: '', subtitle: '课程要点', bullets: [], notes: '' };
}

function emptyQuestion() {
  return {
    id: `question-${Date.now().toString(36)}`,
    question: '',
    options: ['', ''],
    correct: 0,
    explanation: '',
    theoryTitle: '',
  };
}

function formSignature(title, sections, slides, questions, sources) {
  return JSON.stringify({ title, sections, slides, questions, sources });
}

function jsonSignature(title, contentJson, quizJson, sources) {
  return JSON.stringify({ title, contentJson, quizJson, sources });
}

export default function AdminLessonEditor() {
  const { courseId, index } = useParams();
  const lessonIndex = Number(index);
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.lesson(courseId, lessonIndex), [courseId, lessonIndex]);

  const [title, setTitle] = React.useState('');
  const [sections, setSections] = React.useState([]);
  const [slides, setSlides] = React.useState([]);
  const [questions, setQuestions] = React.useState([]);
  const [sourceLabel, setSourceLabel] = React.useState('');
  const [sourcesText, setSourcesText] = React.useState('[]');
  const [mode, setMode] = React.useState('form');
  const [contentJson, setContentJson] = React.useState('');
  const [quizJson, setQuizJson] = React.useState('');
  const [baselineForm, setBaselineForm] = React.useState('');
  const [baselineJson, setBaselineJson] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState('');

  const lesson = state.data;

  const applyLesson = React.useCallback((data) => {
    const content = readJson(data.contentJson, {});
    const quiz = readJson(data.quizJson, []);
    const sources = data.sourcesJson || '[]';
    const nextTitle = data.title || '';
    const nextSections = sectionsOf(content);
    const nextSlides = slidesOf(content);
    const nextQuestions = questionsOf(quiz);
    setTitle(nextTitle);
    setSections(nextSections);
    setSlides(nextSlides);
    setSourceLabel(content.sourceLabel || '');
    setSourcesText(sources);
    setQuestions(nextQuestions);
    setContentJson(data.contentJson || '{}');
    setQuizJson(data.quizJson || '[]');
    setSavedAt(data.updatedAt || '');
    setBaselineForm(formSignature(nextTitle, nextSections, nextSlides, nextQuestions, sources));
    setBaselineJson(jsonSignature(nextTitle, data.contentJson || '{}', data.quizJson || '[]', sources));
  }, []);

  React.useEffect(() => {
    if (lesson) applyLesson(lesson);
  }, [lesson, applyLesson]);

  const currentPayload = React.useMemo(() => ({
    title,
    contentJson: JSON.stringify({
      sections: sections.map((section, position) => ({
        id: section.id || `section-${position}`,
        eyebrow: section.eyebrow,
        heading: section.heading,
        text: section.text,
      })),
      slides: slides.map((slide) => ({
        title: slide.title,
        subtitle: slide.subtitle,
        bullets: slide.bullets.filter((bullet) => String(bullet).trim() !== ''),
        notes: slide.notes,
      })),
      ...(sourceLabel ? { sourceLabel } : {}),
    }),
    quizJson: JSON.stringify(questions.map((question, position) => ({
      id: question.id || `question-${position}`,
      question: question.question,
      options: question.options.map(String),
      correct: question.correct,
      explanation: question.explanation,
      theoryTitle: question.theoryTitle,
    }))),
    sourcesJson: sourcesText.trim() === '' ? '[]' : sourcesText,
  }), [title, sections, slides, questions, sourcesText, sourceLabel]);

  const dirty = React.useMemo(() => {
    if (!baselineForm) return false;
    if (mode === 'json') return jsonSignature(title, contentJson, quizJson, sourcesText) !== baselineJson;
    return formSignature(title, sections, slides, questions, sourcesText) !== baselineForm;
  }, [mode, title, contentJson, quizJson, sourcesText, sections, slides, questions, baselineForm, baselineJson]);

  function switchMode(next) {
    if (next === mode) return;
    if (next === 'json') {
      if (!dirty) {
        setContentJson(currentPayload.contentJson);
        setQuizJson(currentPayload.quizJson);
      }
    } else {
      const content = readJson(contentJson, null);
      const quiz = readJson(quizJson, null);
      if (content === null) { setError('讲义 JSON 无法解析，请先修好格式再切回表单。'); return; }
      if (quiz === null) { setError('测验 JSON 无法解析，请先修好格式再切回表单。'); return; }
      setSections(sectionsOf(content));
      setSlides(slidesOf(content));
      setSourceLabel(content.sourceLabel || '');
      setQuestions(questionsOf(quiz));
      setError('');
    }
    setMode(next);
  }

  async function save() {
    setSaving(true);
    setError('');
    setMessage('');
    const payload = mode === 'json'
      ? {
        title,
        contentJson: contentJson.trim() === '' ? '{}' : contentJson,
        quizJson: quizJson.trim() === '' ? '[]' : quizJson,
        sourcesJson: sourcesText.trim() === '' ? '[]' : sourcesText,
      }
      : currentPayload;
    if (!payload.title.trim()) {
      setError('课时标题不能为空。');
      setSaving(false);
      return;
    }
    try {
      const saved = await adminApi.saveLesson(courseId, lessonIndex, payload);
      applyLesson(saved);
      setMessage('已保存，学习者刷新后看到的就是最新内容。');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取课时内容…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!lesson) return <ErrorBlock message="没有找到这个课时" onRetry={state.reload} />;

  return (
    <div className="zx-admin-page">
      <button type="button" className="zx-back" onClick={() => navigate(`/admin/courses/${courseId}`)}>← 返回课程</button>
      <PageHead
        title={`第 ${lessonIndex + 1} 课时`}
        description={`${courseId} · 最后保存 ${savedAt || '—'}`}
        actions={
          <a className="zx-btn zx-btn-ghost" href={`/courses/${courseId}/lessons/${lessonIndex}`} target="_blank" rel="noreferrer">
            在学习端预览
          </a>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <div className="zx-card">
        <div className="zx-field">
          <label htmlFor="lesson-title">课时标题</label>
          <input id="lesson-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          <small>标题会同步到学习端的课程目录。</small>
        </div>
      </div>

      <div className="zx-card">
        <h2 className="zx-card-title">内容</h2>
        <div className="zx-tabs">
          <button type="button" className={`zx-tab ${mode === 'form' ? 'active' : ''}`} onClick={() => switchMode('form')}>结构化编辑</button>
          <button type="button" className={`zx-tab ${mode === 'json' ? 'active' : ''}`} onClick={() => switchMode('json')}>JSON 高级模式</button>
        </div>

        {mode === 'form' ? (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 800, color: '#4b4560', margin: '0 0 10px' }}>讲义分节</h3>
            {sections.map((section, position) => (
              <div className="zx-lesson-block" key={section.id}>
                <div className="zx-lesson-block-head">
                  <span>分节 {position + 1}</span>
                  <button
                    type="button"
                    className="zx-btn zx-btn-sm zx-btn-danger"
                    onClick={() => setSections(sections.filter((_, i) => i !== position))}
                  >
                    删除分节
                  </button>
                </div>
                <div className="zx-form">
                  <div className="zx-field">
                    <label>小标题</label>
                    <input
                      value={section.eyebrow}
                      placeholder="例如 核心概念"
                      onChange={(event) => setSections(sections.map((item, i) => (i === position ? { ...item, eyebrow: event.target.value } : item)))}
                    />
                  </div>
                  <div className="zx-field">
                    <label>分节标题</label>
                    <input
                      value={section.heading}
                      onChange={(event) => setSections(sections.map((item, i) => (i === position ? { ...item, heading: event.target.value } : item)))}
                    />
                  </div>
                  <div className="zx-field zx-field-full">
                    <label>正文</label>
                    <textarea
                      style={{ minHeight: 120 }}
                      value={section.text}
                      onChange={(event) => setSections(sections.map((item, i) => (i === position ? { ...item, text: event.target.value } : item)))}
                    />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="zx-btn zx-btn-sm" style={{ marginTop: 10 }} onClick={() => setSections([...sections, emptySection()])}>
              添加分节
            </button>

            <h3 style={{ fontSize: 13, fontWeight: 800, color: '#4b4560', margin: '26px 0 10px' }}>幻灯片</h3>
            {slides.map((slide, position) => (
              <div className="zx-lesson-block" key={`slide-${position}`}>
                <div className="zx-lesson-block-head">
                  <span>幻灯片 {position + 1}</span>
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" onClick={() => setSlides(slides.filter((_, i) => i !== position))}>
                    删除
                  </button>
                </div>
                <div className="zx-form">
                  <div className="zx-field">
                    <label>标题</label>
                    <input value={slide.title} onChange={(event) => setSlides(slides.map((item, i) => (i === position ? { ...item, title: event.target.value } : item)))} />
                  </div>
                  <div className="zx-field">
                    <label>副标题</label>
                    <input value={slide.subtitle} onChange={(event) => setSlides(slides.map((item, i) => (i === position ? { ...item, subtitle: event.target.value } : item)))} />
                  </div>
                  <div className="zx-field zx-field-full">
                    <label>要点（每行一条）</label>
                    <textarea
                      value={slide.bullets.join('\n')}
                      onChange={(event) => setSlides(slides.map((item, i) => (i === position ? { ...item, bullets: event.target.value.split('\n') } : item)))}
                    />
                  </div>
                  <div className="zx-field zx-field-full">
                    <label>讲稿备注</label>
                    <textarea value={slide.notes} onChange={(event) => setSlides(slides.map((item, i) => (i === position ? { ...item, notes: event.target.value } : item)))} />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="zx-btn zx-btn-sm" style={{ marginTop: 10 }} onClick={() => setSlides([...slides, emptySlide()])}>
              添加幻灯片
            </button>

            <h3 style={{ fontSize: 13, fontWeight: 800, color: '#4b4560', margin: '26px 0 10px' }}>测验题</h3>
            {questions.map((question, position) => (
              <div className="zx-lesson-block" key={question.id}>
                <div className="zx-lesson-block-head">
                  <span>第 {position + 1} 题</span>
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" onClick={() => setQuestions(questions.filter((_, i) => i !== position))}>
                    删除题目
                  </button>
                </div>
                <div className="zx-field">
                  <label>题干</label>
                  <input
                    value={question.question}
                    onChange={(event) => setQuestions(questions.map((item, i) => (i === position ? { ...item, question: event.target.value } : item)))}
                  />
                </div>
                <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: '#4b4560' }}>选项（选中左侧圆点即为正确答案）</div>
                {question.options.map((option, optionIndex) => (
                  <div className="zx-option-row" key={`${question.id}-${optionIndex}`}>
                    <input
                      type="radio"
                      name={`correct-${question.id}`}
                      checked={question.correct === optionIndex}
                      onChange={() => setQuestions(questions.map((item, i) => (i === position ? { ...item, correct: optionIndex } : item)))}
                      aria-label={`把第 ${optionIndex + 1} 个选项设为正确答案`}
                    />
                    <input
                      type="text"
                      value={option}
                      placeholder={`选项 ${optionIndex + 1}`}
                      onChange={(event) => setQuestions(questions.map((item, i) => (
                        i === position
                          ? { ...item, options: item.options.map((value, oi) => (oi === optionIndex ? event.target.value : value)) }
                          : item
                      )))}
                    />
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-ghost"
                      disabled={question.options.length <= 2}
                      onClick={() => setQuestions(questions.map((item, i) => {
                        if (i !== position) return item;
                        const options = item.options.filter((_, oi) => oi !== optionIndex);
                        return { ...item, options, correct: Math.min(item.correct, options.length - 1) };
                      }))}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="zx-btn zx-btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => setQuestions(questions.map((item, i) => (i === position ? { ...item, options: [...item.options, ''] } : item)))}
                >
                  添加选项
                </button>
                <div className="zx-form" style={{ marginTop: 12 }}>
                  <div className="zx-field zx-field-full">
                    <label>答案解析</label>
                    <textarea
                      value={question.explanation}
                      onChange={(event) => setQuestions(questions.map((item, i) => (i === position ? { ...item, explanation: event.target.value } : item)))}
                    />
                  </div>
                  <div className="zx-field">
                    <label>知识点标签</label>
                    <input
                      value={question.theoryTitle}
                      onChange={(event) => setQuestions(questions.map((item, i) => (i === position ? { ...item, theoryTitle: event.target.value } : item)))}
                    />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="zx-btn zx-btn-sm" style={{ marginTop: 10 }} onClick={() => setQuestions([...questions, emptyQuestion()])}>
              添加题目
            </button>
          </>
        ) : (
          <div className="zx-form">
            <div className="zx-field zx-field-full">
              <label htmlFor="content-json">讲义 JSON（sections / slides）</label>
              <textarea
                id="content-json"
                className="zx-mono"
                value={contentJson}
                onChange={(event) => setContentJson(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="zx-field zx-field-full">
              <label htmlFor="quiz-json">测验 JSON（题目数组）</label>
              <textarea
                id="quiz-json"
                className="zx-mono"
                value={quizJson}
                onChange={(event) => setQuizJson(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="zx-field zx-field-full">
              <label htmlFor="sources-json">来源标注 JSON（数组）</label>
              <textarea
                id="sources-json"
                className="zx-mono"
                style={{ minHeight: 110 }}
                value={sourcesText}
                onChange={(event) => setSourcesText(event.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
        )}
      </div>

      <div className="zx-savebar">
        <span className="zx-savebar-meta">
          {saving ? '正在保存…' : dirty ? '有未保存的修改' : '内容已保存'}
        </span>
        <span>
          <button type="button" className="zx-btn zx-btn-ghost" disabled={saving || !dirty} onClick={() => { applyLesson(lesson); setMessage('已放弃未保存的修改。'); setError(''); }}>
            放弃修改
          </button>
          <button type="button" className="zx-btn zx-btn-primary" style={{ marginLeft: 8 }} disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存课时'}
          </button>
        </span>
      </div>
    </div>
  );
}
