# AGENTS.md

面向在本仓库工作的 AI 代理(以及人类协作者)的开发说明。用户文档在 [README.md](./README.md);
本文件只讲环境、架构、约定、验证与提交流程。内容以代码和 `npm test` 为准,发现过期请直接修正。
本仓库自身是 **jj-colocated** 工作区,版本控制一律用 jj。

## 项目速览

- `@aqian0/dsh-jj`:为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供一等 Jujutsu (jj) 支持的插件包。
- 三个可独立加载的 bundle 入口(声明在 `cordis.patch.yml`,加载顺序即行的顺序):
  - `dsh-jj`(Cordis 名 `jj`):`ctx.jj` 服务、仓库检测、会话级「优先用 jj」与多会话/收尾 rebase 上下文;
  - `dsh-jj/tools`(`jj-tools`):17 个 `jj_*` 模型工具;
  - `dsh-jj/guard`(`jj-guard`):git/jj 命令混淆防护。
- 纯 TypeScript + ESM,**零运行时依赖**:DSH 包全部通过 `peerDependencies` 由宿主提供(版本见 `package.json`)。
- 没有任何构建工具链依赖:构建只用 `tsc`,测试只用 `node --test`。

## 环境与准备

- Node.js 24+:测试直接由 Node 内置类型擦除运行 `.ts`;CI 固定 Node 24。
- 真实 `jj`(CI 固定 0.46.0)和 `git` 必须在 `PATH`:测试用真实仓库夹具,不 mock 二进制行为。
- `tsc` 6.x(CI 固定 `typescript@6.0.3`、`@types/node@26.6.5`;仓库刻意不带 devDependencies)与 DSH 的公开
  peer 类型都需要下面准备的依赖:软链方式只提供 DSH 类型,`tsc` 需在 `PATH` 或本地 `node_modules/.bin` 中。
- 首次准备(二选一;`npm run setup` 自动探测,已就绪时直接 no-op):
  1. **软链到 DSH 安装**(CLI / bun 全局安装):`npm run setup` 把 `node_modules/@deepseek-ai`、
     `node_modules/@types` 软链到本机 DSH 的 `node_modules`。源依次尝试 `DSH_NODE_MODULES`、
     `$HOME/.cache/.bun/install/global/node_modules`、`$HOME/.bun/install/global/node_modules`。
     桌面版 DSH(macOS / Windows)把依赖放在 app bundle 内、无法软链,用第 2 种方式。
  2. **npm 安装公开 peer 依赖**(仅首次需要网络;不写 lockfile、不新增依赖):仓库根执行
     `npm install --no-package-lock --ignore-scripts`,再装编译器
     `npm install --no-save typescript@6.0.3 @types/node@26.6.5`。之后 `npm run setup` / `npm test`
     检测到依赖已可解析会直接 no-op,日常开发保持离线。
- `npm run setup:check`(即 `node scripts/setup-links.ts --check`)只探测不写文件,适合 CI 或提交前确认 bootstrap。
  只有 `tsc`(构建、`npm run typecheck`)需要这些依赖;`node --test` 本身不依赖软链。
- 日常开发全程离线:不要新增依赖、不要提交 lockfile、不要让测试访问网络。
- 查 DSH API:类型与实现位于本仓库 `node_modules/@deepseek-ai/*`(`lib/` + `lib/types/*.d.ts`),由上面的
  bootstrap 提供;桌面版 app bundle 内的副本不直接可读。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 提交前必须全绿:setup-links(依赖已就绪则 no-op)→ 测试类型检查 → `node --test`(`build.test.ts` 负责构建 `lib/`)|
| `npm run build` | `tsc -p tsconfig.json`:`src/` → `lib/`(构建产物,不入库) |
| `npm run typecheck` | 对 `src/` + `test/` + `scripts/` 做类型检查(`tsconfig.test.json`,`noEmit`) |
| `npm run check` | 构建项目的 `noEmit` 检查 |
| `npm run test:unit` | 只跑测试;仍要求真实 jj/git,`build.test.ts` 会先构建 `lib/` |
| `npm run test:coverage` | 用 Node 内置覆盖率跑全部测试(`--test-coverage-include='src/**/*.ts'`,排除 `lib/`);当前 line ≈96% |
| `npm run setup` | 准备离线依赖:软链 DSH 安装,或检测到 npm 安装的依赖后 no-op |
| `npm run setup:check` | 只探测依赖是否就绪(`--check`,不写文件) |

