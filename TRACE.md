# 操作与对话记录

> 只追加不删除。新条目写在最下面，写清时间、范围、涉及文件、提交号、验证结果。

## 2026-10-14 项目立项与产品定义

- 用户决定：参照 ITN 做桌面版，不接后端、不要登录账号，只体现功能；知识库改由用户自己定义；Agent 相关 API 配置全部由用户自配；使用仓颉语言开发；只借鉴旧版本思路，其余重写。
- 技术选型确认过程：查证仓颉官方 UI 能力面向鸿蒙设备，Windows 桌面无官方 GUI 库；社区有 CUI（自渲染、SDL 底层）和 CJQT（Qt 封装）两条纯仓颉路线，但框架年轻。用户确认"如果没有合适且成熟的 GUI 框架就算了，用 Electron 也可以"，但明确不要做成网页版应用。
- 功能口径确认：知识库只支持 Markdown 与纯文本，Markdown 需支持图片；含图片的知识库要求切片模型支持多模态；模型统一 OpenAI 格式，用户可自行新增、配置、切换。
- 战略口径确认：与 ITN 仓颉迁移并行推进，属于后手方案；不考虑其他人力分工，由本窗口单独完成，越快越好；目标仍是投稿仓颉杯。
- 本机环境侦察结果：Visual Studio 生成工具 2022（MSVC 14.44.35207）与 Windows SDK 10.0.26100 已安装，满足仓颉 Windows 工具链的前置要求；D 盘剩余 94 GB。本机尚未安装仓颉工具链（`CANGJIE_HOME` 为空，无 `cjc`/`cjpm`）。
- 发现的问题：官方下载页需要登录，下载接口 `cangjie-lang.cn/v1/files/auth/downLoad` 需要 `objectKey` 参数，无法直接匿名获取 Windows 安装包；另外官网已有 1.2.0 STS。
- 本次产出：建立 `D:\Desktop\ITN\ITN-Desktop` 目录，写下 `PRODUCT.md` 产品定义、`docs/01-架构与分工.md`、`docs/02-接口契约.md` 草案，以及 `core/`、`shell/`、`scripts/` 骨架说明。
- 待办：确认产品定义与待讨论项；取得仓颉 Windows 安装包；完成技术验证。

## 2026-10-14T01:35:42+08:00 工具链就位 + Agent 架构定稿

- 用户明确两点：工具链由我自行获取，不再确认；讨论重心转向业务实现与架构，参考 Pi Agent 与 DeepSeek Harness 的架构思想（非源码），用仓颉实现。
- 下载地址攻破过程：官网是 Vue 单页应用，`preDownLoad` 是登录校验接口（匿名返回 data:null）；真实下载地址是 `/v1/files/auth/downLoad?nsId=142267&fileName=<包名>&objectKey=<对象键>`，objectKey 藏在 JS chunk `csdnimg.cn/release/devpress-cangjie/public/js/chunk/organization/download/version.560a3b27.js` 的页面数据里。按文件名在该 chunk 内检索即可得到完整 url 与 sha256。
- 已下载并校验（SHA256 与官网一致）：
  - `cangjie-sdk-windows-x64-1.2.0.zip`（250.7MB，sha 7bd5088a…250bf，发布于 2026-09-22）
  - `cangjie-sdk-windows-x64-1.1.3.zip`（374MB，sha 8bb65499…7da72，发布于 2026-05-29）
  落盘于 `D:\cangjie-sdk\_downloads\`。
- 已解压 1.2.0 至 `D:\cangjie-sdk\1.2.0\cangjie`，dot-source `envsetup.ps1` 后实测：`cjc --version` = Cangjie Compiler 1.2.0 (cjnative)，Target x86_64-w64-mingw32；编译并运行 hello world 成功（中文输出正常）；`cjpm --version` = 1.2.0。前置条件是本机已有的 Visual Studio 生成工具 2022 与 Windows SDK 10.0.26100。
- 新建 `docs/03-Agent架构.md`，记录从 Pi Agent 借鉴的三层分离、事件流、流式解析不完整 JSON；从 DeepSeek Harness 借鉴的会话日志即唯一真相、turn/step 显式生命周期、事件分域、模式即工具集组合；明确不照搬全套插件系统、多供应商适配层、沙箱审批。并给出仓颉模块划分与第一版工具集、引用自检与上下文治理，以及"生成讲义"的完整 turn 生命周期。
- 本轮未写业务代码，无接口变更。

## 2026-10-14T01:49:49+08:00 技术验证全部通过 + 内核骨架可运行

- 用户指令：架构方案定稿后由我自行决定实现方式并直接进入目标模式开发。已创建目标（objective 记录在本轮），不再逐项确认。
- 自取工具链：官网下载页是 Vue 单页应用，`preDownLoad` 为登录校验接口（匿名 data:null）；真实地址 `/v1/files/auth/downLoad?nsId=142267&fileName=<包>&objectKey=<键>`，objectKey 与 SHA256 藏在 JS chunk `version.560a3b27.js`。已下载并校验 1.2.0（250.7MB）与 1.1.3（374MB）两个 Windows 包。
- STDX 不在 SDK 内，从 gitcode releases 取 `cangjie-stdx-windows-x64-1.2.0.1.zip`（21.3MB）。
- OpenSSL 3 是 stdx 的硬依赖。本机 Git 自带 3.2.4 但缺导入库；改从 MSYS2 取 `mingw-w64-x86_64-openssl-3.6.5-1`，只提取 `libssl.dll.a`、`libcrypto.dll.a`、`libssl-3-x64.dll`、`libcrypto-3-x64.dll`，落盘 `D:\cangjie-sdk\1.2.0\openssl`。
- 建立 `core/` 仓颉工程：`cjpm.toml` + `src/main.cj`（stdx.net.http 服务、系统分配端口、/health、/selftest/tls 自检）与 `scripts/env.ps1`、`build.ps1`、`package.ps1`。
- 踩坑与修复：Cangjie 类型名是 `Bool` 不是 `bool`；`Exception.message` 已是 `String` 不能 `??`；JSON 内嵌引号改用 `#"..."#` 原始字符串；链接必须补 `-lcrypt32`，否则 `libstdx.crypto.x509.a` 报 `CertEnumCertificatesInStore` 未定义。
- 三项验证全部通过：① 本地 HTTP 系统分配端口、200/404 正常；② HTTPS 出网 `cangjie-lang.cn`、`baidu` 均 200（`example.com` 失败是本机代理拦截）；③ 干净环境（PATH 仅 System32）下仅需 4 个 DLL、共约 17MB 即可运行并完成 HTTPS 调用。
- 已知问题：`println` 写入管道被缓冲，端口号要等进程退出才出现，Electron 握手不能依赖 stdout，后续改为写端口文件。
- 本轮无接口契约变更（本地自检接口仅用于技术验证）。
