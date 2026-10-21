# 学员对话联调约定（2026-10-21）

- 使用管理员已有对话模型槽位及密钥，不新增网关或写入真实密钥；服务端继续纯仓颉。
- 沿用 POST /api/tutor/chat，保留 message、quote、courseId、lessonIndex、lessonTitle。
- 增量请求字段：history 为 role/content 消息数组（仅 user/assistant，服务端限长）；attachments 为 {type:"image",name,mimeType,dataUrl} 数组。
- 图片仅接受 PNG/JPEG/WebP，客户端压缩，最多 3 张；服务端校验真实 MIME/解码长度并限制总量。仅有图片也允许提问。
- 响应沿用 answer、citations；可增加 model。既有纯文本调用保持兼容，错误明确提示，禁止静默降级忽略图片。
- 课程/章节上下文与引用保留；多轮历史有界，切换章节不串会话；沿用现有历史接口。
- 前端保留紫色页面，补图片选择/预览/移除、发送中/失败重试和 Markdown 回答；不要出现可点却无实现的控件。
- 后端负责 services/learning/src/main.cj 的 tutor 路由、独立 tutor 源文件与相关测试；前端负责 tutor.js、对话组件、RecoveredApp.jsx 的接线及样式。
- 主 agent 同时修改 LearnerResources.jsx、admin/CoursewareView.jsx、Markdown 相关工具以及 PPT 生成链。子 agent 不改这些文件，不重启服务，不提交 Git；最终由主 agent 验收、写 TRACE、统一提交与部署。
