# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 一等支持。

## 功能

- **仓库识别**:区分 `git` / `jj-colocated` / `jj-native` / 非仓库;jj 与 git 嵌套时给出明确归属,不会把 jj 工作区当成普通 git 仓库。
- **防混淆 guard**:在 jj 仓库里执行 `git commit`、`git reset` 等会破坏 change graph 的命令时,默认放行并在结果里提示等价 jj 命令,也可配置为直接拒绝。
- **jj 原生工具**:17 个 `jj_*` 工具(status / log / diff / new / commit / describe / commit style / squash / undo / op log / workspace / bookmark / rebase / handoff / workspace cleanup)。
- **提交描述风格**:默认继承仓库里最近 jj/Git 描述的写法;历史不足或混杂时先询问你选 Conventional Commits / Angular / Gitmoji / 纯文本或自定义风格,也支持在配置里固定风格。
- **小步提交**:默认要求模型每完成一个内聚步骤就用 `jj commit` 收尾并开新 change,避免整份任务堆在 `@` 里难以审阅。
- **模型上下文**:在 jj 仓库里自动向模型注入「优先用 jj」的上下文;非 jj 仓库不注入。
- **多会话并行**:检测同一进程、同一 jj 仓库里**正在执行回合**的其他顶层会话(空闲/仅打开过的会话不算);共用工作副本时引导先隔离到仓库外的独立 jj workspace,同仓库不同 workspace 时提醒不要改写别人的提交,并在任务收尾按标准 rebase 流程交付。
- **项目根发现**:让 `agent-instructions` 也能把 `.jj` 当作项目根标记(headless/CLI profile 生效)。
- **不回退 git**:jj 不可用或目录不是 jj 仓库时明确报错,绝不静默改用 git。

## 安装

需要 DSH 与 `jj` CLI(`jj` 在 `PATH` 中,或用 `jjCommand` 指定);无其他运行时依赖。
兼容 DSH `0.2.1-rc.2` 及之后的 `0.2.x`:peer 依赖写作 `^0.2.1-rc.2`,同一 `0.2` 系列内的补丁/预发布升级(如 `0.2.1-rc.3`)无需更新插件;`0.3` 起需要插件适配。

**从 npm 安装**:在 Plugin Manager 里把 spec 填成精确版本(如 `@aqian0/dsh-jj@0.3.0`,避免发版后已装内容变化),或执行:

```bash
dsh plugin --profile <name> add @aqian0/dsh-jj@0.3.0
```

**本地目录安装**:`lib/` 是构建产物、不入库,先在仓库根执行 `npm run build`,再在 Plugin Manager 里安装本地 bundle,spec 填本仓库绝对路径(如 `/path/to/dsh-jj`);Web GUI 在设置 → 插件管理,Agent 侧用 `plugin_manager` 的 `install_bundle`。

安装后自动启用 `jj-runtime` / `jj-tools` / `jj-guard` 三行,并给 `agent-instructions` 加上 `.jj` 根标记;用 Plugin 页面或 `list_plugins` 确认。

## 使用

安装后自动生效,无需手工写 profile。典型的 agent 用法:

| 你说 | 模型调用 |
|---|---|
| "看下当前 jj 状态" | `jj_status` |
| "列出最近 10 个提交" | `jj_log` |
| "把当前改动并进上一个提交" | `jj_squash` |
| "改一下当前 change 的描述" | `jj_describe` |
| "把这步提交了,继续下一项" | `jj_commit` |
| "这个仓库的提交信息是什么风格?" | `jj_commit_style` |
| "撤销刚才那次 jj 操作" | `jj_undo` |
| "新建一个 workspace 放到 /tmp/wt" | `jj_workspace_add` |

在 jj 仓库里直接让 agent 跑 `git commit` 之类的命令时,默认会在工具结果里追加「优先用 jj」的提示;
把 `guardMutatingGit` 设为 `deny` 后会直接拒绝并给出等价命令:

```
Blocked: `git commit` in a Jujutsu (jj) workspace (jj-colocated: /path/to/repo).
Use the jj equivalent instead:
  jj commit -m "…"      (or: jj describe -m "…" then jj new)
```

### 提交描述与拆分提交

