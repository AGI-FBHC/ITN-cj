# 前端开发史（抽快照前的提交清单）

本分支保留**完整提交历史（942 条）**，可以直接 `git log` 查。下面是最近 60 条作为快速索引。
每条改动更细的说明在主仓库：`docs/change-trace.md`、`docs/frontend/全链路测试与修复计划.md`、`docs/frontend/BUG与接口协作记录.md`。

```text
4b91923 2026-10-15 feat(front): 新增「学习日志」页 /me/journal（W7），三个入口都能进
bd19a98 2026-10-15 feat(front): 实操指南补「可勾选验收清单」与「常见故障」（W5）
e2ea8c4 2026-10-15 fix(front): 交互课件播放页拿到的是错的 id（幻灯图永远转圈）+ 补下载入口（W4）
b87dc5e 2026-10-15 feat(front): 领域知识库补「知识配图」（图示 + VLM 描述 + 大图），W3
cfade61 2026-10-15 feat(front): 学 · 练 补章节侧栏（核心技能 + 推荐资源），首页补最近学习轨迹（W2 收口）
f3992fe 2026-10-15 feat(front): 我的成长补上「计划完成度」与「资源偏好」两块（W2）
23d7f75 2026-10-15 fix(front): 首页别再说假话——没有课程不等于没有资料，加载期不报 0
484910a 2026-10-14 feat(front): render math and syntax-highlighted code across all markdown surfaces
3854253 2026-10-14 chore(front): drop the expert/评委 view leftovers; fix the dev-server IPv6 stall
0c316a2 2026-10-14 fix(front): re-attach the companion pet after the shell rewrite
19fbd95 2026-10-14 chore(front): track the companion assets and exempt public pngs from the global ignore
d071314 2026-10-14 feat(front): bring the companion mascot back and plan the legacy parity work
e40a13c 2026-10-14 chore(front): remove the judge tour feature and all of its entries
de1c6f3 2026-10-14 fix(front): report full-reading quiz answers to the profile mastery as well
ac9db71 2026-10-14 fix(front): report agent-dock practice answers to the profile mastery too
ffe05f5 2026-10-14 fix(resource+profile): report quiz attempts to mastery and stop the adaptive set from growing
9d37758 2026-10-14 feat(front): show the five-agent roster on the empty coordination page
84dbcae 2026-10-14 feat(front): resume a finished quiz on its last card and add the demo acceptance checklist
b1ff24f 2026-10-14 fix(front): clear the tour start flag so it cannot hijack later reloads
6c6bbf2 2026-10-14 fix(front): wire the judge tour, fix the tutoring crash and the one-way view mode
3a8c490 2026-10-14 docs+ux(front): make the agents entry honest about its empty state
5e8734d 2026-10-14 fix(front): expose session actions and align the quiz completion copy
24e97f0 2026-10-14 fix(front): reflect just-answered quiz cards and drop the auto-advance promise
efba4e7 2026-10-14 fix(front): label answered quiz cards and resume at the pending question
92b6668 2026-10-14 fix(front): unify learner practice entry and surface ops admin pages
566802d 2026-10-14 fix(front): stop duplicating assistant history after reload
b32259b 2026-10-14 feat(front): show readable source titles instead of doc_*.md filenames
bfc0de4 2026-10-13 fix(front): correct the 洁道 typo (the source stored it as an escaped literal)
3e84fd6 2026-10-13 fix(front): label the slide header for failed/cancelled custom tasks
6457f96 2026-10-13 fix(agents): always persist a terminal state when custom generation fails
e8a9d27 2026-10-13 feat(front): give learner pages a discoverable 更多 entry
e86e5ea 2026-10-13 fix(front): label which pipeline the knowledge metrics come from
8234480 2026-10-13 fix(admin): show knowledge point names in the graph overview edge list
72f8c44 2026-10-13 fix(admin): make the header service status agree with the module table
732e3b6 2026-10-13 fix(front): make the command-palette knowledge search use the real RAG index
82c93fe 2026-10-13 fix(front): list per-knowledge-point custom resources on the resources page
1eb7955 2026-10-13 fix(front): surface profile meta failures instead of an endless loading state
283843e 2026-10-13 fix(front): treat naive API timestamps as UTC so note times stop shifting 8 hours
cb58653 2026-10-13 fix(front): give the knowledge base page slow-load feedback and a retry
a0b687c 2026-10-13 fix(front): balance stray emphasis markers in generated lecture text
3db5b0e 2026-10-13 fix(front): stop report crash and unblock quiz answering on narrow screens
bc2641d 2026-10-13 feat(frontend): simplify learner-facing copy and remove demo claims
a28c6d3 2026-09-05 docs: remove process-only documents from repository
2149251 2026-09-05 fix(ui): keep step code/output/reminder in practice slides and clean list bullets
335e63b 2026-09-05 fix: align agent image stream multipart field names
df30b0c 2026-09-05 fix(onboarding): stabilize knowledgePoints memo to prevent React #310 loop
90ace35 2026-09-05 fix(ui): stop splitting version numbers and support chinese citation marks
4046a81 2026-09-05 fix(ui): auto wrap compact numbered content in markdown
47caeeb 2026-09-04 fix(ui): fall back execution summary to event detail
8c044be 2026-09-04 chore(ui): remove profile confidence badge from learner pages
bbcd255 2026-09-04 fix(ui): adaptive quiz exit button and restore answered state
ad97901 2026-09-04 fix(ui): resume narration on slide pages instead of restarting
94dae7d 2026-09-04 fix(ppt): keep audio currentTime when resuming after pause
dcc0a19 2026-09-04 feat(agents): make graded quiz adaptive with five dynamic questions
6202523 2026-09-04 perf(admin): debounce resource center search and cache group lists
5b057f8 2026-09-04 fix(ui/agents): require and parse inline citation marks in lecture/slides
fd82b1b 2026-09-04 fix(ui/tts): spell LLM as L L M for pages and speech
fbe599d 2026-09-04 fix(admin): remove resource center stats labels and counts
7a637d6 2026-09-04 fix(admin): remove resource center stats badges
bc30b1b 2026-09-04 fix(kb): serve knowledge evidence images through https proxy
```