没有 lint / format 脚本;push / PR CI 运行 `npm test`(`.github/workflows/ci.yml`);`release.yml` 在发布前复用同一门禁
(`npm test`,`build.test.ts` 负责构建 `lib/`),再显式构建、校验发布内容并发布。两个 workflow 的 jj 安装会校验资产
SHA-256,actions 固定到 commit SHA(注释写明来源与升级方式),并显式安装测试专用依赖
`@deepseek-ai/dsh-session-projection`(本插件不是它的 peer)。

## 仓库布局

| 路径 | 内容 |
|---|---|
| `src/index.ts` | 运行时入口:`JjService` 注册 + 全局 prompt context;`assembleBaseLayer` 供测试 |
| `src/service.ts` | `JjOperations`(17 个 operation + handoff 流程,注入 runner);barrel re-export `jj-templates` / `jj-service` |
| `src/jj-templates.ts` | 纯模块:jj 模板常量、change 记录类型与 JSON 解析(无 I/O、无 subprocess) |
| `src/jj-service.ts` | `JjService`:Cordis 服务、TTL 缓存/`peek`/`warm`/dispose、lifetime 信号合并 |
| `src/tools.ts` | barrel re-export `tool-schemas` / `tool-shared` / `tool-definitions` / `tool-entry` |
| `src/tool-schemas.ts` | 共享输出 schema 与 change view(纯数据/视图) |
| `src/tool-shared.ts` | 拒绝文案、workspace 工具函数与 `ToolContext` / `JjToolService` 类型 |
| `src/tool-definitions.ts` | `jjToolDefinitions` 与 17 个 `defineTool`(含 session workspace 所有权) |
| `src/tool-entry.ts` | `registerJjTools` / `apply` / `name` / `inject` 与 `cwdFor` |
| `src/detect.ts` | 仓库识别:同步文件系统 sniff + CLI 权威探测 |
| `src/git-command.ts` | barrel re-export `git-tokenize` / `git-equivalence` / `git-rules` / `jj-rules` |
| `src/git-tokenize.ts` | shell 分词/运算符/重定向/heredoc/命令替换扫描(纯函数) |
| `src/git-equivalence.ts` | git 安全分类与等价命令表类型/规则(纯数据) |
| `src/git-rules.ts` | git 子命令规则表与 `classifyGitInvocation`(纯函数) |
| `src/jj-rules.ts` | jj 子命令 scope 表与 `classifyJjInvocation`(纯函数) |
| `src/guard.ts` | git 混淆 guard:warm-up 预计算 + 同步决策 + 文案 |
| `src/jj-command.ts` | jj/git 子进程适配、非交互 env、错误归类 |
| `src/config.ts` | schemastery `Config`、`JjPluginConfig`、`resolveConfig`、启动校验 |
| `src/commit-style.ts` | 提交描述风格策略(继承历史 / 询问用户 / 预设与自定义)与拆分提交指引(纯模块,无 I/O) |
| `src/types.ts` | 共享类型与词汇(纯声明) |
| `src/prompt-context.ts` | 会话开始时注入「优先用 jj」、提交描述/拆分提交与多会话/收尾 rebase 的模型可见上下文 |
| `src/multi-session.ts` | 多会话检测(同一 jj 仓库里的顶层会话、workspace 是否共享)与模型可见的 workspace 隔离 / 收尾 rebase 指引(纯模块,无 subprocess) |
| `test/**/*.test.ts` | `node:test` 测试;`test/helpers/` 是真实仓库夹具与 runner |
| `test/multi-session.test.ts` | 多会话检测模式与指引文案的单元测试 |
| `test/service.test.ts` | `JjService` 的 TTL 缓存 / warm / peek / dispose 生命周期测试 |
| `test/jj-command.test.ts` | 子进程适配层(fake `ctx.subprocess`:超时/取消/截断/错误归类)测试 |
| `scripts/setup-links.ts` | 可移植的离线依赖引导:已就绪时 no-op、`--check` 只探测、否则软链到 DSH 安装 |
| `.github/workflows/` | CI:`ci.yml`(push / PR 跑 `npm test`)、`release.yml`(tag 触发发布,复用同一门禁) |
| `locale/`、`tools/locale/`、`guard/locale/` | 三个入口各自的本地化 meta(`en.json` / `zh.json`) |
| `cordis.patch.yml` | bundle patch:三行 `insert` + `agent-instructions` 配置覆盖 |
| `lib/` | `tsc` 产物,被忽略、不提交;发布包由 `package.json.files` 决定 |

