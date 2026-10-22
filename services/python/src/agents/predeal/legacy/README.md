# legacy/ —— v1 管线只读留档

> 状态：**deprecated，只读留档**，不属于 `predeal` 可导入包（不在 `src/predeal/` 下），不会被安装、不会被任何代码 import。
> 来源：《817行动方案-Agent执行手册》T5.3 唯一事实源收敛（2026-08-17）。

## 目录内容

| 文件 | 说明 |
| --- | --- |
| `pipeline.py` | v1 管线主编排器（`process_document` / `process_domain`）。曾被 `predeal/cli.py` 的 `process` 命令与 `predeal/web/app.py` 的 `/api/run` 接口调用，均已在 T5.3 中断开。 |
| `steps/ragflow_packager.py` | v1 专用的 RAGFlow 打包/上传步骤（`package_for_ragflow` / `upload_to_ragflow`），只被 `pipeline.py` 引用，随其一并归档。 |

## 为什么归档

- v1 管线依赖的 `ragflow_client.py`（v1 版本）已在同一次改动中删除（`ragflow_client2.py` 更名为 `ragflow_client.py` 取而代之，API 不完全兼容，例如 v1 独有的 `RAGFlowClient.retrieve()` 在新文件中不存在）。
- 现网实际维护、持续演进的是 `predeal/pipeline2.py`（配套 `predeal/cli2.py`、`predeal/upload_service.py`、`predeal/steps/ragflow_packager2.py`）。

## 现在应该用什么代替

- CLI：`predeal2`（`predeal.cli2:cli`，`pyproject.toml` 新增的 console script）的 `process` / `upload` 命令。
- Web：`POST /api/v1/uploads`（`predeal/web/app.py`，走 `upload_service.py` → `pipeline2.py`）。
- 直接调用旧的 `predeal process` CLI 或旧的 `/api/run` 接口会收到明确的报错提示，指向上述替代入口。

## 注意

- 本目录下文件的 `from .xxx import ...` 相对导入语句是移动前的原样保留（用于比对/审计），**不保证仍可正常 import 运行**——它们已不在 Python 包路径内，任何"顺手"把它们重新接回主流程的改动都需要重新走一次评审（唯一事实源、RAGFlow 版本锁定等约束）。
- 若确认后续彻底不再需要参考，可整体删除本目录。
