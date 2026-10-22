# 三版本仓库组织与历史

## 当前布局

`main` 作为总仓库入口，包含 `versions/pro`、`versions/lite` 和 `versions/desktop`。各版本内部沿用自己的目录、依赖和配置；根 README 负责版本选择，根 TRACE 记录后续仓库级操作。

`archive/legacy-main` 保存整合前 main 的完整文件树。历史文件中的旧路径、旧状态和旧分支名描述当时情况，按原文保留；当前操作入口以根 README 和 [启动指南](GETTING_STARTED.md) 为准。

## 2026-10-23 导入来源

| 来源分支 | 固定提交 | 导入目录 | 备份标签 | 原始可达提交数 |
| --- | --- | --- | --- | ---: |
| `main` | `cc2e6208ec9fc670639813970abfe5d68d1a0408` | `archive/legacy-main` | `snapshot/20261023/main` | 1261 |
| `itn-pro` | `2aa5c345d243acd3b3094bb1e68df3aba231cffc` | `versions/pro` | `snapshot/20261023/pro` | 4 |
| `itn-lite` | `d529278be8043f0981cef6a8164f8116cc9de787` | `versions/lite` | `snapshot/20261023/lite` | 105 |
| `desktop` | `6fa3624d629e58b1597412087c80567bc69c919a` | `versions/desktop` | `snapshot/20261023/desktop` | 356 |

提交数为每个来源 tip 的可达提交数，来源之间有共享祖先，不能直接相加得到成员贡献总数。Pro 当前来源分支只有四个可达提交；整合不会为它伪造历史，原 main 的成员提交通过 main 本身的祖先关系继续保留。

## 如何保留成员贡献

1. 以原 main 为父链建立 `integration/three-editions`。
2. 将原 main 文件树完整归档，保留其原始树哈希。
3. 通过 `git subtree add --prefix=versions/<edition> <source-tip>` 导入三个版本，不使用 `--squash`。
4. 通过 PR 的 **Create a merge commit** 合入 main，不变更原始作者、邮箱、提交时间或提交 SHA。
5. 原版本分支、四个快照标签和现有 PR / Issue / Release 记录继续保留。

Subtree 的导入提交会把来源 tip 接入祖先链。旧提交记录的路径仍是来源仓库当时的路径，因此不能只用 `git log -- versions/lite` 判断是否保留了 Lite 历史。需要沿来源提交或快照标签查看早期记录。

三个导入提交处的文件树分别与来源完全一致。整合后另有一项路径适配：`versions/desktop/scripts/publish-lumin.ps1` 根据 Git 根目录计算 Lumin 子树前缀，同时兼容独立检出 `lumin` 与总仓库 `versions/desktop/lumin`；这项变更作为新的提交记录，不改写原导入内容。

成员在 GitHub 的贡献展示还取决于作者邮箱与账号关联，以及 GitHub 对默认分支统计的刷新；本次保留原邮箱，不修改成员身份。

## 验收方式

对每个来源检查祖先可达性和文件树一致性：

```bash
# 以 Lite 为例；导入后应返回成功。
git merge-base --is-ancestor snapshot/20261023/lite main

# 应无输出：来源可达提交全部已接入 main。
git rev-list snapshot/20261023/lite --not main

# 初次整合时应无差异；以后修改此目录则会产生预期的开发差异。
git diff --exit-code snapshot/20261023/lite^{tree} main:versions/lite
```

Pro、Desktop 和归档 main 使用相同检查方法。还需核对各版本的 `TRACE.md`、构建入口、根文档本地链接和原始作者记录。

## 后续分支约定

- 新开发从 main 开功能分支，例如 `feat/lite-plan`、`fix/pro-login`、`feat/desktop-tools`。
- 先进入对应版本目录，再运行该版本的脚本；避免跨版本复用环境变量和数据目录。
- 原 `itn-pro`、`itn-lite`、`desktop` 分支先保留作为原有工作流和历史入口；不要再把它们当作 main 的同目录镜像直接合并。
- 若旧独立分支仍在开发，后续向总仓库同步采用 `git subtree pull --prefix=versions/<edition> origin <source-branch>` 并走 PR，保持与首次导入相同的完整历史策略。
- 同一个功能尽量只选择一个开发入口。完成向 main 迁移后，逐步统一从 main 开分支，减少两处重复维护。
- 发版可使用 `pro/vX.Y.Z`、`lite/vX.Y.Z`、`desktop/vX.Y.Z` 标签，分别记录版本状态。

## 部署边界

仓库整合调整源码组织和协作入口。已有服务器部署、数据库及本地独立检出的运行目录不会因为 GitHub 上 main 的变化而自动迁移。从总仓库执行部署时，将源码根指向对应 `versions/<edition>`，再按该版本自己的部署流程操作。

## 参考

- [Git subtree：目录导入与完整历史](https://github.com/git/git/blob/master/contrib/subtree/git-subtree.adoc)
- [GitHub：PR 合并方式](https://docs.github.com/en/pull-requests/reference/pull-request-merges)
- [GitHub：贡献者统计](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors)
