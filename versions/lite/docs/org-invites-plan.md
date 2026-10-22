# 机构邀请码与品牌同步计划（2026-10-21）

用户补充：注册必填机构邀请码；邀请码由机构设置；同机构用户显示同机构Logo；已有账号归江南大学。保持当前紫色前端，纯仓颉/Spire，无Docker。

## 共用接口约定

- 机构公开品牌：`{ id, name, shortName, logoUrl, hasLogo }`。`GET /api/org` 有学员Bearer时读所属机构，无Bearer时读默认江南大学；公共Logo URL包含机构ID及内容版本，不能跨机构串缓存。公开响应不包含邀请码。
- 管理员是现有全局管理角色，先沿用已有权限：`GET /api/admin/orgs` 返回 `{ organizations: [...] }`；`POST /api/admin/orgs` 用 `{ name, shortName, inviteCode }` 创建并返回该机构管理员详情。
- 现有 `/api/admin/org` GET/PUT 与 `/api/admin/org/logo` POST/DELETE 增加可选 `?orgId=...`，未传时保持默认机构兼容。管理员详情除品牌字段包含 `inviteCode`，PUT可设置唯一邀请码；同机构可多人使用，换码不影响既有账号归属。邀请码须经服务端校验、标准化与唯一约束，不写日志、Git或公开响应。
- `/api/auth/register` 接收必填 `inviteCode`，仅有效机构邀请码可注册；邮箱 `/api/auth/email-login` 若账号不存在也须校验 `inviteCode`，在验证通过前不得消费正确邮箱验证码。已有账号正常登录不要求邀请码，不允许借邀请码更换机构。
- 匿名学习会话/游客默认归江南大学，不视为正式注册；不得借游客会话建立可登录账号来绕过邀请码。已存在的所有用户安全回填江南大学，保留品牌Logo、会话、账号、课件和学习记录。
- `/api/org` 需从持久会话解析机构；认证后与账号切换时重载品牌，缓存按机构隔离，不展示上一账号的品牌。匿名登录前可用默认机构品牌。

## 分工与验证

- root：修学习方式弹窗，仅改 RecoveredApp.jsx、新增弹窗CSS；集成、真实验证、TRACE与本地Git提交。
- backend_resume：services/learning内组织数据/迁移、认证和品牌接口，实现后写清接口及迁移执行方法；不改前端、不提交、不擅自重启当前服务。
- learner_resource_ui：LoginPage.jsx、learning-api.jsx、org-brand.js、AdminOrg.jsx、admin-api.js及必要专属CSS；不改RecoveredApp或服务端，不提交。
- learner_resource_tests：新增机构邀请码与品牌真实契约验收脚本，全部用独立临时机构/用户/Logo，清理自身数据；不能改用户江南大学品牌或邀请码，不调用模型/真实发信，不修改模型设置。
- 验证新/旧账号归属，缺失/错误/重复/重置邀请码，邮箱首次登录无法绕过/验证码不被提前消费，不同机构Logo缓存隔离；编译和必要单测、接口测试、桌面与窄屏弹窗实看。最终所有功能与详细TRACE提交本地Git，不推送。