默认 `commitStyle: 'auto'`:模型在第一次写描述/提交前会用 `jj_commit_style` 采样本仓库最近的描述
(jj 历史里包含 colocated 仓库的 Git 提交),继承其 `type(scope)` 语法、语言、大小写、标题长度与
body 习惯。历史为空、少于 3 条,或多种风格混杂无法确定时,工具返回 `needsUserChoice`,模型会先
询问你想用哪种风格,而不是擅自决定:

1. Conventional Commits(`feat(scope): …`)
2. Angular 约定
3. Gitmoji(`:sparkles: …`)
4. 纯文本短句
5. 自定义(你把规则或示例贴给它)

也可以直接在配置里固定风格(配置优先于历史):

```yaml
- id: jj-runtime
  name: '@aqian0/dsh-jj'
  config:
    commitStyle: angular            # auto | conventional | angular | gitmoji | plain | custom
    # commitStyle: custom
    # commitStyleCustom: '中文小写祈使句,不加前缀,必要时空行写原因'
```

用户在对话里明确指定的风格优先于配置与历史。对话里选定的风格只对当前会话生效(子代理/新会话会重新开始);
要长期固定请写进配置。这些提交策略配置由 `jj-runtime` 行读取,`preferJjContext: false` 会连同这段上下文
一起关闭;`preferSplitCommits: false` 只关闭注入的拆分提示,`jj_commit` 工具仍可用来拆分。

默认 `preferSplitCommits: true`:模型被要求按「小步提交」推进——每完成一个内聚步骤(一个功能、
一个修复、一次重构、一次测试/文档调整)就用 `jj_commit`(`jj commit -m "…"`)描述当前 change
并在其上加一个新的 change(未传 `paths` 时为空),而不是把整个任务堆在 `@` 里;从混杂改动中只提交
部分文件时,给 `jj_commit` 传 `paths`。这样人可以从容地逐个提交审阅。`commitGuidance: false` 可关闭以上注入的提示。

### 多会话并行与 jj workspace

默认部署里同一个 DSH 进程可能有多个顶层会话同时工作(Web GUI 的会话共用一个进程)。`jj-runtime` 只把
**当前正在执行回合(open turn)** 的其它顶层会话算作并行:宿主在回合结束后仍保留 Agent(切换会话不会销毁它),
所以「存活 / 打开过」不等于并发,单会话场景不会因为上午开过的会话而让模型去新建 jj workspace。检测到真正
并发的会话时,注入的上下文才会要求模型在动文件之前先隔离工作副本,并在任务收尾时做一次标准 rebase。

`multiSessionGuidance` 控制这段指引:

- `auto`(默认):仅当同一进程里还有其它顶层会话**正在执行回合**,且与本会话在同一个 jj 仓库工作时注入;
  一旦检测到并行会话,收尾 rebase 清单会保留到本会话结束(即使另一个会话先结束/变回空闲),避免最后交付时
  缺少 rebase 提示。
- `always`:不依赖自动检测,始终注入(仅顶层会话生效)——多个 `dsh` 进程并行操作同一仓库时用它。
- `off`:不注入多会话指引。

自动检测只能看到同一 DSH 进程内的会话:Web GUI 的会话都在一个进程里,而多个 `dsh` CLI 进程互相不可见;
跨进程并行请显式配置 `multiSessionGuidance: always`。检测是 fail-open 的:宿主没有提供 agent 注册表 /
工作目录服务时按「没有其它会话」处理,不注入,也不会影响会话启动;宿主没有活动状态投影
(`sessionProjections` 的 `turnBoundary`)时无法判断对端是否空闲,则退回保守行为——存在即可能并行,
宁可多提示一次也不漏掉真正并发的写操作。

**共享工作副本 vs 同仓库其它 workspace**

