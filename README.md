# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 原生支持：仓库识别、防 git 混淆、24 个 `jj_*` 工具、多会话隔离与收尾、jj 变更卡片及只读面板。

## 功能

- **仓库识别**：区分 git、jj-colocated、jj-native 与非仓库，正确处理嵌套归属；jj 不可用时明确报错，不回退 git。
- **防 git 混淆**：在 jj 仓库中执行改写类 git 命令时默认放行并提示等价 jj 命令，也可配置为拒绝。
- **jj 原生工具**：24 个 `jj_*` 工具，覆盖状态、提交、修正折叠、撤销、workspace、bookmark 与收尾集成，对齐宿主沙箱与审批策略。
- **提交与修正习惯**：自动沿用仓库提交风格并引导小步提交；未推送的提交在修正时优先用 `jj_amend` 折进原提交。
- **多会话协作与收尾**：识别并行顶层会话，引导在仓库外新建 workspace 隔离，收尾时通过 `jj_handoff` 一次完成集成。
- **变更卡片**：Web 端「已编辑 N 个文件」改用 jj 工作副本快照统计，非 jj 会话沿用内置记录器。
- **只读可视化面板**：右侧栏 Jujutsu tab 展示提交图、书签、工作区、操作日志与按需 diff，不写仓库也不触发快照。
- **项目根识别**：在 headless / CLI profile 中将 `.jj` 识别为项目根。

## 安装

需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 `jj` CLI（≥ 0.47.1，需在 `PATH` 中或通过 `jjCommand` 指定）。无额外运行时依赖。

**从 npm 安装**：

```bash
dsh plugin --profile <profile> add @aqian0/dsh-jj
```

也可在 Web GUI 的插件管理页面填入 `@aqian0/dsh-jj` 安装。