## 架构与硬性规则

1. **入口契约**:每个入口导出 `name` / `inject` / `apply` / `Config`;`build.test.ts` 会校验这些值与 `inject` 列表。
2. **分层**:`index.ts` 拥有 `ctx.jj`;tools/guard 通过 `inject: ['tools', 'jj'(, 'workingDirectory')]` 消费。
   删改 `inject` 会破坏其他行加载。
3. **纯模块**:`detect.ts`、`git-command.ts`(barrel)、`git-tokenize.ts`、`git-equivalence.ts`、
   `git-rules.ts`、`jj-rules.ts`、`types.ts`、`commit-style.ts`、`multi-session.ts`、`jj-templates.ts`
   不得在运行时 import 任何 `@deepseek-ai/*`(由 `build.test.ts` 强制)。DSH 运行时 import 仅限:
   `config.ts`(schemastery)、`jj-service.ts`(cordis)、`tool-definitions.ts`(dsh-tools)、
   `jj-command.ts`(dsh-subprocess)。
4. **不直接 spawn**:所有 jj/git 调用都走注入的 `RunJj` / `RunCommand`(统一超时、宽限、输出截断、env 清洗)。
   这是可测试性的基础,也保证 guard/service 行为一致。
5. **检测语义**:`detectVcs` 永远返回 `VcsDescriptor`,仓库问题通过 `notices` + `verified === false` 上报,
   不抛业务异常;CLI 权威是 `jj --ignore-working-copy workspace list`,不是 `jj root`。
6. **guard 必须同步**:工具守卫是同步接口,子进程探测不能在其中发生,因此由 `tools/pre-execute` warm-up 预计算,
   `ctx.tools.guard` 只读缓存;任何环节失败都 fail-open(不阻塞调用)。默认策略是 `warn`(放行并给模型提示),
   `deny` 可通过配置开启;hard-deny(如 scope creep、越权 workspace 操作)不可通过配置放开。
7. **非交互**:jj 调用统一经 `jjNonInteractiveEnv` 等封装,设置 `ui.color=never` 并屏蔽编辑器/prompt
   (测试 V2/V4 覆盖)。新增 jj 命令不要绕过这层。
8. **拒绝文案**:「非 jj 仓库 / jj 缺失 / 元数据损坏」的模型可见文案集中在 `tool-shared.ts` 的 `jjRefusalText`;
   guard 拒绝文案在 `guard.ts` 的 `build*` 函数。任何路径都不得静默回退到 git。
9. **配置一致**:`Config` 是默认值与键集合的唯一来源;`ResolvedJjConfig` / `JjPluginConfig` 由
   schemastery `Schemastery.TypeT` / `Partial<...>` 派生,`resolveConfig` 用 `Config({})` 的默认值 + 调用方覆盖,
   `assertServiceableConfig` 只做构造期业务校验——新增键只需改 `Config` 一处。三个入口 `apply` 会对
   「放错 bundle 行」的显式键 `logger.warn`(归属表 `CONFIG_OWNERSHIP`;仅告警、不阻断启动)。
10. **bundle patch 语义**:`cordis.patch.yml` 里非 `insert` 行会**整体替换**目标行 config:只写改动项会清掉其余键,
    必须重述所有要保留的键(如 `maxBytes: 65536`),并在 `build.test.ts` 里补对应断言。
11. **版本兼容**:DSH peer 依赖(`@deepseek-ai/dsh-*`)必须写成 caret 范围(如 `^0.2.1-rc.2`),
    不要钉死精确版本——宿主在安装和 profile 启动时用运行时版本(`dsh --version`)与该范围做 SemVer 匹配
    (预发布也参与),精确钉版会把本版适配版本之后的每个补丁版都判定为不兼容。`build.test.ts` 强制这一点。