- 另一个**正在执行回合**的会话与本会话**共用同一个 jj 工作副本**时:动文件前先隔离(只读检查不受影响)。用 `jj_workspace_add`
  在仓库外建一个 sibling workspace(绝对路径,例如 `<repo 的兄弟目录>/repo-session-a`,不要放进仓库根内),
  再用 `working_directory` 工具把本会话切过去;先 `jj_workspace_list` 看一下,不要复用别人的 workspace。共享副本
  不安全:每条 jj 命令(包括 `jj workspace add`)都会先快照整个目录,不带 `paths` 的 `jj commit` 可能把另一个会话
  未提交的文件一起提交。如果本会话已经在共享副本里改了东西,先只提交本会话自己的路径(`jj_commit` 传 `paths`),
  再用 `jj_workspace_add` 的 `parents: ["@"]`(`jj workspace add --revision @ <path>`)把这部分带入新 workspace。
  只有用户明确要求时才直接改共享副本,此时提交要传 `paths`。
- 另一个**正在执行回合**的会话在**同一个 jj 仓库的另一个 workspace**:工作副本彼此隔离,但 bookmark 与 operation log 共享。
  只可以 rewrite 本会话自己的提交;不要去 rebase / undo / restore 另一个 workspace 的提交,也不要移动它的 bookmark。

**任务收尾:一次 `jj_handoff` 完成集成**

多会话指引生效时,收尾不再让模型手工串 fetch / rebase / 验证、失败就回来问用户,而是一次调用完成:

1. 用 `jj_commit` 提交最后一个内聚步骤,让本会话的改动是一段连续的 change 栈(不要留下未提交改动)。
2. 调用 `jj_handoff`(根/default workspace 里要传 `firstChange` = 本会话创建的最底层 change,避免 rebase 别人的历史;
   根 workspace 按 `.jj/repo` 是目录这一布局识别,重命名后仍然生效;
   工具会拒绝栈底以外的值(例如 `@`),否则只移动一半却报「已复核」。独立 workspace 里自动探测)。它一次完成:
   - `jj git fetch`;仓库没有远端不算错误(`no-remote`),继续用本地目标;
   - 自动解析集成目标:显式 `destination` → 配置的 `rebaseTarget`(默认 `trunk()`)→ `trunk()` → 本地 `main` → `master`;
     `trunk()` 在本地仓库解析为 root 时自动跳过,不需要用户选 revision;
   - 用 `roots(::@ ~ ::<target>)` 探测本 workspace 在目标之上的整段栈,`jj rebase -s <first> -d <target>` 一次性移动;
   - working copy 过期(stale)时自动 `jj workspace update-stale` 并重试一次;
   - 复核栈是否已落在目标上,并按需移动显式传入的 bookmark(只应传本会话自己的 bookmark);
   - 把冲突作为结构化结果返回,而不是让模型停下来问用户。
3. 若 `jj_handoff` 报告冲突:模型自己解决 —— 把文件编辑成最终内容(删掉 `<<<<<<<` / `%%%%%%%` / `>>>>>>>` 标记块)
   后跑 `jj_status` 让 jj 完成快照;中间提交的冲突用 `jj edit <change>` 修完再 `jj new <top change>` 回到顶层;
   再调用一次 `jj_handoff` 确认无冲突。只有确实无法安全解决的冲突才带着 change id 停下来报告。
4. 只有当 `jj_handoff` 报告「没有可用集成目标」(没有 `trunk()` / `main` / `master`,也没有显式 destination)时,
   才需要问用户要目标 revision —— 这是唯一需要用户决策的收尾场景。
5. 清理:本会话通过 `jj_workspace_add` 创建的临时 workspace,收尾验证后调用 `jj_workspace_cleanup` —— 它先把会话切回
   默认 workspace,再注销该临时 workspace(只允许注销本会话创建、且**名字与路径都匹配**的 workspace;同名重建的
   用户 workspace 不会被误删;目录文件保留,不会丢提交)。
   不是本会话创建的 workspace 会被拒绝,此时报告 `jj_workspace_list` 里的名字/路径和精确的 `jj workspace forget <name>`
   命令给用户;不要自己用 shell 执行 `jj workspace forget`(guard 会拒绝)。
6. 向用户报告 rebase 后的 change id、解析出的目标(以及是否来自自动回退)、bookmark 移动结果和 workspace 清理结果。

> 之前的流程把 fetch / 目标选择 / 栈 rebase / 验证 / 清理拆成多步,任一步失败(常见:本地仓库 `trunk()` 是 root、
> 没有远端、workspace 已被别的会话移动过)模型就会停下来让用户手动处理。`jj_handoff` 把这些判断和失败恢复内聚到插件里,
> 模型只需要在冲突或确实没有目标时继续处理。

