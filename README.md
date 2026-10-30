# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 原生支持：自动识别 jj 仓库、引导模型优先使用 jj，并提供一整套 `jj_*` 工具。

## 功能

- **仓库识别**：自动区分 git 仓库、jj-colocated、jj-native 与非仓库；jj 与 git 嵌套时也能判断真正的归属。
- **防 git 混淆**：在 jj 仓库里执行 `git commit`、`git reset` 等命令时，默认放行并在结果中提示等价的 jj 命令，也可以配置为直接拒绝。
- **jj 原生工具**：提供 17 个 `jj_*` 工具，覆盖状态查看、提交、撤销、workspace、bookmark 与收尾集成。
- **提交习惯**：默认沿用仓库最近的提交描述风格，风格不明确时先询问你；同时引导模型分步骤小步提交。
- **会话上下文**：在 jj 仓库里自动提示模型优先用 jj；检测到并行会话时，引导模型先隔离 workspace，收尾时用 `jj_handoff` 完成集成。
- **项目根识别**：让 `agent-instructions` 把 `.jj` 也当作项目根（headless / CLI profile 生效）。
- **不回退 git**：jj 不可用或目录不是 jj 仓库时明确报错，不会静默改用 git。

## 安装

需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 Jujutsu CLI（见 [jj-vcs.dev](https://jj-vcs.dev)）：`jj` 需在 `PATH` 中（需要 jj 0.46.x：CI 以 0.46.0 验证，更低版本未测试），也可以用 `jjCommand` 配置指定路径。插件本身没有其他运行时依赖。

**从 npm 安装**：

```bash
dsh plugin --profile <profile> add @aqian0/dsh-jj
```

也可以在插件管理页面（Plugin Manager）中安装，spec 填 `@aqian0/dsh-jj`。

**从本地目录安装**：首次先按 [AGENTS.md](./AGENTS.md)「环境与准备」准备构建依赖（`npm run setup`，或一次性 `npm install` 公开 peer 依赖与 `tsc`）；然后在仓库根目录执行 `npm run build`（`lib/` 是构建产物，不入库），再把本仓库的绝对路径作为 spec 安装。Web GUI 在「设置 → 插件管理」中操作，Agent 侧用 `plugin_manager` 的 `install_bundle`。

安装后会自动启用 `jj-runtime`、`jj-tools`、`jj-guard` 三个入口，并给 `agent-instructions` 加上 `.jj` 项目根标记（headless / CLI profile 生效；Web profile 见「已知限制」）；可以在插件管理页面或 `list_plugins` 中确认。

## 使用

安装后自动生效，不需要手工写 profile。典型的 agent 用法：

| 你说 | 模型调用 |
|---|---|
| “看下当前 jj 状态” | `jj_status` |
| “列出最近 10 个提交” | `jj_log` |
| “把当前改动并进上一个提交” | `jj_squash` |
| “改一下当前 change 的描述” | `jj_describe` |
| “把这步提交了，继续下一项” | `jj_commit` |
| “这个仓库的提交信息是什么风格？” | `jj_commit_style` |
| “撤销刚才那次 jj 操作” | `jj_undo` |
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
    commitStyle: angular            # auto | conventional | angular | gitmoji | plain | custom
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

| 工具 | 作用 |
|---|---|
| `jj_status` | 查看当前 change 的状态 |
| `jj_log` | 按 revset 查看提交历史 |
| `jj_diff` | 查看指定 revset 的 diff |
| `jj_new` | 新建 change 并设为 `@` |
| `jj_commit` | 描述当前 change 并新建 change；传 `paths` 可只提交部分文件 |
| `jj_describe` | 修改当前 change 的描述（相当于 `git commit --amend`） |
| `jj_commit_style` | 采样最近的提交描述，报告仓库风格；无法确定时返回候选项 |
| `jj_squash` | 把改动合并进另一个提交 |
| `jj_undo` / `jj_op_log` | 撤销操作 / 查看 operation 历史 |
| `jj_workspace_add` / `jj_workspace_list` | 新建 / 列出 jj workspace |
| `jj_bookmark_list` / `jj_bookmark_set` | 列出 / 设置 bookmark |
| `jj_rebase` | 把 revision rebase 到目标；`mode: source` 会连同后代一起移动 |
| `jj_handoff` | 收尾集成：fetch、选择目标、整栈 rebase、工作副本过期恢复与冲突上报一次完成 |
| `jj_workspace_cleanup` | 注销本会话创建的临时 workspace |

非 jj 仓库会直接拒绝工具调用并说明如何初始化 jj，不会回退到 git。

## 配置

所有配置键均可选，写在 profile 中对应 bundle 行的 `config` 里：

| 键 | 默认 | 说明 |
|---|---|---|
| `jjCommand` / `gitCommand` | `jj` / `git` | 可执行文件名；`gitCommand` 只用于探测和提示 |
| `timeoutMs` / `graceMs` | `30000` / `3000` | 子进程超时，以及超时后强制结束前的宽限时间 |
| `maxOutputBytes` | `262144` | 单个输出流（stdout / stderr）的上限 |
| `detectCacheTtlMs` | `10000` | 仓库检测结果的缓存时长 |
| `guardMutatingGit` | `warn` | jj 仓库内会改写状态的 git 命令：`warn`（放行并提示）/ `deny`（拒绝）/ `off` |
| `guardGitInJjNative` | `warn` | jj-native 仓库内只读 git 的处置：`warn`（提示）/ `deny`（拒绝）/ `off`（不提示） |
| `guardJjRepositoryWide` | `warn` | `jj undo` / `jj op restore` 等仓库级 jj 操作的处置 |
| `guardTools` | `bash` / `pwsh` / `terminal_send` | 参与上述守卫判定的 shell 工具名 |
| `guardCreateWorktree` | `true` | 在 jj 仓库里拒绝 `create_worktree`，引导用 `jj workspace add` |
| `readOnlyGitNotice` | `true` | colocated 仓库内只读 git 命令是否附「优先用 jj」提示 |
| `preferJjContext` | `true` | 会话开始时是否注入「优先用 jj」的模型上下文；关闭会同时关闭提交描述与多会话指引 |
| `multiSessionGuidance` | `auto` | 多会话并行指引：`auto` / `always` / `off` |
| `rebaseTarget` | `trunk()` | 收尾集成的首选目标 revset，不能为空；解析不到真实提交时回退到本地 `main` / `master` |
| `commitGuidance` | `true` | 是否注入提交描述风格与拆分提交指引（需 `preferJjContext` 开启） |
| `commitStyle` | `auto` | 描述风格：`auto`（继承历史）/ `conventional` / `angular` / `gitmoji` / `plain` / `custom` |
| `commitStyleCustom` | `''` | `commitStyle: custom` 时的风格规则（该模式下必填） |
| `preferSplitCommits` | `true` | 是否注入「按独立步骤拆成小提交」的指引 |
| `commitStyleSampleLimit` | `30` | `jj_commit_style` 最多沿用的非空描述条数 |
| `defaultLogLimit` / `maxLogLimit` | `30` / `200` | `jj_log` 的默认与最大返回条数 |
| `defaultCwd` | `''` | 工具没有 `workdir` 时的回退目录（空 = 进程 cwd） |

> `commitGuidance` / `commitStyle` / `commitStyleCustom` / `preferSplitCommits` / `commitStyleSampleLimit` /
> `multiSessionGuidance` / `rebaseTarget` / `preferJjContext` / `jjCommand` / `gitCommand` / `timeoutMs` / `graceMs` /
> `maxOutputBytes` / `detectCacheTtlMs` 由 `jj-runtime` 行读取（超时、截断与命令名经 `ctx.jj` 作用于全部工具）；
> `guard*` 开头的键和 `readOnlyGitNotice` 由 `jj-guard` 行读取，`defaultLogLimit` / `maxLogLimit` / `defaultCwd`
> 由 `jj-tools` 行读取。
>
> 把某个键写到不读取它的入口行时，该行启动时只输出一条 `logger.warn` 提示并忽略它，不会阻断启动。

## 已知限制

- **只支持 jj 仓库**：jj 未安装或目录不是 jj workspace 时，`jj_*` 工具会报错并给出处理建议，不会退回 git。
- **平台支持**：当前仅在 macOS / Linux 验证；测试依赖 POSIX 工具链（`/bin/sh`、`bash -c`、`chmod` 等）。Windows 未验证也不支持，`guardTools` 默认包含 `pwsh` 只是工具名匹配，不代表 Windows 可用。
- **guard 是启发式**：只做静态命令分类。无法静态求值的 shell 形式（git alias、shell function、wrapper script、`eval`、`$VAR`、`find -exec` 等）按 fail-open 放行，并可能附一次性提示；heredoc 正文按数据忽略，因此写在脚本/文档内容里的命令不会被分析。
- **hard-deny 不随配置放开**：`jj restore`（不带 fileset，含 `--from` / `--changes-in` / 重定向等写法）、`jj abandon`（默认 `@` 或显式 `@`）、`jj undo --allow-cross-workspace`，以及指向其它仓库的 `jj -R` / 越权的 `jj workspace forget`。
- **描述风格靠推断**：风格判定只看描述首行，历史太少或风格混杂时会请求你选择；Angular 与 Conventional Commits 语法相同，自动识别统一报 `conventional`，需要严格规则时可配置 `commitStyle: angular`。
- **多会话检测限于本进程**：只能看到同一 DSH 进程内的顶层会话，多个 `dsh` CLI 进程之间互不可见；跨进程并行请配置 `multiSessionGuidance: always`。
- **子代理不受多会话指引覆盖**：子代理与父会话共享工作副本，父会话继续运行时两者可能同时写文件；需要严格隔离时，由父会话为子任务指定独立 workspace。
- **临时 workspace 清理有前提**：`jj_workspace_cleanup` 只能注销本会话通过 `jj_workspace_add` 创建、且没有未提交改动或冲突的 workspace；其它 workspace 需要你手动执行 `jj workspace forget <name>` 并删除目录，插件不会自动删除目录。
- **`.jj` 项目根标记仅部分 profile 生效**：Web profile 在 bundle 层禁用了该行，headless / CLI profile 才会把 `.jj` 当作项目根。
- **jj-native 下项目级 skill 定位可能不准**：项目级 skill 根按最近的 `.git` 祖先查找（上游硬编码）；jj-native 仓库没有 `.git` 时会退回当前会话目录，通常只有会话正好位于仓库根时才符合预期。
- **不自动推送**：`jj_handoff` 只保证本地集成到目标，推送仍需你执行 `jj git push --bookmark <name>`。

## License

[MIT](./LICENSE)