12. **多会话检测 fail-open**:多会话指引只比较 `ctx.agents.roots()` 里的顶层会话(子代理不算并行会话)与
    `workingDirectory` 给出的会话目录,再用同步的 `peek` / sniff 解析 jj workspace 身份,不新增 DSH peer 依赖;
    **存活不等于并发**:宿主在回合结束后仍保留 Agent,所以对端只有在 `sessionProjections.stateOf(session,
    'turnBoundary').openTurnStartSeq !== null`(正在执行回合)时才可能算并行;已知空闲(`active: false`)的对端
    必须被 `parallelPeerCwds` 过滤掉,否则单会话也会被误判而新建 jj workspace。活动状态服务 / 投影缺失或抛错时
    该对端按「可能存在并行」的保守行为处理(fail-open),agents / workingDirectory 缺失或抛错时按「没有其他会话」
    处理(`auto` 不注入),任何一条路径都不得阻断 prompt 组装。
13. **收尾自动化(`jj_handoff` / `jj_workspace_cleanup`)**:
    - `service.ts` 的 `handoff()` 是收尾的唯一入口:fetch(无远端不算错)→ 目标解析(显式 `destination` →
      配置 `rebaseTarget` → `trunk()` → 本地 `main` → `master`,跳过 root commit;显式目标解析到 root 是
      模型错误,必须报错而不是静默换目标;全失败才报「问用户」)→ `roots(::@ ~ ::target)` 探测整段栈 →
      `jj rebase -s` → 复核 base 并返回冲突数据。不要把这些步骤拆回 prompt;`needsCommit` 时先让模型
      `jj_commit`,不要代为描述。
    - **stale 恢复必须包住整个流程**:stale 时连目标/栈的 `jj log` 读取都会失败,所以 `handoff()` 用
      「`handoffFlow()` 抛 stale → `jj workspace update-stale` → 重跑一次 `handoffFlow()`」实现;不要只在
      rebase 调用外加 retry,也不要把 stale 读取错误吞成「找不到目标」。
    - `firstChange` 必须是本 workspace 在目标之上那段栈的**栈底**(在 `roots(::@ ~ ::target)` 里):传 `@`
      或中间 change 会只移动一部分却返回 `rebased/onTarget` 成功,必须报错并给出候选。根(default)workspace
      的判定用**布局**而不是名字(`<root>/.jj/repo` 是目录 ⇒ 根 workspace,linked workspace 是 pointer 文件),
      这样 `jj workspace rename` 之后仍然要求 `firstChange`。
    - 目标解析/失败信息必须自带下一步(本地 bookmark 列表、`firstChange` 候选),不要返回裸 jj revset 错误;
      已集成路径同样要处理请求的 bookmark(移动或 `bookmarkSkipped`),不能静默丢弃。
    - `jj_workspace_cleanup` 的前提是**本会话所有权**:只有通过 `jj_workspace_add` 工具创建(按 `exec.agent`
      记在 `WeakMap`,记录**名字+规范路径**)、当前 workspace 不是 `default`、working copy 无未提交改动/冲突的
      workspace 才能注销;注销前必须先 `workingDirectory.set` 把会话切回默认 workspace。目录文件永不删除。
      这是对旧「清理只能交给用户」规则的**唯一例外**,shell 里的 `jj workspace forget <other>` 仍由 guard 拒绝
      (`buildJjWorkspaceForgetRefusal`)。
    - `JjOperations.workspaceAdd` 必须显式传 `--name`(缺省名用 `basename`)并按名字/规范路径解析返回的
      workspace,不要用 `workspaces[last]` 猜:否则在 macOS symlink 路径下会把别的 workspace 记成本会话所有。
    - 变更这套行为必须同步 `test/service-tools.test.ts`(handoff / cleanup 端到端,含 stale、firstChange
      校验、ambiguous roots、cleanup 所有权)、`test/multi-session.test.ts`(收尾清单文案)、
      `test/guard.test.ts`(forget 拒绝文案)与 README「任务收尾」。

## 代码约定

- TypeScript strict,`noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax` / `isolatedModules` /
  **`erasableSyntaxOnly`** 全开:不要用 `enum`、`namespace`、构造函数参数属性等不可擦除语法;类型导入用 `import type`。
- 相对导入带 `.ts` 扩展名(`rewriteRelativeImportExtensions` 在构建时改写为 `.js`)。
- 风格:2 空格缩进、单引号、分号、约 120 列;模块头用 JSDoc `@module`,导出的 API 写 JSDoc。
  源码与测试注释用英文,README 等用户文档用中文。
