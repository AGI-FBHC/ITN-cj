---
name: kb-harvest
title: 收集知识资料
description: 从公开网页或 GitHub 收集可追溯资料，先暂存，等用户检查后并入本机知识库
when_to_use: 用户要求找资料并加入知识库、收集一个网页或仓库
tools: [web_search, web_fetch, kb_stage, kb_ingest, list_documents]
requires_consent: web
---

# 收集知识资料

按用户给的主题找公开候选；已有链接时直接处理，不必机械搜索。
需要读候选时用 web_fetch。确定要收集后用 kb_stage：网页用 kind=url，
GitHub 用 kind=repo、url=owner/repo，ref 可选。

只汇报实际返回的 url、完整 commit、抓取时间、文件清单与跳过数量。
抓不到就报告原始原因，不编造抓取成功、文件内容或来源。

暂存不会进入索引。用 kb_ingest 给出用户确认入口：
领域知识库 → 收集资料 → 查看文件 → 选择目标库 → 确认并入。
模型没有代替用户确认的能力。用户未点击前，必须说“已暂存，待确认”。
并入后的内容整理与使用由用户决定，不额外生成重复笔记或产物。
