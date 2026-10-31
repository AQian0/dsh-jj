# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 原生支持：自动识别 jj 仓库、引导模型优先使用 jj，并提供一整套 `jj_*` 工具。

## 功能

- **仓库识别**：自动区分 git 仓库、jj-colocated、jj-native 与非仓库；jj 与 git 嵌套时也能判断真正的归属。
- **防 git 混淆**：在 jj 仓库里执行 `git commit`、`git reset` 等命令时，默认放行并在结果中提示等价的 jj 命令，也可以配置为直接拒绝。
- **jj 原生工具**：提供 17 个 `jj_*` 工具，覆盖状态查看、提交、撤销、workspace、bookmark 与收尾集成。
- **提交习惯**：默认沿用仓库最近的提交描述风格，风格不明确时先询问你；同时引导模型分步骤小步提交。
- **会话上下文**：在 jj 仓库里自动提示模型优先用 jj；检测到并行会话时，引导模型先隔离 workspace，收尾时用 `jj_handoff` 完成集成。
- **变更卡片（行数与文件列表）**：Web 端每轮回复末尾的「已编辑 N 个文件 +X −Y」默认改用 jj 的工作副本快照计算，jj-native 仓库与 linked workspace 也能正确显示；不在 jj workspace 的会话继续沿用内置的 Git 快照 / 文件工具捕获记录。
- **项目根识别**：让 `agent-instructions` 把 `.jj` 也当作项目根（headless / CLI profile 生效）。
- **不回退 git**：jj 不可用或目录不是 jj 仓库时明确报错，不会静默改用 git。

## 安装