### 工具一览

| 工具 | 作用 |
|---|---|
| `jj_status` | 工作副本 `@` 的状态 |
| `jj_log` | 按 revset 查看提交(`@`、`@-`、`bookmarks()` 等) |
| `jj_diff` | 指定 revset 的 diff |
| `jj_new` | 新建 change 并设为 `@` |
| `jj_commit` | 描述当前 change 并新建 change(`jj commit` = describe + new;可只提交部分路径,剩余改动留在新 change) |
| `jj_describe` | 就地修改提交描述(代替 `git commit --amend`) |
| `jj_commit_style` | 采样最近描述,报告仓库/配置的提交描述风格;无法确定时返回待用户选择的选项 |
| `jj_squash` | 把改动并进另一个提交 |
| `jj_undo` | 撤销/恢复到某个 operation |
| `jj_op_log` | operation 历史,用于找 `jj_undo` 的目标 |
| `jj_workspace_add` / `jj_workspace_list` | 新建/列出 jj workspace |
| `jj_bookmark_list` / `jj_bookmark_set` | 列出/设置 bookmark |
| `jj_rebase` | rebase revision 到目标;`mode` 可选 `source`(连同后代,整栈 rebase 用它)/ `branch` / `revisions`(默认,只移动指定提交) |
| `jj_handoff` | 收尾一次完成:fetch → 解析集成目标(`destination`/`rebaseTarget`/`trunk()`/本地 `main`·`master`)→ 探测并 source-mode rebase 整段栈 → stale 自动恢复 → 复核 → 按需移动 bookmark;冲突作为结构化结果返回 |
| `jj_workspace_cleanup` | 注销本会话通过 `jj_workspace_add` 创建的临时 workspace:先把会话切回默认 workspace,再 `jj workspace forget`;非本会话创建的 workspace 一律拒绝(仍由用户清理) |

非 jj 仓库会直接拒绝工具调用并说明如何初始化 jj;不会回退到 git。

## 配置

所有配置键可选,写在 profile 中对应 bundle 行的 `config` 里:

| 键 | 默认 | 说明 |
|---|---|---|
| `jjCommand` / `gitCommand` | `jj` / `git` | 可执行文件名;`gitCommand` 只用于探测和提示 |
| `timeoutMs` / `graceMs` | `30000` / `3000` | 子进程超时,以及超时后强制结束前的宽限时间 |
| `maxOutputBytes` | `262144` | 单个输出流(stdout / stderr)的上限 |
| `detectCacheTtlMs` | `10000` | 仓库检测结果的缓存时长 |
| `guardMutatingGit` | `warn` | jj 仓库内 mutating git 的处置:`warn`(放行+提示)/ `deny`(拒绝)/ `off` |
| `guardGitInJjNative` | `warn` | 仅 jj-native 仓库内 git 的处置 |
| `guardJjRepositoryWide` | `warn` | `jj undo` / `jj op restore` 等仓库级 jj 操作的处置 |
| `guardTools` | `bash` / `pwsh` / `terminal_send` | 参与上述守卫判定的 shell 工具名 |
| `guardCreateWorktree` | `true` | 在 jj 仓库里拒绝 `create_worktree`,引导用 `jj workspace add` |
| `readOnlyGitNotice` | `true` | colocated 仓库内只读 git 命令是否附「优先用 jj」提示 |
| `preferJjContext` | `true` | 会话开始时注入「优先用 jj」的模型可见上下文;关闭会连提交描述与多会话指引一起关闭 |
| `multiSessionGuidance` | `auto` | 多会话并行指引:`auto`(同进程的同一 jj 仓库里有其他**正在执行回合**的顶层会话时注入)/ `always` / `off` |
| `rebaseTarget` | `trunk()` | 收尾集成的首选目标 revset,不能为空;`jj_handoff` 解析不到真实提交时自动回退到本地 `main` / `master`,都没有才让用户指定 |
| `commitGuidance` | `true` | 是否注入提交描述风格与拆分提交指引(需 `preferJjContext` 开启) |
| `commitStyle` | `auto` | 描述风格:`auto`(继承历史)/ `conventional` / `angular` / `gitmoji` / `plain` / `custom` |
| `commitStyleCustom` | `''` | `commitStyle: custom` 时的风格规则(该模式下必填) |
| `preferSplitCommits` | `true` | 是否注入「按内聚步骤拆成小提交」的指引(仅影响注入上下文) |
| `commitStyleSampleLimit` | `30` | `jj_commit_style` 最多沿用的非空描述条数(读取上限另受 `jj-tools` 行 `maxLogLimit` 约束) |
| `defaultLogLimit` / `maxLogLimit` | `30` / `200` | `jj_log` 的默认与最大返回条数 |
| `defaultCwd` | `''` | 工具没有 `workdir` 时的回退目录(空 = 进程 cwd) |

