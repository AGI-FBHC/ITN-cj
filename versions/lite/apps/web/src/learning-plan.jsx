import React from 'react';
import './learning-plan.css';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

/** 学习计划面板：画像页展示真实生成的方案，并支持重新生成。 */
export function LearningPlanPanel({ plan, generatedAt, model, busy, error, onRegenerate }) {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const weeks = Array.isArray(plan?.weeklyPlan) ? plan.weeklyPlan : [];
  const milestones = Array.isArray(plan?.milestones) ? plan.milestones : [];
  const goals = Array.isArray(plan?.goals) ? plan.goals : [];
  const focusAreas = list(plan?.focusAreas);
  const risks = list(plan?.risks);

  const regenerate = (
    <button type="button" className="zx-plan-action" onClick={onRegenerate} disabled={busy}>
      {busy ? 'Lumin 正在规划…' : plan ? '重新生成' : '生成我的学习计划'}
    </button>
  );

  return (
    <section className="zx-memory-panel zx-plan-panel">
      <header className="zx-plan-head">
        <div>
          <h3>学习计划</h3>
          <p className="zx-plan-sub">
            {plan
              ? `由 Lumin 依据注册问卷与当前课程生成${model ? ` · ${model}` : ''}${generatedAt ? ` · ${generatedAt}` : ''}`
              : '完成注册问卷后，由 Lumin 结合当前已上架课程生成真实学习方案。'}
          </p>
        </div>
        {regenerate}
      </header>

      {error ? <p className="zx-plan-error" role="alert">{error}</p> : null}

      {!plan ? (
        <p className="zx-plan-empty">
          {busy ? '正在分析你的问卷答案与课程目录，请稍候…' : '还没有学习计划。点击右上角按钮生成。'}
        </p>
      ) : (
        <div className="zx-plan-body">
          {text(plan.summary) ? <p className="zx-plan-summary">{text(plan.summary)}</p> : null}

          <div className="zx-plan-facts">
            {plan.horizonWeeks ? <span><b>{plan.horizonWeeks}</b> 周周期</span> : null}
            {plan.weeklyHours ? <span>每周 <b>{plan.weeklyHours}</b> 小时</span> : null}
            {stages.length ? <span><b>{stages.length}</b> 个阶段</span> : null}
            {weeks.length ? <span><b>{weeks.length}</b> 周安排</span> : null}
          </div>

          {focusAreas.length ? (
            <div className="zx-plan-tags">
              {focusAreas.map((item) => <span key={item}>{item}</span>)}
            </div>
          ) : null}

          {goals.length ? (
            <div className="zx-plan-block">
              <h4>学习目标</h4>
              <ul className="zx-plan-goals">
                {goals.map((goal, index) => (
                  <li key={`${goal?.title || index}`}>
                    <strong>{text(goal?.title)}</strong>
                    {text(goal?.metric) ? <span>{text(goal?.metric)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {stages.length ? (
            <div className="zx-plan-block">
              <h4>阶段安排</h4>
              <ol className="zx-plan-stages">
                {stages.map((stage, index) => (
                  <li key={`${stage?.title || index}`}>
                    <div className="zx-plan-stage-head">
                      <span className="zx-plan-stage-order">{stage?.order || index + 1}</span>
                      <strong>{text(stage?.title)}</strong>
                      {stage?.weeks ? <em>{stage.weeks} 周</em> : null}
                    </div>
                    {text(stage?.focus) ? <p>{text(stage.focus)}</p> : null}
                    {list(stage?.courses).length ? (
                      <div className="zx-plan-chips">
                        {list(stage.courses).map((course) => <span key={course}>{course}</span>)}
                      </div>
                    ) : null}
                    {list(stage?.deliverables).length ? (
                      <ul className="zx-plan-deliverables">
                        {list(stage.deliverables).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {weeks.length ? (
            <div className="zx-plan-block">
              <h4>每周任务</h4>
              <div className="zx-plan-weeks">
                {weeks.map((week, index) => (
                  <article key={`${week?.week || index}`}>
                    <header>
                      <b>第 {week?.week || index + 1} 周</b>
                      <span>{text(week?.theme)}{week?.hours ? ` · ${week.hours}h` : ''}</span>
                    </header>
                    {list(week?.tasks).length ? (
                      <ul>
                        {list(week.tasks).map((task) => <li key={task}>{task}</li>)}
                      </ul>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {milestones.length || risks.length ? (
            <div className="zx-plan-two-col">
              {milestones.length ? (
                <div className="zx-plan-block">
                  <h4>里程碑</h4>
                  <ul className="zx-plan-milestones">
                    {milestones.map((item, index) => (
                      <li key={`${item?.title || index}`}>
                        <b>第 {item?.week || index + 1} 周 · {text(item?.title)}</b>
                        {text(item?.check) ? <span>{text(item.check)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {risks.length ? (
                <div className="zx-plan-block">
                  <h4>风险与应对</h4>
                  <ul className="zx-plan-risks">
                    {risks.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default LearningPlanPanel;