需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 Jujutsu CLI（见 [jj-vcs.dev](https://jj-vcs.dev)）：`jj` 需在 `PATH` 中（需要 jj 0.46.x：CI 以 0.46.0 验证，更低版本未测试），也可以用 `jjCommand` 配置指定路径。插件本身没有其他运行时依赖。

**从 npm 安装**：

```bash
dsh plugin --profile <profile> add @aqian0/dsh-jj
```

也可以在插件管理页面（Plugin Manager）中安装，spec 填 `@aqian0/dsh-jj`。

**从本地目录安装**：需要 Node.js 24.11+ 与 pnpm 12.16.1。先在仓库根目录执行 `pnpm install`（首次需要网络）安装构建工具链，再执行 `pnpm run build` 生成 `lib/`（构建产物，不入库），然后把本仓库的绝对路径作为 spec 安装。Web GUI 在「设置 → 插件管理」中操作，Agent 侧用 `plugin_manager` 的 `install_bundle`。

安装后会自动启用 `jj-runtime`、`jj-tools`、`jj-guard`、`jj-changes` 四个入口，并把 Web app 内置的、只认 Git 的 `workspace-changes` 行禁用（由 `jj-changes` 接管 `workspaceChanges` 服务，见「变更卡片」）；同时给 `agent-instructions` 加上 `.jj` 项目根标记（headless / CLI profile 生效；Web profile 见「已知限制」）。可以在插件管理页面或 `list_plugins` 中确认。

## 使用

安装后自动生效，不需要手工写 profile。典型的 agent 用法：

| 你说                              | 模型调用           |
| --------------------------------- | ------------------ |
| “看下当前 jj 状态”                | `jj_status`        |
| “列出最近 10 个提交”              | `jj_log`           |
| “把当前改动并进上一个提交”        | `jj_squash`        |
| “改一下当前 change 的描述”        | `jj_describe`      |
| “把这步提交了，继续下一项”        | `jj_commit`        |
| “这个仓库的提交信息是什么风格？”  | `jj_commit_style`  |
| “撤销刚才那次 jj 操作”            | `jj_undo`          |
| “新建一个 workspace 放到 /tmp/wt” | `jj_workspace_add` |

在 jj 仓库里直接让 agent 跑 `git commit` 之类的命令时，工具结果里会追加「优先用 jj」的提示；把 `guardMutatingGit` 设为 `deny` 后会直接拒绝并给出等价命令（节选）：

```
Blocked: `git commit` in a Jujutsu (jj) workspace (jj-colocated: /path/to/repo).
Use the jj equivalent instead:
  jj commit -m "…"      (or: jj describe -m "…" then jj new)
```

### 提交习惯

默认 `commitStyle: 'auto'`：模型在第一次写描述或提交前，会用 `jj_commit_style` 采样本仓库最近的描述，沿用其中的类型前缀、语言、大小写、标题长度和 body 习惯。历史为空、少于 3 条或多种风格混杂时，工具会返回候选风格（Conventional Commits、Angular、Gitmoji、纯文本、自定义），模型先询问你再动手。

也可以直接在配置里固定风格：

```yaml
- id: jj-runtime
  name: '@aqian0/dsh-jj'
  config:
    commitStyle: angular # auto | conventional | angular | gitmoji | plain | custom
    # commitStyle: custom
    # commitStyleCustom: '中文小写祈使句,不加前缀,必要时空行写原因'
```

对话里明确指定的风格优先于配置与历史，但只对当前会话有效；想长期固定就写进配置。

默认 `preferSplitCommits: true`：模型每完成一个独立步骤（一个功能、一次修复、一次重构或一次文档调整）就用 `jj_commit` 提交，再开始下一步。只提交混杂改动中的部分文件时，给 `jj_commit` 传 `paths`。

### 多会话协作

同一个 DSH 进程里可能有多个会话同时工作（Web GUI 的会话就共用一个进程）。插件只把**正在执行回合**的其它顶层会话算作并行：只是打开过或已经空闲的会话不会触发隔离。

检测到并行时：

- **共用同一个工作副本**：动文件前先用 `jj_workspace_add` 在仓库外建一个独立的 workspace（例如 `<仓库同级目录>/repo-session-a`），再用 `working_directory` 工具把会话切过去。不要放在仓库内部，也不要复用别人的 workspace。
- **同一仓库的不同 workspace**：工作副本互不影响，但 bookmark 和 operation log 是共享的。只改自己的提交，不要 rebase、undo 或移动别人 workspace 的 bookmark。

`multiSessionGuidance` 控制这段指引：`auto`（默认，按检测结果注入）、`always`（始终注入，多个 `dsh` 进程并行时使用）、`off`（关闭）。

### 任务收尾

检测到并行会话（或配置了 `multiSessionGuidance: always`）时，模型会按下面的流程收尾：

1. 用 `jj_commit` 提交最后一步，确保没有未提交改动。
2. 调用 `jj_handoff` 一次完成 fetch、选择集成目标、整栈 rebase、工作副本过期恢复与冲突上报。在根（default）workspace 里需要传 `firstChange`（本会话栈底的 change）；独立 workspace 会自动探测。
3. 如果出现冲突，模型自行解决后再次调用 `jj_handoff` 确认。
4. 用 `jj_workspace_cleanup` 注销本会话创建的临时 workspace；其它 workspace 需要你手动清理。
5. 向你报告最终的 change id、集成目标、bookmark 移动与 workspace 清理结果。

`jj_handoff` 只在确实找不到集成目标时才需要你指定 revision；它不会自动 push，推送仍由你执行。单会话默认不会自动收到这段收尾提示，需要时可以直接让模型调用 `jj_handoff`。

### 工具一览

| 工具                                     | 作用                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `jj_status`                              | 查看当前 change 的状态                                                     |
| `jj_log`                                 | 按 revset 查看提交历史                                                     |
| `jj_diff`                                | 查看指定 revset 的 diff                                                    |
| `jj_new`                                 | 新建 change 并设为 `@`                                                     |
| `jj_commit`                              | 描述当前 change 并新建 change；传 `paths` 可只提交部分文件                 |
| `jj_describe`                            | 修改当前 change 的描述（相当于 `git commit --amend`）                      |
| `jj_commit_style`                        | 采样最近的提交描述，报告仓库风格；无法确定时返回候选项                     |
| `jj_squash`                              | 把改动合并进另一个提交                                                     |
| `jj_undo` / `jj_op_log`                  | 撤销操作 / 查看 operation 历史                                             |
| `jj_workspace_add` / `jj_workspace_list` | 新建 / 列出 jj workspace                                                   |
| `jj_bookmark_list` / `jj_bookmark_set`   | 列出 / 设置 bookmark                                                       |
| `jj_rebase`                              | 把 revision rebase 到目标；`mode: source` 会连同后代一起移动               |
| `jj_handoff`                             | 收尾集成：fetch、选择目标、整栈 rebase、工作副本过期恢复与冲突上报一次完成 |
| `jj_workspace_cleanup`                   | 注销本会话创建的临时 workspace                                             |

非 jj 仓库会直接拒绝工具调用并说明如何初始化 jj，不会回退到 git。

### 变更卡片（行数与文件列表）

Web 端每轮结束后的「已编辑 N 个文件 +X −Y」卡片（右侧栏还能打开逐文件 diff）由 DSH 的 `workspaceChanges` 服务提供。DSH 内置实现只从 Git 工作树快照统计，因此在 jj 下有三种典型失真：jj-native 仓库（没有根 `.git`）读不到任何改动；linked workspace / 工作副本过期时 Git 视图并不是 jj 的 `@`；通过 `jj` 命令产生的改动（rebase、squash、undo 等）可能落在 Git 视角之外。

`jj-changes` 行接管该服务后：

- 每一轮开始时记录 jj 工作副本提交（`@`）的 commit id，轮结束时再次快照并 `jj diff --from <开始> --to <结束>`，因此**卡片里的文件列表与 ±行数直接来自 jj 的工作副本差异**，jj-native 仓库、colocated 仓库、linked workspace 一致。
- 不在 jj workspace 的会话（普通 Git 仓库、非仓库目录）仍由 DSH 内置记录器处理：Git 快照与文件工具捕获照旧，行为与未安装本插件时一致。内置记录器跑在隔离的 Cordis service scope 里，所以两者可以共存。
- 同一轮里两边都记到的文件按绝对路径去重，优先采用 jj 的行数；内置记录器额外捕获到、jj 没覆盖的文件（如文件工具写到 workspace 外的文件）会追加进列表。
- 新建文件超过 jj 的 `snapshot.max-new-file-size`（默认 1 MiB）时 jj 会拒绝把它快照进 `@`。插件从快照命令
  的 stderr 警告里认出这些文件，作为「过大」条目列进卡片（0 行数、没有逐行对比），而不是让它们从卡片里消失；
  轮开始前就存在的超大文件不算本轮改动。
- 记录是尽力而为的旁路：jj 快照/对比失败（工作副本 stale、`jj` 缺失、输出被截断）时该轮不写卡片数据，绝不会影响回合本身；此时会退回内置记录器的结果。

相关配置写在 `jj-changes` 行（见下方配置表）。`workspaceChanges: builtin` 可以临时退回内置实现；`workspaceChanges: off` 关闭 jj 记录与卡片数据，但仍提供一个只读空服务（不产生卡片数据），以免连带禁用 Web 端 deliverables/present 相关路由与文件引用提示词。

## 配置

所有配置键均可选，写在 profile 中对应 bundle 行的 `config` 里：

| 键                                | 默认                              | 说明                                                                                                                                 |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `jjCommand` / `gitCommand`        | `jj` / `git`                      | 可执行文件名；`gitCommand` 只用于探测和提示                                                                                          |
| `timeoutMs` / `graceMs`           | `30000` / `3000`                  | 子进程超时，以及超时后强制结束前的宽限时间                                                                                           |
| `maxOutputBytes`                  | `262144`                          | 单个输出流（stdout / stderr）的上限                                                                                                  |
| `detectCacheTtlMs`                | `10000`                           | 仓库检测结果的缓存时长                                                                                                               |
| `guardMutatingGit`                | `warn`                            | jj 仓库内会改写状态的 git 命令：`warn`（放行并提示）/ `deny`（拒绝）/ `off`                                                          |
| `guardGitInJjNative`              | `warn`                            | jj-native 仓库内只读 git 的处置：`warn`（提示）/ `deny`（拒绝）/ `off`（不提示）                                                     |
| `guardJjRepositoryWide`           | `warn`                            | `jj undo` / `jj op restore` / `jj operation restore`（canonical 拼写）以及 `jj squash --into <非 @ revision>` 等仓库级 jj 操作的处置 |
| `guardTools`                      | `bash` / `pwsh` / `terminal_send` | 参与上述守卫判定的 shell 工具名                                                                                                      |
| `guardCreateWorktree`             | `true`                            | 在**归属 jj** 的仓库里拒绝 `create_worktree`，引导用 `jj workspace add`（嵌套的独立 Git 仓库按最近仓库归属放行）                     |
| `readOnlyGitNotice`               | `true`                            | colocated 仓库内只读 git 命令是否附「优先用 jj」提示                                                                                 |
| `preferJjContext`                 | `true`                            | 会话开始时是否注入「优先用 jj」的模型上下文；关闭会同时关闭提交描述与多会话指引                                                      |
| `multiSessionGuidance`            | `auto`                            | 多会话并行指引：`auto` / `always` / `off`                                                                                            |
| `rebaseTarget`                    | `trunk()`                         | 收尾集成的首选目标 revset，不能为空；解析不到真实提交时回退到本地 `main` / `master`                                                  |
| `commitGuidance`                  | `true`                            | 是否注入提交描述风格与拆分提交指引（需 `preferJjContext` 开启）                                                                      |
| `commitStyle`                     | `auto`                            | 描述风格：`auto`（继承历史）/ `conventional` / `angular` / `gitmoji` / `plain` / `custom`                                            |
| `commitStyleCustom`               | `''`                              | `commitStyle: custom` 时的风格规则（该模式下必填）                                                                                   |
| `preferSplitCommits`              | `true`                            | 是否注入「按独立步骤拆成小提交」的指引                                                                                               |
| `commitStyleSampleLimit`          | `30`                              | `jj_commit_style` 最多沿用的非空描述条数                                                                                             |
| `defaultLogLimit` / `maxLogLimit` | `30` / `200`                      | `jj_log` 的默认与最大返回条数                                                                                                        |
| `defaultCwd`                      | `''`                              | 无 agent 调用或无法解析会话目录时的回退目录（`jj-tools` 与 `jj-guard` 两行读取；空 = 进程 cwd）                                      |

> `commitGuidance` / `commitStyle` / `commitStyleCustom` / `preferSplitCommits` / `commitStyleSampleLimit` /
> `multiSessionGuidance` / `rebaseTarget` / `preferJjContext` / `jjCommand` / `gitCommand` / `timeoutMs` / `graceMs` /
> `maxOutputBytes` / `detectCacheTtlMs` 由 `jj-runtime` 行读取（超时、截断与命令名经 `ctx.jj` 作用于全部工具）；
> `guard*` 开头的键和 `readOnlyGitNotice` 由 `jj-guard` 行读取，`defaultLogLimit` / `maxLogLimit` 由 `jj-tools`
> 行读取，`defaultCwd` 由 `jj-tools` 与 `jj-guard` 两行读取。
>
> 把某个键写到不读取它的入口行时，该行启动时输出一条 `logger.warn` 提示并忽略它，不会阻断启动。判定「显式配置」的
> 依据是该键的值与 schema 默认值不同，因此把键显式写成默认值（如 `commitStyle: auto`）不会告警；拼错/未知键也会
> 在每行启动时 `warn`（仅提示，不阻断）。

`jj-changes` 行有自己的一组配置（变更卡片）。这些键写在 `jj-changes` 行的 `config` 里；写到其它入口行不会被读取：

```yaml
- id: jj-changes
  name: '@aqian0/dsh-jj/changes'
  config:
    workspaceChanges: auto # auto | builtin | off
    maxFiles: 500
```

| 键                 | 默认               | 说明                                                                                                                            |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceChanges` | `auto`             | `auto`：jj 会话用 jj 数据、其余会话用内置记录并合并；`builtin`：只用内置实现；`off`：关闭 jj 记录与卡片数据（仍提供只读空服务） |
| `maxFiles`         | `500`              | 单轮摘要最多列出的文件数；`total` 仍是完整数量                                                                                  |
| `maxFileBytes`     | `2097152`（2 MiB） | 单个文件 diff 的展示上限；超过时卡片列出文件与行数，但不提供逐行对比（显示「过大」）                                            |
| `outputMaxBytes`   | `8388608`（8 MiB） | 单轮 `jj diff` 输出的保留上限；超过则该轮放弃 jj 记录（退回内置记录）                                                           |
| `diffTimeoutMs`    | `100`              | 内置记录器的行对比超时（仅在合并视图里回退到内置数据时使用）                                                                    |

> `jj-changes` 依赖 DSH 的 `@deepseek-ai/dsh-workspace-changes`（deliverables bundle 的一部分）。headless profile 没有该 bundle 时该行自动降级（只输出一条 warning，不阻断启动）。

## 已知限制

- **只支持 jj 仓库**：jj 未安装或目录不是 jj workspace 时，`jj_*` 工具会报错并给出处理建议，不会退回 git。
- **平台支持**：当前仅在 macOS / Linux 验证；测试依赖 POSIX 工具链（`/bin/sh`、`bash -c`、`chmod` 等）。Windows 未验证也不支持，`guardTools` 默认包含 `pwsh` 只是工具名匹配，不代表 Windows 可用。
- **guard 是启发式**：只做静态命令分类。嵌套/前导 shell wrapper（`bash -c 'bash -c …'`、`command` / `env` / `nohup` / `timeout` 等前缀、`bash -c --`、`env -S'…'`、`exec -a`）会被递归展开，可静态解析的 `cp` 类目录切换（`cd -P` / `cd --` / `pushd`、git 的累积 `-C`）也会跟随；仍无法静态求值的形态（外部 wrapper script、`bash <<< …` 这类 stdin 脚本、git alias、`eval`、`$VAR`、`find -exec` 等）按 fail-open 放行并附一次性提示；heredoc 正文按数据忽略，因此写在脚本/文档内容里的命令不会被分析。
- **仓库归属按最近者判断**：jj workspace 内嵌套的独立 Git 仓库（最近的 `.git` 比 `.jj` 更深）按普通 Git 仓库处理——`git` 命令与 `create_worktree` 都不会被 jj guard 拦截；只有祖先 jj 的目录才受 guard 约束。
- **hard-deny 不随配置放开**：`jj restore`（不带 fileset，含 `--from` / `--changes-in` / 重定向等写法）、`jj abandon`（默认 `@` 或显式 `@`）、`jj undo --allow-cross-workspace`，以及指向其它仓库的 `jj -R` / 越权的 `jj workspace forget`。`-R/--repository` 写在 subcommand 前后都按同一规则处理（jj 全局选项两种位置都接受）。
- **描述风格靠推断**：风格判定只看描述首行，历史太少或风格混杂时会请求你选择；Angular 与 Conventional Commits 语法相同，自动识别统一报 `conventional`，需要严格规则时可配置 `commitStyle: angular`。
- **多会话检测限于本进程**：只能看到同一 DSH 进程内的顶层会话，多个 `dsh` CLI 进程之间互不可见；跨进程并行请配置 `multiSessionGuidance: always`。
- **子代理不受多会话指引覆盖**：子代理与父会话共享工作副本，父会话继续运行时两者可能同时写文件；需要严格隔离时，由父会话为子任务指定独立 workspace。
- **临时 workspace 清理有前提**：`jj_workspace_cleanup` 只能注销本会话通过 `jj_workspace_add` 创建、且没有未提交改动或冲突的 workspace；其它 workspace 需要你手动执行 `jj workspace forget <name>` 并删除目录，插件不会自动删除目录。
- **`.jj` 项目根标记仅部分 profile 生效**：Web profile 在 bundle 层禁用了该行，headless / CLI profile 才会把 `.jj` 当作项目根。
- **jj-native 下项目级 skill 定位可能不准**：项目级 skill 根按最近的 `.git` 祖先查找（上游硬编码）；jj-native 仓库没有 `.git` 时会退回当前会话目录，通常只有会话正好位于仓库根时才符合预期。
- **不自动推送**：`jj_handoff` 只保证本地集成到目标，推送仍需你执行 `jj git push --bookmark <name>`。
- **超大新文件只有「过大」条目**：jj 默认不追踪超过 `snapshot.max-new-file-size`（默认 1 MiB）的新文件；插件会把这类文件列进卡片并标记「过大」，但没有行数与逐行对比；colocated 仓库里内置记录器虽然能从 Git 视角看到该文件，合并仍以 jj 数据优先，所以卡片统一显示「过大」。需要真正纳管时调大该 jj 配置。shell 命令写到 jj workspace 之外的文件只在文件工具捕获能覆盖时出现。多文件超 `maxFiles` 时，合并视图的 `total` 与总行数是近似值（内置记录器对超出自身上限的文件不再保留行数明细）。
- **变更卡片只在有工具调用的回合出现**：与 DSH 内置记录器一致，纯聊天不产生「已编辑」卡片；被中断或失败的 jj 快照只影响该轮卡片，不影响回合。

## 开发

本仓库用 pnpm 管理开发依赖（`packageManager` 固定 `pnpm@12.16.1`），格式与 lint 由 Vite+ 的 Oxfmt / Oxlint 负责；`npm` 只用于发布（`npm publish` / `npm view`）。常用命令：

```bash
pnpm install           # 安装工具链与公开 peer 依赖（首次需要网络，之后离线）
pnpm test              # 提交前门禁：vp check --deny-warnings → tsc 类型检查 → node --test
pnpm run build         # tsc 构建 lib/（本地目录安装 / 发布前）
pnpm run typecheck     # src/、test/ 与 vite.config.ts 的类型检查
pnpm run check         # 只跑 Oxfmt + Oxlint（--deny-warnings）
pnpm run lint          # 只跑 Oxlint
pnpm run format        # 用 Oxfmt 格式化代码
pnpm run format:check  # 只检查格式，不写文件
```

测试仍是 `node --test`、构建仍是 `tsc`（不使用 `vp test` / `vp build`）。环境、架构、代码约定与提交流程见 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)
