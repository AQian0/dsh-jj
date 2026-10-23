# dsh-jj

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Jujutsu (jj) 一等支持。

## 功能

- **仓库识别**:区分 `git` / `jj-colocated` / `jj-native` / 非仓库;jj 与 git 嵌套时给出明确归属,不会把 jj 工作区当成普通 git 仓库。
- **防混淆 guard**:在 jj 仓库里执行 `git commit`、`git reset` 等会破坏 change graph 的命令时,默认放行并在结果里提示等价 jj 命令,也可配置为直接拒绝。
- **jj 原生工具**:13 个 `jj_*` 工具(status / log / diff / new / describe / squash / undo / op log / workspace / bookmark / rebase)。
- **模型上下文**:在 jj 仓库里自动向模型注入「优先用 jj」的上下文;非 jj 仓库不注入。
- **项目根发现**:让 `agent-instructions` 也能把 `.jj` 当作项目根标记(headless/CLI profile 生效)。
- **不回退 git**:jj 不可用或目录不是 jj 仓库时明确报错,绝不静默改用 git。

## 安装

运行插件需要 DSH 与 `jj` CLI(`jj` 需在 `PATH` 中,或用 `jjCommand` 指向可执行文件);插件本身没有额外的运行时依赖。

### 本地目录(开发/未发布)

`lib/` 是构建产物、不入库,所以本地安装前先在仓库根构建一次:

```bash
npm run build   # 构建 lib/;完整校验(构建 + 类型检查 + 242 个测试)用 npm test
```

然后在 DSH 的 Plugin Manager 里安装本地 bundle:

- Web GUI:设置页 → 插件管理 → 安装本地 bundle,spec 填本仓库的绝对路径(如 `/path/to/dsh-jj`);
- Agent 工具:`plugin_manager` 的 `install_bundle`,target 填同一个绝对路径。

### 从 npm(发布后)

在 Plugin Manager 里把 spec 填成精确版本(避免下次发版改变已装内容):

```
@aqian0/dsh-jj@0.2.1
```

也可以只安装依赖:`dsh plugin --profile <name> add @aqian0/dsh-jj@0.2.1`。

安装后 bundle 自动贡献 `jj-runtime` / `jj-tools` / `jj-guard` 三行,并给 `agent-instructions` 加上 `.jj` 根标记;用 Plugin 页面或 `list_plugins` 确认三行 enabled。

## 使用

安装后自动生效,无需手工写 profile。典型的 agent 用法:

| 你说 | 模型调用 |
|---|---|
| "看下当前 jj 状态" | `jj_status` |
| "列出最近 10 个提交" | `jj_log` |
| "把当前改动并进上一个提交" | `jj_squash` |
| "改一下当前 change 的描述" | `jj_describe` |
| "撤销刚才那次 jj 操作" | `jj_undo` |
| "新建一个 workspace 放到 /tmp/wt" | `jj_workspace_add` |

在 jj 仓库里直接让 agent 跑 `git commit` 之类的命令时,默认会在工具结果里追加「优先用 jj」的提示;
把 `guardMutatingGit` 设为 `deny` 后会直接拒绝并给出等价命令:

```
Blocked: `git commit` in a Jujutsu (jj) workspace (jj-colocated: /path/to/repo).
Use the jj equivalent instead:
  jj commit -m "…"      (or: jj describe -m "…" then jj new)
```

### 工具一览

| 工具 | 作用 |
|---|---|
| `jj_status` | 工作副本 `@` 的状态 |
| `jj_log` | 按 revset 查看提交(`@`、`@-`、`bookmarks()` 等) |
| `jj_diff` | 指定 revset 的 diff |
| `jj_new` | 新建 change 并设为 `@` |
| `jj_describe` | 就地修改提交描述(代替 `git commit --amend`) |
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
| `preferJjContext` | `true` | 会话开始时注入「优先用 jj」的模型可见上下文 |
| `defaultLogLimit` / `maxLogLimit` | `30` / `200` | `jj_log` 的默认与最大返回条数 |
| `defaultCwd` | `''` | 工具没有 `workdir` 时的回退目录(空 = 进程 cwd) |

## 已知限制

- jj 未安装或目录不是 jj 仓库时,`jj_*` 工具会报错并给出处理建议,不会退回 git。
- `agent-instructions` 的 `.jj` 根标记覆盖在 Web profile 不生效(Web 在 bundle 层禁用了顶层该行),headless/CLI profile 生效。
- jj-native 工作区里项目级 skill 根仍按 `.git` 查找(上游硬编码),暂不可用。

## 开发

仓库里的手写代码全部是 TypeScript,和 DSH 本身及官方插件包的组织方式一致:

| 位置 | 内容 |
|---|---|
| `src/**/*.ts` | 插件实现(构建入口) |
| `test/**/*.test.ts` | 测试套件(`node:test`,由 Node 原生类型擦除直接运行) |
| `scripts/*.ts` | 开发脚本(离线依赖链接) |
| `lib/**/*.js` + `lib/types/**/*.d.ts` | `tsc` 构建产物,不入库;npm 发布包中包含(官方插件包同样只发布构建输出) |

测试与脚本直接以 TS 运行,因此开发/CI 需要 **Node 24+**(内置类型擦除)。

```bash
node scripts/setup-links.ts    # 离线链接全局 DSH 依赖(仅类型检查/构建需要,幂等)
npm run build                  # tsc: src/ -> lib/(提交入库的产物)
npm run typecheck              # 类型检查 src/ + test/ + scripts/(tsconfig.test.json)
npm test                       # 构建 + 类型检查 + 242 个测试
```

`lib/` 是构建产物且不入库;改动 `src/` 后运行 `npm run build`。npm 发布由 `prepack` 自动构建,CI 也会在测试前显式构建。

## License

[MIT](./LICENSE)
