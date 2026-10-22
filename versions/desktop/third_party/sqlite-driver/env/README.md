# 运行环境

`sqlite-driver` 是嵌入式文件数据库，不需要 Docker 或外部数据库服务。示例与测试只依赖本机仓颉工具链和扩展标准库动态库。

## 必备变量

| 变量 | 说明 |
| --- | --- |
| `CANGJIE_STDX_PATH` | 扩展标准库动态库目录，运行期必须能找到其中的 `.so` |
| `LD_LIBRARY_PATH` | 应包含 `CANGJIE_STDX_PATH`；脚本会自动追加 |

复制示例配置后按本机路径修改：

```bash
cd sqlite-driver/env
cp .env.example .env
# 编辑 .env，把 CANGJIE_STDX_PATH 改成真实目录
```

加载方式：

```bash
set -a
source ./env/.env
set +a
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
```

`examples/run_all.sh` 与 `build/*.sh` 会在已设置 `CANGJIE_STDX_PATH` 时直接使用；若当前 shell 未设置，且存在 `env/.env`，`run_all.sh` 会自动加载。

## 可选变量

| 变量 | 说明 |
| --- | --- |
| `cjHeapSize` | 仅在本机内存紧张、运行大型测试矩阵时需要，例如 `1gb`。单个示例子项目通常不必设置 |
| `TMPDIR` | 文件库示例创建临时数据库的目录；默认使用系统临时目录 |

## 自检

```bash
command -v cjpm
test -d "$CANGJIE_STDX_PATH"
ls "$CANGJIE_STDX_PATH" | head
```

确认 `cjpm` 可用，且 `CANGJIE_STDX_PATH` 指向包含扩展标准库动态库的目录后，即可构建根项目或运行示例。

## 相关命令

```bash
# 根项目
./build/build.sh

# 全部示例（含结果判定）
cd examples && ./run_all.sh
```

详细说明见 [验证说明](../docs/verification.md) 与 [示例导航](../examples/README.md)。