- 源码注释中的 `design contract §…` 指历史设计文档(不在本仓库):以现有实现和测试对齐,不要臆造契约条款。
- 测试:`node:test` + `node:assert/strict`,一个测试文件对应一个模块;夹具用 `mktemp` 隔离、显式 `cwd`、
  并自检 jj root 指向夹具目录(防止在真实仓库里建/改夹具——曾发生过共享 workspace 被误操作的事故);
  不要 mock 仓库行为;改行为先补测试。
- `test/build.test.ts` 额外守护:产物清单从 `src/*.ts` 推导(含 `lib/types/*.d.ts`)、`package.json` 的
  `main`/`types`/`exports`/`files` 目标必须存在、纯模块的 DSH 运行时 import(单/双引号)均被拒绝、
  以及手写 `.ts` 禁止 tab/行尾空白/CRLF(>120 列仅提示)。新增源模块或改打包配置时先让这些断言通过。

## 常见任务

**新增一个 `jj_*` 工具**

1. `service.ts` 的 `JjOperations` 加方法(复用 runner、超时/截断/非交互);
2. `tool-definitions.ts` 用 `defineTool` 定义:名称 `jj_*`、description 首句点明 this is jj / not git、参数 schema、
   输出 schema + `render`,非 jj 目录经 `requireWorkspace` / `jjRefusalText`(`tool-shared.ts`)拒绝;
3. `test/service-tools.test.ts` 补定义、schema 校验、端到端与「只走 jj、不走 git」用例;
4. 同步 README「工具一览」,以及 `prompt-context.ts` 中的命令列表(如相关)。

**新增配置键**:`config.ts` 的 `Config` schema(默认值/类型由此自动派生,`resolveConfig` 与两个类型无需手改)→ README「配置」表 → 按影响补 guard/detect/service 测试。

**修改提交描述策略**:`commit-style.ts` 纯函数(分类 / 检测 / 策略 / 文案)→ `config.ts` 的 `Config` schema →
`prompt-context.ts` 与 `tools.ts`(`jj_commit_style`、`jj_commit`)注入 → `test/commit-style.test.ts` 与
`test/service-tools.test.ts`;默认保持 `auto`(继承历史、无法确定时询问用户),不要改成静默固定风格,
也不要让默认 `preferSplitCommits` 退化回「只改当前工作区」。提交策略以 `ctx.jj`(runtime 行)的配置为
唯一来源:`jj_commit_style` 读 `service.operations.config`,不要改回读 tools 行配置,否则 prompt 与工具
会给出互相矛盾的风格。

**修改 guard 行为**:命令分类表在 `git-rules.ts` / `jj-rules.ts`(解析原语在 `git-tokenize.ts`,均保持纯函数)→
`guard.ts` 文案与策略 → `test/guard*.test.ts` 与 `test/git-command.test.ts`;
不要把默认从 `warn` 改成 `deny`,也不要放开 hard-deny。

**修改多会话并行 / 收尾 rebase 指引**

1. `multi-session.ts`:检测(`ctx.agents.roots()` 顶层会话 + `turnBoundary` 活动状态 + workingDirectory,纯模块、fail-open)与模型可见文案
   (共用工作副本先隔离到仓库外的独立 workspace、同仓库不同 workspace 不要改写别人的提交、收尾清单);
   收尾清单现在要求模型**调用一次 `jj_handoff`**,而不是手工串 `jj git fetch` / 选目标 / `jj_rebase` / 复核;
   目标解析、source 模式整栈 rebase、stale 恢复、冲突上报都在 `service.ts` 的 `handoff()` 里实现
   (jj 0.46 的默认 `revisions`/`-r` 只移动指定提交,不会带走后代,所以整栈必须 `-s`);
   **shell 里的 `jj workspace forget` 仍不可要求模型执行**:只有 `jj_workspace_cleanup` 工具可以注销
   本会话通过 `jj_workspace_add` 创建的临时 workspace,其它情况清理交给用户(报告 `jj workspace list` 的名字/路径);
   并行会话一旦被检测到,收尾清单要在同一会话后续轮次继续注入(`parallelSeen` latch),子代理不注入;