**从本地安装**（需要 Node.js 24.11+ 与 [Vite+](https://viteplus.dev) CLI `vp`）：仓库根目录执行 `vp install && vp run build`，再以仓库绝对路径作为 spec 安装。

安装后自动启用 `jj-runtime`、`jj-tools`、`jj-guard`、`jj-changes` 四个入口，并由 `jj-changes` 接管 Web 端内置的 `workspace-changes`。

## 使用

安装后自动生效，无需额外配置 profile。

### 提交与修正

- **提交风格**：默认 `commitStyle: auto`，首次提交前由 `jj_commit_style` 采样历史描述；历史不足或混杂时先询问。也可在配置中固定风格，对话中的临时指定优先于配置。
- **小步提交**：默认 `preferSplitCommits: true`，每完成一个独立步骤调用 `jj_commit`（传 `paths` 可拆分提交）。
- **修正折叠**：默认 `preferAmendCorrections: true`。对本会话尚未推送（不在 remote bookmark / trunk / tag 上，`rewritable: true`）的提交，修正会用 `jj_amend` 直接折进原提交；已发布提交不会强行改写。

### 多会话协作与收尾

仅将**正在执行回合**的其他顶层会话视为并行（同进程直接感知，跨进程通过仓库心跳；跨机器可设 `multiSessionGuidance: always`）。

- **工作区隔离**：共用工作副本时，先提交自己的改动，再不带 `parents` 调用 `jj_workspace_add` 在仓库外创建独立 workspace（推荐放在 `/tmp/<repo>-<name>`，避免触发 `workspace-write` 审批）。切勿把当前 `@` 当作 parent。
- **收尾流程**：
  1. 用 `jj_commit` 提交工作副本剩余改动（空工作副本会直接拒绝）。
  2. 调用 `jj_handoff` 一次完成 fetch、集成目标解析、整栈 rebase、stale 恢复与冲突/空提交上报（在 default workspace 需传 `firstChange`；`dryRun: true` 仅预览计划；不会自动 push）。
  3. 有冲突时解决后再次调用 `jj_handoff` 确认；rebase 后变空的本会话提交按需用 `jj_abandon` 清理。
  4. 调用 `jj_workspace_cleanup` 注销本会话创建的临时 workspace 并切回 default（自动将 default 的空 `@` 接到栈顶，不删除目录；传 `workspace` 可回收已中断会话的孤儿 workspace）。

### 变更卡片与只读面板

- **变更卡片（`jj-changes`）**：jj 会话按回合首尾 `@` 快照计算 diff；非 jj 会话沿用内置记录器并在同轮按绝对路径合并（jj 优先）。快照或 diff 失败时自动降级，不影响回合。
- **只读面板（`uiPanel`）**：Web/Desktop 右侧栏提供 Jujutsu tab，查看提交图、书签、工作区、操作日志与按需统一 diff，全程 `--ignore-working-copy`，绝不写仓库或触发快照；同时为 `jj_status`、`jj_log`、`jj_workspace_list`、`jj_handoff` 提供紧凑折叠视图。设为 `off` 可关闭。

### 工具一览

| 工具                                          | 说明                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `jj_status`                                   | 查看当前 change 状态（`details: true` 时附改动文件与 diff 统计）   |
| `jj_log` / `jj_diff`                          | 按 revset 查看提交历史 / diff                                      |
| `jj_new` / `jj_commit` / `jj_describe`        | 新建 change / 提交并新建（支持 `paths`）/ 修改描述                 |
| `jj_commit_style`                             | 采样历史提交描述并判断风格                                         |
| `jj_squash` / `jj_amend`                      | 合并改动 / 将修正折叠进未推送的祖先提交                            |
| `jj_abandon`                                  | 丢弃指定未发布 revision（拒绝 `@` 与已发布提交）                   |
| `jj_undo` / `jj_op_log` / `jj_op_restore`     | 撤销上一步 / 查看操作日志 / 恢复到指定操作                         |
| `jj_fetch`                                    | `jj git fetch`（无远端返回 `no-remote`）                           |
| `jj_bookmark_list` / `jj_bookmark_set`        | 列出（默认隐藏 `@git` 镜像）/ 设置 bookmark                        |
| `jj_rebase`                                   | rebase revision 到目标（`mode: source` 连同后代移动）              |
| `jj_handoff`                                  | 一次性完成收尾集成，拒绝改写活跃或脏的兄弟工作区                   |
| `jj_workspace_add` / `jj_workspace_list`      | 新建并切入 workspace / 列出 workspace（`detail: full` 含状态归属） |
| `jj_workspace_enter` / `jj_workspace_restore` | 切入已有同仓库 workspace / 按记录重建被删目录的 workspace          |
| `jj_workspace_cleanup`                        | 注销本会话临时 workspace 或回收孤儿 workspace（不删目录）          |
| `jj_workspace_update_stale`                   | 恢复 stale 工作副本                                                |

非 jj 目录会明确拒绝工具调用。全部工具对齐宿主 `sandboxPolicy` 与审批流程：`read-only` 下只读与切换工具零快照写盘，写操作需审批；`workspace-write` 下向默认可写范围外创建或切换工作区需审批。

## 配置

所有键均可选，写在对应 bundle 行的 `config` 下。放错行或未知键会在加载时报错并提示正确归属行。

| 键                                | 所属行                | 默认                              | 说明                                                                     |
| --------------------------------- | --------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `jjCommand` / `gitCommand`        | `jj-runtime`          | `jj` / `git`                      | 可执行文件名（`gitCommand` 仅用于探测与提示）                            |
| `timeoutMs` / `graceMs`           | `jj-runtime`          | `30000` / `3000`                  | 子进程超时与强杀宽限（ms）                                               |
| `maxOutputBytes`                  | `jj-runtime`          | `262144`                          | 单流（stdout / stderr）输出上限                                          |
| `detectCacheTtlMs`                | `jj-runtime`          | `10000`                           | 仓库检测缓存时长（ms）                                                   |
| `preferJjContext`                 | `jj-runtime`          | `true`                            | 是否注入会话级 jj 上下文（关闭将连带关闭提交与多会话指引）               |
| `multiSessionGuidance`            | `jj-runtime`          | `auto`                            | 多会话指引：`auto` / `always` / `off`                                    |
| `rebaseTarget`                    | `jj-runtime`          | `trunk()`                         | 收尾集成首选目标 revset（非空，失败回退本地 `main` / `master`）          |
| `commitGuidance`                  | `jj-runtime`          | `true`                            | 是否注入提交风格与拆分指引                                               |
| `commitStyle`                     | `jj-runtime`          | `auto`                            | `auto` / `conventional` / `angular` / `gitmoji` / `plain` / `custom`     |
| `commitStyleCustom`               | `jj-runtime`          | `''`                              | `commitStyle: custom` 时的风格规则（该模式必填）                         |
| `preferSplitCommits`              | `jj-runtime`          | `true`                            | 是否引导按独立步骤小步提交                                               |
| `preferAmendCorrections`          | `jj-runtime`          | `true`                            | 是否引导用 `jj_amend` 折叠修正（不影响工具可用性）                       |
| `commitStyleSampleLimit`          | `jj-runtime`          | `30`                              | `jj_commit_style` 采样条数上限                                           |
| `uiPanel`                         | `jj-runtime`          | `auto`                            | Web 只读面板：`auto` / `off`                                             |
| `guardMutatingGit`                | `jj-guard`            | `warn`                            | jj 仓库内改写类 git 命令：`warn` / `deny` / `off`                        |
| `guardGitInJjNative`              | `jj-guard`            | `warn`                            | jj-native 仓库内只读 git：`warn` / `deny` / `off`                        |
| `guardJjRepositoryWide`           | `jj-guard`            | `warn`                            | 仓库级 jj 操作（如 `jj undo`、`jj op restore`）：`warn` / `deny` / `off` |
| `guardTools`                      | `jj-guard`            | `bash` / `pwsh` / `terminal_send` | 参与守卫的 shell 工具名                                                  |
| `guardCreateWorktree`             | `jj-guard`            | `true`                            | 在归属 jj 的目录拒绝 `create_worktree`                                   |
| `readOnlyGitNotice`               | `jj-guard`            | `true`                            | colocated 仓库内只读 git 是否附「优先用 jj」提示                         |
| `defaultLogLimit` / `maxLogLimit` | `jj-tools`            | `30` / `200`                      | `jj_log` / `jj_op_log` 默认与最大条数                                    |
| `defaultCwd`                      | `jj-tools`/`jj-guard` | `''`                              | 无法解析会话目录时的回退目录（空 = 进程 cwd）                            |
| `workspaceChanges`                | `jj-changes`          | `auto`                            | `auto`（jj 优先并合并）/ `builtin`（仅内置）/ `off`（空服务不生成卡片）  |
| `maxFiles`                        | `jj-changes`          | `500`                             | 单轮卡片最多列出的文件数                                                 |
| `maxFileBytes`                    | `jj-changes`          | `2097152`                         | 单文件 diff 上限（2 MiB），超出标「过大」                                |
| `outputMaxBytes`                  | `jj-changes`          | `8388608`                         | 单轮 `jj diff` 输出上限（8 MiB），超出回退内置                           |
| `diffTimeoutMs`                   | `jj-changes`          | `100`                             | 内置记录器行对比超时（ms）                                               |

> `jj-changes` 依赖 `@deepseek-ai/dsh-workspace-changes`（deliverables bundle）；headless profile 缺少时自动降级为一条 warning。

## 已知限制

- **平台**：仅在 macOS / Linux 验证，不支持 Windows。
- **静态 guard 边界**：基于静态 shell 解析，嵌套独立 Git 仓库按最近归属放行；无法静态求值的动态命令、alias 或脚本按 fail-open 放行并附一次性提示。
- **不可放开的 hard-deny**：无 fileset 的 `jj restore`、丢弃 `@` 的 `jj abandon`、`jj undo --allow-cross-workspace`、跨仓库 `jj -R`、越权 `jj workspace forget` 与任何 `jj workspace remove` 始终拒绝。
- **多会话与子代理**：跨进程识别依赖共享仓库文件系统的心跳（15 分钟过期），跨机器需设 `multiSessionGuidance: always`；子代理与父会话共享工作副本，不受并行指引覆盖。
- **Linux `bwrap` 沙箱**：`bash` 在 `bwrap` 下使用私有 `/tmp`；若需在隔离工作区执行 shell 构建，可经审批将 workspace 建在仓库同级目录。
- **集成与推送**：`jj_handoff` 不会自动合并两个并行栈，也不会自动 `push`；已推送或不可变提交不支持 `jj_amend`。
- **工作区清理**：`jj_workspace_cleanup` 只注销插件创建的干净工作区且不删目录，其它工作区需手动 `jj workspace forget`。
- **上游与变更卡片**：`.jj` 项目根标记仅 headless / CLI profile 生效；jj-native 下项目级 skill 查找依赖上游 `.git` 定位。变更卡片仅在有工具调用的回合出现，超过 `snapshot.max-new-file-size` 的新文件仅标「过大」无逐行对比。

## 开发

```bash
vp install          # 安装工具链与 peer 依赖
vp run test         # 门禁：vp check --deny-warnings → tsc 类型检查 → vp test（Vitest）
vp test --coverage  # 运行单元测试并生成 v8 覆盖率报告
vp run build        # 构建 lib/
vp check --fix      # Oxfmt 格式化 + Oxlint 自动修复
```

架构、约定与提交流程见 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)
