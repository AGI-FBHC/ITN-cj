/* ITN QuestionBank 前端逻辑（Vue 3，无构建） */
const { createApp } = Vue;

createApp({
  data() {
    return {
      tab: 'practice',
      userId: localStorage.getItem('qb.userId') || 'demo-user',
      categories: [],          // 原始覆盖报告 items（平铺）
      practice: {
        categoryId: null,
        questionType: '',
        difficulty: '',
        count: 5,
        questions: [],
        strategy: null,
        error: '',
      },
      history: [],
      createForm: {
        question_type: 'single_choice',
        difficulty: 3,
        cognitive_level: 'understand',
        stem: '',
        options: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }],
        answer: 'A',
        explanation: '',
        categoryId: null,
      },
      createResult: '',
      createError: '',
      creating: false,
      aiForm: { categoryId: null, questionType: '', difficulty: '', count: 3 },
      aiResult: null,
      aiError: '',
      aiLoading: false,
      stats: { overview: { total: 0, by_status: {}, by_type: {}, by_difficulty: {} }, byCategory: [] },
      reviewQueue: [],
    };
  },

  computed: {
    /** 按 level2 章节分组的知识点（level3） */
    categoryGroups() {
      const chapters = this.categories.filter(c => c.level === 2);
      const kps = this.categories.filter(c => c.level === 3);
      const groups = [];
      for (const ch of chapters) {
        groups.push({ id: ch.category_id, name: ch.name, children: [] });
      }
      // 匹配父级：coverage 报告无 parent_id 映射关系，按顺序归入最近的章节组
      let gi = 0;
      for (const kp of kps) {
        while (gi < groups.length - 1 && groups[gi + 1].id < kp.category_id) gi++;
        if (groups.length) groups[gi].children.push(kp);
      }
      return groups.filter(g => g.children.length);
    },
    answeredCount() {
      return this.practice.questions.filter(q => q.answered).length;
    },
    /** 统计矩阵：题目聚合（by-category）合并知识点覆盖（categories） */
    matrix() {
      const byId = {};
      for (const item of this.stats.byCategory) byId[item.category_id] = item;
      const coverage = {};
      for (const c of this.categories) coverage[c.category_id] = c;
      const rows = [];
      const ids = new Set([...Object.keys(byId).map(Number), ...Object.keys(coverage).map(Number)]);
      for (const cid of ids) {
        const s = byId[cid] || { total: 0, active: 0, by_difficulty: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
        const cov = coverage[cid] || {};
        if (!cov.name && !s.name) continue;
        rows.push({ ...s, name: s.name || cov.name, chunk_count: cov.chunk_count || 0, gap: cov.gap || '' });
      }
      rows.sort((a, b) => b.total - a.total || b.chunk_count - a.chunk_count);
      return rows;
    },
  },

  watch: {
    userId(v) { localStorage.setItem('qb.userId', v); },
    'practice.categoryId'(v) { this.createForm.categoryId = v; },
  },

  methods: {
    // ── 通用 ────────────────────────────────────────────────────────────
    async api(path, options = {}) {
      const resp = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const detail = body.detail || resp.statusText;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      return body;
    },
    typeLabel(t) {
      return { single_choice: '单选', multiple_choice: '多选', true_false: '判断', short_answer: '简答' }[t] || t;
    },
    diffHint(d) { return ['直接回忆', '单点理解', '单点应用', '组合分析', '综合迁移'][d - 1] || ''; },
    displayAnswer(a) {
      if (a === null || a === undefined) return '—';
      if (Array.isArray(a)) return a.join('、');
      if (typeof a === 'boolean') return a ? '正确' : '错误';
      return String(a);
    },
    isoNow() { return new Date().toISOString(); },

    // ── 数据加载 ────────────────────────────────────────────────────────
    async loadCategories() {
      try {
        const data = await this.api('/v1/questions/categories');
        this.categories = data.items || [];
      } catch (e) {
        console.warn('加载知识点失败:', e);
      }
    },
    async loadHistory() {
      if (!this.userId) return;
      try {
        const data = await this.api(`/v1/practice/attempts?user_id=${encodeURIComponent(this.userId)}&size=8`);
        this.history = data.items || [];
      } catch (e) { /* 静默 */ }
    },
    async loadReviewQueue() {
      try {
        const data = await this.api('/v1/questions/review-queue?size=50');
        this.reviewQueue = data.items || [];
      } catch (e) { console.warn(e); }
    },

    // ── 刷题 ────────────────────────────────────────────────────────────
    async startPractice() {
      this.practice.error = '';
      this.practice.questions = [];
      try {
        const params = new URLSearchParams({ user_id: this.userId, count: this.practice.count });
        if (this.practice.categoryId) params.set('category_id', this.practice.categoryId);
        if (this.practice.questionType) params.set('question_type', this.practice.questionType);
        if (this.practice.difficulty) params.set('difficulty', this.practice.difficulty);
        const data = await this.api(`/v1/practice/questions?${params}`);
        this.practice.questions = (data.items || []).map(q => ({ ...q, selected: null, answered: false, correct: null, score: null, feedback: '', matched: [], missing: [] }));
        this.practice.strategy = data.strategy || null;
        if (!this.practice.questions.length) {
          this.practice.error = '没有符合条件的题目（可能近期都做过了），试试调整筛选或先到「新增题 / 审核」丰富题库。';
        }
      } catch (e) {
        this.practice.error = '取题失败：' + e.message;
      }
    },
    async submitOne(q) {
      try {
        const payload = {
          user_id: this.userId,
          question_id: q.id,
          submitted_answer: q.selected,
          duration_ms: 30000,
        };
        const res = await this.api('/v1/practice/submit', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        q.answered = true;
        q.correct = res.is_correct;
        q.score = res.score;
        if (res.judge_details) {
          q.feedback = res.judge_details.feedback || '';
          q.matched = res.judge_details.matched_points || [];
          q.missing = res.judge_details.missing_points || [];
        }
        if ('reference_answer' in res) q.reference_answer = res.reference_answer;
        if ('explanation' in res) q.explanation = res.explanation;
        this.loadHistory();
      } catch (e) {
        q.answered = true; // 出错也标为已答，避免卡住
        q.correct = null;
        alert('提交失败：' + e.message);
      }
    },

    // ── 新增题 ──────────────────────────────────────────────────────────
    addOption() { if (this.createForm.options.length < 8) this.createForm.options.push({ text: '' }); },
    removeOption(i) { if (this.createForm.options.length > 2) this.createForm.options.splice(i, 1); },
    async submitCreate() {
      this.createError = '';
      this.createResult = '';
      const f = this.createForm;
      if (!f.stem) { this.createError = '题干不能为空'; return; }
      const payload = {
        question_type: f.question_type,
        difficulty: f.difficulty,
        cognitive_level: f.cognitive_level,
        stem: f.stem,
        reference_answer: f.answer,
        explanation: f.explanation || null,
        source_type: 'human',
        created_by: this.userId || 'human',
      };
      if (['single_choice', 'multiple_choice'].includes(f.question_type)) {
        const options = f.options
          .map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text.trim() }))
          .filter(o => o.text);
        if (options.length < 2) { this.createError = '选择题至少需要 2 个有效选项'; return; }
        payload.options = options;
        if (f.question_type === 'multiple_choice') {
          if (!Array.isArray(f.answer) || f.answer.length < 2) { this.createError = '多选题至少选择 2 个正确答案'; return; }
        }
      }
      if (f.categoryId) {
        payload.knowledge_points = [{ category_id: f.categoryId, role: 'primary', weight: 1.0 }];
      }
      this.creating = true;
      try {
        const q = await this.api('/v1/questions', { method: 'POST', body: JSON.stringify(payload) });
        this.createResult = `✅ 已创建题目 #${q.id}（状态：${q.status}，审核通过后即可被刷到）`;
        f.stem = ''; f.explanation = ''; f.answer = 'A';
        this.loadReviewQueue();
      } catch (e) {
        this.createError = '创建失败：' + e.message;
      } finally {
        this.creating = false;
      }
    },

    // ── AI 出题 ────────────────────────────────────────────────────────────
    async runAiGenerate() {
      this.aiError = '';
      this.aiResult = null;
      this.aiLoading = true;
      try {
        const payload = {
          category_id: this.aiForm.categoryId,
          count: this.aiForm.count || 3,
          created_by: this.userId || 'llm',
        };
        if (this.aiForm.questionType) payload.question_type = this.aiForm.questionType;
        if (this.aiForm.difficulty) payload.difficulty = this.aiForm.difficulty;
        this.aiResult = await this.api('/v1/questions/generate', {
          method: 'POST', body: JSON.stringify(payload),
        });
        this.loadReviewQueue();
        this.loadStats();
      } catch (e) {
        let msg = e.message;
        try {
          const d = JSON.parse(msg);
          if (d.code === 'QUESTION_GENERATION_INSUFFICIENT_EVIDENCE') {
            msg = '该知识点知识切片覆盖不足，无法出题（质量底线）。请先补充知识库内容。';
          } else if (d.message) msg = d.message;
        } catch (_) { /* 保留原始消息 */ }
        this.aiError = '出题失败：' + msg;
      } finally {
        this.aiLoading = false;
      }
    },
    /** 统计页快捷出题：跳到新增题 tab 并预填知识点 */
    quickAiGenerate(row) {
      this.aiForm.categoryId = row.category_id;
      this.aiForm.count = 3;
      this.tab = 'create';
      document.querySelector('#ai-panel')?.scrollIntoView({ behavior: 'smooth' });
    },
    gapLabel(g) {
      return { ok: '充足', below_threshold: '偏少', no_chunks: '无切片' }[g] || g || '—';
    },

    // ── 题库看板 ──────────────────────────────────────────────────────────
    async loadStats() {
      try {
        const [overview, byCat] = await Promise.all([
          this.api('/v1/questions/stats/overview'),
          this.api('/v1/questions/stats/by-category'),
        ]);
        this.stats.overview = overview;
        this.stats.byCategory = byCat.items || [];
      } catch (e) {
        console.warn('加载统计失败:', e);
      }
    },

    // ── 审核 ────────────────────────────────────────────────────────────
    async reviewQuestion(id, status) {
      try {
        await this.api(`/v1/questions/${id}/review?status=${status}`, { method: 'POST' });
        this.loadReviewQueue();
      } catch (e) {
        alert('操作失败：' + e.message);
      }
    },
  },

  async mounted() {
    await this.loadCategories();
    await this.loadReviewQueue();
    await this.loadHistory();
    await this.loadStats();
  },
}).mount('#app');