2. `prompt-context.ts`:把这一段拼进 jj 会话上下文,受 `multiSessionGuidance` / `rebaseTarget` 控制;
3. `config.ts` 的 `Config` schema:`multiSessionGuidance`(`auto` / `always` / `off`,默认 `auto`)与 `rebaseTarget`
   (默认 `trunk()`,不得为空);
4. `index.ts`:在 `apply` 里把存活会话列表(含 `sessionProjections` 的 `turnBoundary` 活动状态)与 workingDirectory
   接给指引;已知空闲的对端必须在 `parallelPeerCwds` 里被过滤,检测 fail-open,不可阻断启动;
5. `service.ts` / `tools.ts`:收尾自动化(`handoff()`、`jj_handoff`、`jj_workspace_cleanup`)与
   guard 的 `jj workspace forget <other>` 拒绝文案(`buildJjWorkspaceForgetRefusal`)要保持一致;
6. 测试:`test/multi-session.test.ts` 覆盖检测/模式/文案,`test/service-tools.test.ts` 覆盖 handoff / cleanup
   端到端(含 no-remote、already-integrated、needsCommit、conflicts、bookmark、默认 workspace 的 `firstChange`
   约束、cleanup 所有权与回退),同步 `test/prompt-context.test.ts`、`test/guard.test.ts` 与
   `test/build.test.ts` 的纯模块列表;
7. 同步 README「使用 / 配置 / 工具一览 / 已知限制」与 `locale/*.json` 的 meta.description;默认保持 `auto`
   (跨进程需用户显式配置 `always`),不要让多会话检测变成隐式依赖。

**修改检测**:sniff 与 CLI 权威两条路径都要覆盖;夹具需包含 colocated / jj-native / 损坏元数据 /
git 嵌套 / 共享 workspace 等场景;同步 README「已知限制」。

## 版本控制与提交(jj)

- 工作副本 `@` 本身就是提交:`jj status` / `jj diff` 检查 → `jj describe -m "…"` → `jj new`,
  或一步 `jj commit -m "…"`。
- **不要用 git 写操作**(`git commit` / `reset` / `checkout` 等):git 写入不进 jj operation log,`jj undo` 退不回来。
  只读 git 命令可以用于排查。
- 本仓库约定 `main` bookmark 始终指向最新提交:提交后执行 `jj bookmark set main -r @-`。
- 提交信息:Conventional Commits + 中文简述,例如 `docs(readme): 简化安装说明`、`fix(detect): …`、
  `refactor(bundle): …`、`ci(release): …`。已用类型:feat / fix / refactor / docs / chore / ci / build / test。
- 未经用户明确要求不要 push;推送用 `jj git push --bookmark main`。
- `.gitignore` 由 jj/git 共用(没有 `.jjignore`);`lib/`、`node_modules/`、`scratch/`、`*.tgz`、lockfile 均已忽略。
- 发布:插件版本号只在 `package.json`。发版步骤(jj 0.46):
  1. `jj commit -m "chore(release): vX.Y.Z"`(或 `jj describe -m …` 后 `jj new`)提交版本号改动,再 `jj bookmark set main -r @-`;
  2. `jj tag set -r @- vX.Y.Z` 创建 tag,`jj tag list` 确认(移动已存在的 tag 需加 `--allow-move`);
  3. `jj git push --bookmark main` 推送提交,`jj git push --tag vX.Y.Z` 推送 tag(触发 `release.yml`);
  4. 观察 `release.yml`:校验 tag 与 `package.json` 版本一致 → 跑同一门禁 `npm test` → 显式 `npm run build` →
     npm OIDC 发布 → GitHub Release;失败可用 `workflow_dispatch` 传入同一 tag 重跑。
- 工具链 pin(Node 24、jj 0.46.0、typescript 6.0.3、`@types/node` 26.6.5)集中在 `.github/workflows/ci.yml`、
  `release.yml` 与本文件「环境与准备」,升级时三处同步修改;不要手改插件版本号以外的 workflow 版本。

## 提交前检查清单

- [ ] `npm test` 全绿
- [ ] `jj diff` 只含预期改动;没有把 `lib/`、`node_modules/` 或临时夹具带进来
- [ ] 用户可见变化已同步 `README.md`(功能/安装/工具表/配置表/已知限制)与对应 `locale/*.json`
- [ ] 没有新增运行时依赖、网络安装或 lockfile
- [ ] 没有绕过 guard、`jjNonInteractiveEnv` 或 runner 抽象
