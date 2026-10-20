import * as React from 'react';
import { Notice } from './admin-ui.jsx';
import Markdown from './Markdown.jsx';

function readJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function LectureView({ data }) {
  return (
    <div className="zx-cw-doc">
      {Array.isArray(data.objectives) && data.objectives.length > 0 ? (
        <ul className="zx-cw-objectives">
          {data.objectives.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : null}
      {(data.sections || []).map((section, index) => (
        <section key={index} className="zx-cw-section">
          <h3>{section.heading || `第 ${index + 1} 节`}</h3>
          <Markdown text={section.body || ''} />
        </section>
      ))}
    </div>
  );
}

function GuideView({ data }) {
  const steps = data.steps || [];
  return (
    <div className="zx-cw-doc">
      {data.objective ? <p className="zx-cw-lead">{data.objective}</p> : null}
      <div className="zx-cw-meta-row">
        {data.estimatedMinutes ? <span>预计 {data.estimatedMinutes} 分钟</span> : null}
        {Array.isArray(data.prerequisites) && data.prerequisites.length ? <span>前置：{data.prerequisites.join('、')}</span> : null}
        {Array.isArray(data.environment) && data.environment.length ? <span>环境：{data.environment.join('、')}</span> : null}
      </div>
      {steps.map((step, index) => (
        <article key={index} className="zx-cw-step">
          <header>
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{step.title || `第 ${index + 1} 步`}</strong>
            {step.safety && step.safety !== 'safe' ? (
              <span className="zx-pill zx-pill-draft">{step.safety === 'danger' ? '高风险' : '注意'}</span>
            ) : null}
          </header>
          <Markdown text={step.instruction || ''} />
          {step.code ? <pre className="zx-cw-code"><code>{step.code}</code></pre> : null}
          {step.expectedOutput ? <p className="zx-cw-expect">预期结果：{step.expectedOutput}</p> : null}
          {step.warning ? <p className="zx-cw-warn">{step.warning}</p> : null}
        </article>
      ))}
      {Array.isArray(data.acceptanceCriteria) && data.acceptanceCriteria.length ? (
        <section className="zx-cw-section">
          <h3>验收标准</h3>
          <ul>{data.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
      ) : null}
      {Array.isArray(data.troubleshooting) && data.troubleshooting.length ? (
        <section className="zx-cw-section">
          <h3>常见问题</h3>
          {data.troubleshooting.map((item, index) => (
            <p key={index} className="zx-cw-trouble"><strong>{item.problem}</strong>：{item.solution}</p>
          ))}
        </section>
      ) : null}
      {data.challenge ? (
        <section className="zx-cw-section">
          <h3>进阶挑战</h3>
          <Markdown text={data.challenge} />
        </section>
      ) : null}
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
      {data.subtitle ? <p className="zx-cw-lead">{data.subtitle}</p> : null}
      {slides.map((slide, index) => (
        <article key={index} className="zx-cw-slide">
          <header>
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{slide.title || `第 ${index + 1} 页`}</strong>
          </header>
          <ul>{(slide.bullets || []).map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul>
          {slide.speakerNote ? <p className="zx-cw-note">讲稿：{slide.speakerNote}</p> : null}
        </article>
      ))}
    </div>
  );
}

export function CoursewareContent({ kind, content }) {
  const data = typeof content === 'string' ? readJson(content) : content;
  if (!data) return <Notice kind="info">还没有产出内容。</Notice>;
  if (kind === 'guide') return <GuideView data={data} />;
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
