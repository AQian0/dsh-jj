# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 一等支持。

## 功能

- **仓库识别**:区分 `git` / `jj-colocated` / `jj-native` / 非仓库;jj 与 git 嵌套时给出明确归属,不会把 jj 工作区当成普通 git 仓库。
- **防混淆 guard**:在 jj 仓库里执行 `git commit`、`git reset` 等会破坏 change graph 的命令时,默认放行并在结果里提示等价 jj 命令,也可配置为直接拒绝。
- **jj 原生工具**:15 个 `jj_*` 工具(status / log / diff / new / commit / describe / commit style / squash / undo / op log / workspace / bookmark / rebase)。
- **提交描述风格**:默认继承仓库里最近 jj/Git 描述的写法;历史不足或混杂时先询问你选 Conventional Commits / Angular / Gitmoji / 纯文本或自定义风格,也支持在配置里固定风格。
- **小步提交**:默认要求模型每完成一个内聚步骤就用 `jj commit` 收尾并开新 change,避免整份任务堆在 `@` 里难以审阅。
- **模型上下文**:在 jj 仓库里自动向模型注入「优先用 jj」的上下文;非 jj 仓库不注入。
- **项目根发现**:让 `agent-instructions` 也能把 `.jj` 当作项目根标记(headless/CLI profile 生效)。
- **不回退 git**:jj 不可用或目录不是 jj 仓库时明确报错,绝不静默改用 git。

## 安装

需要 DSH 与 `jj` CLI(`jj` 在 `PATH` 中,或用 `jjCommand` 指定);无其他运行时依赖。
兼容 DSH `0.2.1-rc.2` 及之后的 `0.2.x`:peer 依赖写作 `^0.2.1-rc.2`,同一 `0.2` 系列内的补丁/预发布升级(如 `0.2.1-rc.3`)无需更新插件;`0.3` 起需要插件适配。

**从 npm 安装**:在 Plugin Manager 里把 spec 填成精确版本(如 `@aqian0/dsh-jj@0.2.2`,避免发版后已装内容变化),或执行:

```bash
dsh plugin --profile <name> add @aqian0/dsh-jj@0.2.2
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
| `jj_rebase` | rebase 提交及其后代 |

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
| `preferJjContext` | `true` | 会话开始时注入「优先用 jj」的模型可见上下文;关闭会连提交描述指引一起关闭 |
| `commitGuidance` | `true` | 是否注入提交描述风格与拆分提交指引(需 `preferJjContext` 开启) |
| `commitStyle` | `auto` | 描述风格:`auto`(继承历史)/ `conventional` / `angular` / `gitmoji` / `plain` / `custom` |
| `commitStyleCustom` | `''` | `commitStyle: custom` 时的风格规则(该模式下必填) |
| `preferSplitCommits` | `true` | 是否注入「按内聚步骤拆成小提交」的指引(仅影响注入上下文) |
| `commitStyleSampleLimit` | `30` | `jj_commit_style` 最多沿用的非空描述条数(读取上限另受 `jj-tools` 行 `maxLogLimit` 约束) |
| `defaultLogLimit` / `maxLogLimit` | `30` / `200` | `jj_log` 的默认与最大返回条数 |
| `defaultCwd` | `''` | 工具没有 `workdir` 时的回退目录(空 = 进程 cwd) |

> `commitGuidance` / `commitStyle` / `commitStyleCustom` / `preferSplitCommits` / `commitStyleSampleLimit`
> 由 `jj-runtime` 行读取:prompt 与 `jj_commit_style` 共用同一份策略,这些键写在 `jj-tools` 行不会生效。

## 已知限制

- jj 未安装或目录不是 jj 仓库时,`jj_*` 工具会报错并给出处理建议,不会退回 git。
- 描述风格检测是启发式的:分类只看描述首行,body/页脚会通过 `jj_commit_style` 的 examples 返回给模型参照
  (`jj_log` 只返回首行),但都不参与自动判定;少于 3 条非空描述或混杂时转为询问用户;设置
  `commitStyle: custom` 时完全按 `commitStyleCustom` 的规则执行。
- Angular 与 Conventional Commits 语法相同,自动检测统一报 `conventional`(需要严格 Angular 规则时请配置
  `commitStyle: angular`);合并提交、大写 `Fix:` 之类的写法会归入 plain 或造成 mixed,可能触发询问。
- `agent-instructions` 的 `.jj` 根标记覆盖在 Web profile 不生效(Web 在 bundle 层禁用了顶层该行),headless/CLI profile 生效。
- jj-native 工作区里项目级 skill 根仍按 `.git` 查找(上游硬编码),暂不可用。

## License

[MIT](./LICENSE)