> `commitGuidance` / `commitStyle` / `commitStyleCustom` / `preferSplitCommits` / `commitStyleSampleLimit`
> 由 `jj-runtime` 行读取:prompt 与 `jj_commit_style` 共用同一份策略,这些键写在 `jj-tools` 行不会生效。
> `multiSessionGuidance` / `rebaseTarget` 同样只由 `jj-runtime` 行读取,只影响注入的多会话与收尾 rebase 指引。

## 已知限制

- jj 未安装或目录不是 jj 仓库时,`jj_*` 工具会报错并给出处理建议,不会退回 git。
- 描述风格检测是启发式的:分类只看描述首行,body/页脚会通过 `jj_commit_style` 的 examples 返回给模型参照
  (`jj_log` 只返回首行),但都不参与自动判定;少于 3 条非空描述或混杂时转为询问用户;设置
  `commitStyle: custom` 时完全按 `commitStyleCustom` 的规则执行。
- Angular 与 Conventional Commits 语法相同,自动检测统一报 `conventional`(需要严格 Angular 规则时请配置
  `commitStyle: angular`);合并提交、大写 `Fix:` 之类的写法会归入 plain 或造成 mixed,可能触发询问。
- `agent-instructions` 的 `.jj` 根标记覆盖在 Web profile 不生效(Web 在 bundle 层禁用了顶层该行),headless/CLI profile 生效。
- jj-native 工作区里项目级 skill 根仍按 `.git` 查找(上游硬编码),暂不可用。
- 多会话自动检测只看同一 DSH 进程内的顶层会话(Web GUI 的会话都在一个进程;多个 `dsh` CLI 进程互相不可见),
  且只把**正在执行回合**的会话算作并行:宿主任一回合结束后仍保留 Agent,打开过/空闲的会话不是并发工作,单会话
  场景不会因此被推进新的 jj workspace。跨进程并行请配置 `multiSessionGuidance: always`。检测是 fail-open 的:
  宿主没有 agents / workingDirectory 服务时 `auto` 不注入任何内容;没有 `sessionProjections` 活动状态时无法判断
  对端是否空闲,退回「存在即可能并行」的保守行为,都不会让会话启动失败。
- 子代理不注入多会话指引(包括 `always`):子代理与父会话共享工作副本,父会话继续运行时子代理同时写文件不受本功能
  覆盖;需要严格隔离时由父会话显式给子任务指定独立 workspace。
- 临时 workspace 清理:只有本会话通过 `jj_workspace_add` 创建(按会话记录的 workspace 名字+路径校验)、且手写校验
  (无未提交改动、无未解决冲突)通过的 workspace 才能由 `jj_workspace_cleanup` 注销;通过 shell `jj workspace add`
  创建的、用户创建的和其它会话的 workspace 都不会被插件注销(shell 里的 `jj workspace forget` 仍被 guard 拒绝),
  需要用户执行 `jj workspace forget <name>` 并删除目录。工具只校验工作副本干净,不校验 handoff 是否已完成;
  目录文件在任何情况下都不会被自动删除。
- 集成交付不会自动 push:没有远端分支或凭据时,`jj_handoff` 只保证本地集成到目标;推送仍由用户执行
  (`jj git push --bookmark <name>`),这是唯一有意保留给用户的操作。

## License

[MIT](./LICENSE)
