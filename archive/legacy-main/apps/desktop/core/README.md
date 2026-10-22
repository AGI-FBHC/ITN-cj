# Desktop 仓颉本地内核

本工程使用仓颉 SDK 1.2.0，向 Electron 界面提供本地 HTTP 接口，处理知识库、会话、学习资源、画像和记忆等业务。SQLite 驱动通过 `../third_party/sqlite-driver` 源码依赖引入。

- `src/main.cj`：启动参数、本地服务入口与数据目录。
- `src/api/`：本地接口。
- `src/unittests/`：内核回归测试。
- `cjpm.toml`：Windows x64 构建及原生依赖配置。

构建、环境和打包步骤见 [Desktop README](../README.md)。打包产物位于 `../dist/core/`；直接运行 `target/` 内的程序时需要额外的运行库环境。

核心运行参数包括 `--data-dir`、`--ui-dir`、`--port-file`。检查时使用独立数据目录，避免写入个人正在使用的库。开发夹具和测试功能不代表正式用户流程。
