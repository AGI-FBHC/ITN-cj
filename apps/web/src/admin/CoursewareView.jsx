import * as React from 'react';
import { Notice } from './admin-ui.jsx';
import { adminToken } from './admin-api.js';
import PresentationArtifact from '../PresentationArtifact.jsx';
import { useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import CoursewareReferences, { CoursewareMarkdown } from '../CoursewareReferences.jsx';
import { chapterReference, coursewareReferences, normalizeCoursewareCitations } from '../courseware-references.js';

function readJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function LectureView({ data }) {
  const { coursewareId } = useParams();
  const savedReferences = React.useMemo(() => coursewareReferences(data), [data]);
  const [loaded, setLoaded] = React.useState(null);
  const prefix = `preview-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const references = savedReferences.length ? savedReferences : loaded?.id === coursewareId ? loaded.references : [];
  React.useEffect(() => {
    if (savedReferences.length || !coursewareId) return undefined;
    let active = true;
    // Old artifacts have no snapshot: resolve their real bound chapter read-only.
    adminApi.cwDetail(coursewareId).then(async ({ item }) => {
      if (!item?.bundleId || !item?.docId) return [];
      const { doc } = await adminApi.kbBundleDocument(item.bundleId, item.docId);
      return chapterReference(doc, item.bundleId);
    }).then((sources) => {
      if (active) setLoaded({ id: coursewareId, references: sources });
    }).catch(() => { if (active) setLoaded({ id: coursewareId, references: [] }); });
    return () => { active = false; };
  }, [coursewareId, savedReferences]);
  return (
    <div className="zx-cw-doc">
      {Array.isArray(data.objectives) && data.objectives.length > 0 ? (
        <ul className="zx-cw-objectives">
          {data.objectives.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : null}
      {(data.sections || []).map((section, index) => (
        <section key={index} className="zx-cw-section">
          <h3>{normalizeCoursewareCitations(section.heading || `第 ${index + 1} 节`, [])}</h3>
          <CoursewareMarkdown text={section.body || ''} references={references} prefix={prefix} audience="admin" />
        </section>
      ))}
      <CoursewareReferences references={references} prefix={prefix} />
    </div>
  );
}

function BankView({ data }) {
  const points = data.knowledgePoints || [];
  const questions = data.questions || [];
  return (
    <div className="zx-cw-doc">
      {points.length ? (
        <div className="zx-cw-points">
          {points.map((point) => <span key={point.id}>{point.name || point.id}</span>)}
        </div>
      ) : null}
      {questions.map((question, index) => (
        <article key={question.id || index} className="zx-cw-question">
          <div className="zx-cw-question-head">
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{question.stem || '（缺题干）'}</strong>
            {question.difficulty ? <span className="zx-cw-difficulty">{question.difficulty}</span> : null}
          </div>
          <ol className="zx-cw-options">
            {(question.options || []).map((option, optionIndex) => (
              <li key={optionIndex} className={optionIndex === question.correctIndex ? 'correct' : ''}>{option}</li>
            ))}
          </ol>
          {question.explanation ? <p className="zx-cw-explain">解析：{question.explanation}</p> : null}
        </article>
      ))}
    </div>
  );
}

function SlidesView({ data }) {
  const slides = data.slides || [];
  return (
    <div className="zx-cw-slides">
      {data.presentation ? <PresentationArtifact presentation={data.presentation} token={adminToken()} /> : null}
      {data.subtitle ? <p className="zx-cw-lead">{data.subtitle}</p> : null}
      {!data.presentation ? slides.map((slide, index) => (
        <article key={index} className="zx-cw-slide">
          <header>
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{slide.title || `第 ${index + 1} 页`}</strong>
          </header>
          <ul>{(slide.bullets || []).map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul>
          {slide.speakerNote ? <p className="zx-cw-note">讲稿：{slide.speakerNote}</p> : null}
        </article>
      )) : <details className="zx-cw-slide-data"><summary>查看结构化页面数据</summary>{slides.map((slide, index) => <article key={index} className="zx-cw-slide"><header><span className="zx-cw-step-index">{index + 1}</span><strong>{slide.title || `第 ${index + 1} 页`}</strong></header><ul>{(slide.bullets || slide.points || []).map((bullet, bulletIndex) => <li key={bulletIndex}>{typeof bullet === 'string' ? bullet : bullet.heading ? `${bullet.heading}：${bullet.detail || ''}` : JSON.stringify(bullet)}</li>)}</ul>{slide.speakerNotes || slide.notes || slide.speakerNote ? <p className="zx-cw-note">讲稿：{slide.speakerNotes || slide.notes || slide.speakerNote}</p> : null}</article>)}</details>}
    </div>
  );
}

export function CoursewareContent({ kind, content }) {
  const data = typeof content === 'string' ? readJson(content) : content;
  if (!data) return <Notice kind="info">还没有产出内容。</Notice>;
  if (kind === 'bank') return <BankView data={data} />;
  if (kind === 'slides') return <SlidesView data={data} />;
  return <LectureView data={data} />;
}

export function StepTimeline({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <div className="zx-cw-steps">
      {steps.map((step, index) => (
        <div key={index} className={`zx-cw-stepchip ${step.status}`}>
          <span className="zx-cw-stepchip-role">{step.role}</span>
          <span className="zx-cw-stepchip-text">{step.error || step.summary || '…'}</span>
        </div>
      ))}
    </div>
  );
}
