# AGENTS.md

面向在本仓库工作的 AI 代理(以及人类协作者)的开发说明。用户文档在 [README.md](./README.md);
本文件只讲环境、架构、约定、验证与提交流程。内容以代码和 `pnpm test` 为准,发现过期请直接修正。
本仓库自身是 **jj-colocated** 工作区,版本控制一律用 jj。

## 项目速览

- `@aqian0/dsh-jj`:为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供一等 Jujutsu (jj) 支持的插件包。
- 四个可独立加载的 bundle 入口(声明在 `cordis.patch.yml`,加载顺序即行的顺序):
  - `dsh-jj`(Cordis 名 `jj`):`ctx.jj` 服务、仓库检测、会话级「优先用 jj」与多会话/收尾 rebase 上下文;
  - `dsh-jj/tools`(`jj-tools`):23 个 `jj_*` 模型工具;
  - `dsh-jj/guard`(`jj-guard`):git/jj 命令混淆防护;
  - `dsh-jj/changes`(`jj-changes`):用 jj 工作副本快照实现每轮「已编辑 N 个文件」变更卡片,并通过 bundle patch
    禁用 DSH 内置的 Git-only `workspace-changes` 行、在隔离 service scope 里复用它的记录器。
- 纯 TypeScript + ESM,**零运行时依赖**:DSH 包全部通过 `peerDependencies` 由宿主提供(版本见 `package.json`);
  `@deepseek-ai/dsh-workspace-changes` 是 changes 行的运行期 peer(宿主 deliverables bundle 提供)。
- 开发工具链只在 `devDependencies` 里(`vite-plus` / `typescript` / `@types/node` + 测试专用的
  `@deepseek-ai/dsh-session-projection`);构建仍只用 `tsc`,测试仍只用 `node --test`。

## 环境与准备

- Node.js 24.11+:`vite-plus@1.4.0` 的 engines 要求;测试直接由 Node 内置类型擦除运行 `.ts`;CI 固定 Node 24。
- pnpm 12.16.1:`package.json` 的 `packageManager` 固定该版本,`pnpm-lock.yaml` 已提交,是工具链与公开 peer
  依赖的唯一解析来源。
- 首次准备:仓库根执行 `pnpm install`(仅首次需要网络,之后离线)。pnpm 会按 `peerDependencies` 自动安装公开的
  DSH 包——所有依赖(含 `tsc`)都从本地 `node_modules` 解析,不需要手工 `npm install` 或单独安装编译器。
- 真实 `jj`(CI 固定 0.47.1)和 `git` 必须在 `PATH`:测试用真实仓库夹具,不 mock 二进制行为。
- `devDependencies` 只放工具链:`vite-plus@1.4.0`(提供 `vp` CLI / Oxfmt / Oxlint)、`typescript@7.0.2`
  (原生编译器:`tsc` 来自按平台解析的 optionalDependency `@typescript/typescript-<platform>`,lockfile 记录
  全部平台、安装只取当前平台;经典 JS API 已移除,本仓库只用 `tsc` CLI)、`@types/node@26.6.5`,以及测试专用的
  `@deepseek-ai/dsh-session-projection`(只有 `test/guard-cwd.test.ts`
  用它构建真实的 `WorkingDirectoryService` 栈;本插件不是它的 peer)。该测试依赖必须与安装树里
  `@deepseek-ai/dsh-working-directory` 声明的 exact peer 保持一致:上游 `0.2.1-rcN` 升级时同步改这个
  devDependency,再重跑 `pnpm install` 更新 lockfile,并确认 `pnpm peers check` 没有新告警。
- 依赖变更保持克制:运行时依赖仍为零,不新增运行时依赖;lockfile 随任何依赖变更一起提交,测试不得访问网络。
  `@deepseek-ai/dsh-workspace-changes` 与其它 DSH peer 一样用 caret 范围(宿主按运行时版本匹配),它只被
  `src/changes.ts` 以 `import()` 动态引用,headless profile 没有该包时 changes 行降级为一条 warning,不阻断启动。
- 查 DSH API:类型与实现位于本仓库 `node_modules/@deepseek-ai/*`(`lib/` + `lib/types/*.d.ts`),由 `pnpm install`
  解析到本地;桌面版 app bundle 内的副本不直接可读。

## 常用命令

| 命令                                        | 作用                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                 | 提交前必须全绿:`pnpm run check`(`vp check --deny-warnings`:Oxfmt + Oxlint)→ `pnpm run typecheck` → `pnpm run test:unit`(`build.test.ts` 负责构建 `lib/`) |
| `pnpm run build`                            | `tsc -p tsconfig.json`:`src/` → `lib/`(构建产物,不入库)                                                                                                  |
| `pnpm run typecheck`                        | 对 `src/` + `test/` + `vite.config.ts` 做类型检查(`tsconfig.test.json`,`noEmit`)                                                                         |
| `pnpm run check`                            | 静态门禁:`vp check --deny-warnings`(Oxfmt 格式检查 + Oxlint,警告也失败)                                                                                  |
| `pnpm run check:fix`                        | 同 `check`,并自动修复能修的格式/lint 问题                                                                                                                |
| `pnpm run lint` / `pnpm run lint:fix`       | 只跑 Oxlint / 自动修复                                                                                                                                   |
| `pnpm run format` / `pnpm run format:check` | 用 Oxfmt 格式化 / 只检查(提交前跑 `format`)                                                                                                              |
| `pnpm run test:unit`                        | 只跑测试(`node --test`);仍要求真实 jj/git,`build.test.ts` 会先构建 `lib/`                                                                                |
| `pnpm run test:coverage`                    | 用 Node 内置覆盖率跑全部测试(`--test-coverage-include='src/**/*.ts'`,排除 `lib/`);当前 line ≈96%                                                         |
| `pnpm run prepack`                          | 由 `pnpm pack` / `npm publish` 自动触发的发布前构建(即 `pnpm run build`)                                                                                 |

测试仍是 `node --test`、构建仍是 `tsc`:测试需要真实 jj/git 仓库夹具与 Node 的类型擦除,包本身零运行时依赖,
产物就是 `tsc` 的 `lib/`,因此刻意不启用 `vp test`(Vitest)与 `vp build`(tsdown);`vite.config.ts` 只配置
`fmt` / `lint` 两件事。

push / PR CI(`.github/workflows/ci.yml`)先用 `pnpm/action-setup`(固定 commit SHA)安装 `packageManager` 指定的
pnpm,`setup-node` 开启 pnpm 缓存,`pnpm install --frozen-lockfile` 后跑 `pnpm test`,再用
`pnpm pack --dry-run --ignore-scripts --json` 做发布 tarball 的 smoke check。
`release.yml` 在发布前复用同一门禁,再显式 `pnpm run build`、用同一 `pnpm pack` 命令校验发布内容,最后用
npm 可信发布(GitHub OIDC)发布,并用 `npm view` 判断该版本是否已发布。
`npm` 只出现在发布链路,本地一切命令都用 pnpm / `vp`。两个 workflow 的 jj 安装会校验资产 SHA-256,actions
固定到 commit SHA(注释写明来源与升级方式)。锁文件固定上游解析结果;升级上游时同步 `devDependencies` 里的
`@deepseek-ai/dsh-session-projection` 并重跑 `pnpm install`(更新 lockfile),确认 `pnpm peers check` 无新告警。

## 仓库布局

| 路径                                                           | 内容                                                                                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                 | 运行时入口:`JjService` 注册 + 全局 prompt context;`assembleBaseLayer` 供测试                                                                                                            |
| `src/service.ts`                                               | `JjOperations`(一次一个 jj 子命令 + handoff 流程,注入 runner);barrel re-export `jj-templates` / `jj-service`                                                                            |
| `src/jj-templates.ts`                                          | 纯模块:jj 模板常量、change 记录类型与 JSON 解析(无 I/O、无 subprocess)                                                                                                                  |
| `src/jj-service.ts`                                            | `JjService`:Cordis 服务、TTL 缓存/`peek`/`warm`/dispose、lifetime 信号合并                                                                                                              |
| `src/tools.ts`                                                 | barrel re-export `tool-schemas` / `tool-shared` / `tool-definitions` / `tool-entry`                                                                                                     |
| `src/tool-schemas.ts`                                          | 共享输出 schema 与 change view(纯数据/视图)                                                                                                                                             |
| `src/tool-shared.ts`                                           | 拒绝文案、workspace 工具函数与 `ToolContext` / `JjToolService` 类型                                                                                                                     |
| `src/tool-definitions.ts`                                      | `jjToolDefinitions` 与 23 个 `defineTool`(含 session workspace 所有权)                                                                                                                  |
| `src/tool-entry.ts`                                            | `registerJjTools` / `apply` / `name` / `inject` 与 `cwdFor`                                                                                                                             |
| `src/detect.ts`                                                | 仓库识别:同步文件系统 sniff + CLI 权威探测                                                                                                                                              |
| `src/policies.ts`                                              | 纯模块:工作区所有权注册表、根 workspace 判定、cleanup 决策、stale 错误识别;工具/flow/guard 共用同一份规则                                                                               |
| `src/session-heartbeat.ts`                                     | 纯模块:跨进程会话心跳（`<jjRepoPath>/dsh-jj/sessions/*.json`），多会话检测在 `auto` 模式下的第二个来源                                                                                  |
| `src/flows/cleanup.ts`                                         | 具名流程:离开并注销本会话创建的 workspace（所有权、stale 恢复、切换目录与 forget 的顺序都在这一个地方）                                                                                 |
| `src/capabilities.ts`                                          | 纯模块:jj 子命令 → 处置（tool / shell / blocked）的能力矩阵；`test/capabilities.test.ts` 断言覆盖 guard 表与已注册工具                                                                  |
| `src/git-command.ts`                                           | barrel re-export `git-tokenize` / `git-equivalence` / `git-rules` / `jj-rules`                                                                                                          |
| `src/git-tokenize.ts`                                          | shell 分词/运算符/重定向/heredoc/命令替换扫描(纯函数)                                                                                                                                   |
| `src/git-equivalence.ts`                                       | git 安全分类与等价命令表类型/规则(纯数据)                                                                                                                                               |
| `src/git-rules.ts`                                             | git 子命令规则表与 `classifyGitInvocation`(纯函数)                                                                                                                                      |
| `src/jj-rules.ts`                                              | jj 子命令 scope 表与 `classifyJjInvocation`(纯函数)                                                                                                                                     |
| `src/guard.ts`                                                 | git 混淆 guard:warm-up 预计算 + 同步决策 + 文案                                                                                                                                         |
| `src/jj-command.ts`                                            | jj/git 子进程适配、非交互 env、错误归类                                                                                                                                                 |
| `src/config.ts`                                                | schemastery `Config`、`JjPluginConfig`、`resolveConfig`、启动校验                                                                                                                       |
| `src/commit-style.ts`                                          | 提交描述风格策略(继承历史 / 询问用户 / 预设与自定义)、拆分提交与修正折叠指引(纯模块,无 I/O)                                                                                             |
| `src/types.ts`                                                 | 共享类型与词汇(纯声明)                                                                                                                                                                  |
| `src/prompt-context.ts`                                        | 会话开始时注入「优先用 jj」、提交描述/拆分提交/修正折叠与多会话/收尾 rebase 的模型可见上下文                                                                                            |
| `src/multi-session.ts`                                         | 多会话检测(同一 jj 仓库里的顶层会话、workspace 是否共享)与模型可见的 workspace 隔离 / 收尾 rebase 指引(纯模块,无 subprocess)                                                            |
| `test/**/*.test.ts`                                            | `node:test` 测试;`test/helpers/` 是真实仓库夹具与 runner                                                                                                                                |
| `test/multi-session.test.ts`                                   | 多会话检测模式与指引文案的单元测试                                                                                                                                                      |
| `test/service.test.ts`                                         | `JjService` 的 TTL 缓存 / warm / peek / dispose 生命周期测试                                                                                                                            |
| `test/changes-diff.test.ts`                                    | `changes-diff` 解析单元测试(literal jj 输出 + 真实夹具 + 拒绝快照警告解析)                                                                                                              |
| `test/changes-jj.test.ts`                                      | `changes-jj` 读取器测试(真实 jj-native/colocated 夹具 + fake runner 失败形态)                                                                                                           |
| `test/changes-recorder.test.ts`                                | `changes-recorder` 状态机测试(fake reader:轮次、失败、上限、binary、oversized、拒绝快照的新文件、forget/dispose)                                                                        |
| `test/changes-service.test.ts`                                 | `changes-service` 合并/路由测试(fake recorder + upstream)                                                                                                                               |
| `test/changes-entry.test.ts`                                   | `jj-changes` 入口端到端测试(真实 Cordis + 真实 jj/git 夹具:jj-native 卡片、colocated 合并、纯 Git 回退、三种模式)                                                                       |
| `test/jj-command.test.ts`                                      | 子进程适配层(fake `ctx.subprocess`:超时/取消/截断/错误归类)测试                                                                                                                         |
| `vite.config.ts`                                               | Vite+ 工具链配置:Oxfmt(`printWidth: 120` / `singleQuote`)与 Oxlint(`unicorn` / `typescript` / `oxc` / `import`),格式与 lint 规则的唯一来源                                              |
| `pnpm-workspace.yaml`                                          | 单包 pnpm 设置:把 `vite` 别名到 `vite-plus` 自带 core、把 `vitest` 钉到自带运行器,并放行对应 peer 版本(别名版本与 `vite-plus` devDependency 同步,`build.test.ts` 会校验)                |
| `pnpm-lock.yaml`                                               | 提交的锁文件:工具链与公开 peer 依赖的唯一解析来源,由 `pnpm install` 生成/更新                                                                                                           |
| `.github/workflows/`                                           | CI:`ci.yml`(push / PR:`pnpm install --frozen-lockfile` + `pnpm test` + `pnpm pack` smoke check)、`release.yml`(tag 触发:同一门禁 + `pnpm run build` + `pnpm pack` 校验后 npm OIDC 发布) |
| `locale/`、`tools/locale/`、`guard/locale/`、`changes/locale/` | 四个入口各自的本地化 meta(`en.json` / `zh.json`)                                                                                                                                        |
| `cordis.patch.yml`                                             | bundle patch:四行 `insert`、禁用内置 `workspace-changes` 的 `disabled: true` 行、`agent-instructions` 配置覆盖                                                                          |
| `lib/`                                                         | `tsc` 产物,被忽略、不提交;发布包由 `package.json.files` 决定                                                                                                                            |

## 架构与硬性规则

1. **入口契约**:每个入口导出 `name` / `inject` / `apply` / `Config`;`build.test.ts` 会校验这些值与 `inject` 列表。
   根入口(`src/index.ts`)**只**导出这四个契约值、`JjService`、`assembleBaseLayer` 与少量公共类型;其它组件的
   实现一律走子路径(`./service`、`./jj-command`、`./tools`、`./guard`、`./changes`、`./detect`、
   `./git-command`、`./commit-style`、`./multi-session`、`./prompt-context`)。`build.test.ts` 断言根导出集合
   恰好是白名单,防止运行时入口重新变成所有组件的门面。
2. **分层**:`index.ts` 拥有 `ctx.jj`;tools/guard 通过 `inject: ['tools', 'jj'(, 'workingDirectory')]` 消费,
   changes 通过 `inject: ['subprocess', 'fs', 'jj']` 消费(runtime 行提供 jj 命令名与进程限额,也保证 bundle 行
   顺序)。删改 `inject` 会破坏其他行加载。
3. **纯模块**:`detect.ts`、`git-command.ts`(barrel)、`git-tokenize.ts`、`git-equivalence.ts`、
   `git-rules.ts`、`jj-rules.ts`、`types.ts`、`commit-style.ts`、`multi-session.ts`、`jj-templates.ts`、`policies.ts`、
   `session-heartbeat.ts`、`changes-types.ts`、`changes-paths.ts`、`changes-diff.ts`、`changes-jj.ts`、`changes-recorder.ts`、
   `changes-service.ts` 不得在运行时 import 任何 `@deepseek-ai/*`(由 `build.test.ts` 强制;类型导入可以)。
   DSH 运行时 import 仅限:`config.ts`(schemastery)、`jj-service.ts`(cordis)、`tool-definitions.ts`
   (dsh-tools)、`jj-command.ts`(dsh-subprocess)、`changes.ts`(schemastery + 动态 `import()` 内置
   `@deepseek-ai/dsh-workspace-changes`;cordis 只做类型导入)。`build.test.ts` 会拒绝静态、副作用、动态
   `import()` 与 `require` 四种形态中的任何一种。
4. **不直接 spawn**:所有 jj/git 调用都走注入的 `RunJj` / `RunCommand`(统一超时、宽限、输出截断、env 清洗)。
   这是可测试性的基础,也保证 guard/service 行为一致。
5. **检测语义**:`detectVcs` 永远返回 `VcsDescriptor`,仓库问题通过 `notices` + `verified === false` 上报,
   不抛业务异常;CLI 权威是 `jj --ignore-working-copy workspace list`,不是 `jj root`。
6. **guard 必须同步**:工具守卫是同步接口,子进程探测不能在其中发生,因此由 `tools/pre-execute` warm-up 预计算,
   `ctx.tools.guard` 只读缓存;任何环节失败都 fail-open(不阻塞调用)。默认策略是 `warn`(放行并给模型提示),
   `deny` 可通过配置开启;hard-deny(如 scope creep、越权 workspace 操作)不可通过配置放开。命令分类必须按
   shell 语义解析而不是只看 `argv[0]`:jj 的 `-R/--repository` 是 clap `global = true` 选项(可写在 subcommand
   之后),shell wrapper(`bash -c`、`command`/`env`/`nohup`/`timeout`/`sudo` 等前缀、`VAR=` 赋值、`exec -a`、
   `env -S`、`bash -c --`)要递归展开(深度上限 6),可静态解析的目录切换(`cd -P/--`、`pushd`、git 累积 `-C`)
   要跟随;无法安全解析时 fail-open 但必须一次性告警,不得静默丢弃整条命令。jj 的 canonical 拼写
   (`jj operation restore` 等)与 alias 同表;mutating git 的 `--dry-run`/`-n` 语义按各 subcommand 区分
   (`git fetch -n` 是 `--no-tags`,不是 dry-run)。
7. **非交互**:jj 调用统一经 `jjNonInteractiveEnv` 等封装,设置 `ui.color=never` 并屏蔽编辑器/prompt
   (测试 V2/V4 覆盖)。新增 jj 命令不要绕过这层。
8. **拒绝文案**:「非 jj 仓库 / jj 缺失 / 元数据损坏」的模型可见文案集中在 `tool-shared.ts` 的 `jjRefusalText`;
   guard 拒绝文案在 `guard.ts` 的 `build*` 函数。任何路径都不得静默回退到 git。
9. **配置一致**:`src/config.ts` 的 `Config` 是默认值与键集合的唯一来源;`ResolvedJjConfig` /
   `JjPluginConfig` 由 schemastery `Schemastery.TypeT` / `Partial<...>` 派生,`resolveConfig` 用 `Config({})`
   的默认值 + 调用方覆盖,`assertServiceableConfig` 只做构造期业务校验——新增键只需改 `Config` 一处。
   **归属表 `ROW_CONFIG_KEYS` 是唯一事实来源**:每个入口行用 `configSchemaFor(owner)` 得到只含自己键的
   scoped schema(行级 `Config` 就是它),`CONFIG_OWNERSHIP` / `CONFIG_SHARED_OWNERSHIP` / `configKeyOwners` /
   README 表格都由它派生;模块加载时校验「schema 每个键恰好有一个归属行」,漏登记直接抛错。
   四个入口 `apply` 都在构造期调用 `assertScopedConfig(config, owner)`:**放错行**或**拼错/未知**的键会被
   直接拒绝并说明它属于哪一行(不再只 `warn`、不再静默忽略)。scoped schema 只为本行键填默认值,因此
   「显式写成默认值的键」也能识别(旧的 `undefined`/默认值启发式已删除)。
   `jj-changes` 行的键(workspaceChanges 模式与变更卡片上限)同样在 `Config` 里,归属 `changes`;新增这类键
   改 `Config` + `ROW_CONFIG_KEYS` + README「配置」的 changes 小节。
10. **bundle patch 语义**:`cordis.patch.yml` 里非 `insert` 行会**整体替换**目标行 config:只写改动项会清掉其余键,
    必须重述所有要保留的键(如 `maxBytes: 65536`),并在 `build.test.ts` 里补对应断言。非 `insert` 行也可以用
    `disabled: true` 按 id 禁用**其它 bundle 的**行——changes 行就是这样禁用 Web app 的 Git-only
    `workspace-changes` 行(`build.test.ts` 断言该行存在且被禁用);未来上游若删掉该行,禁用 patch 只 warn,
    `src/changes.ts` 发现已有 provider 时也只 warn 不顶替,profile 仍能启动。
11. **版本兼容**:DSH peer 依赖(`@deepseek-ai/dsh-*`)必须写成 caret 范围(如 `^0.2.1-rc.2`),
    不要钉死精确版本——宿主在安装和 profile 启动时用运行时版本(`dsh --version`)与该范围做 SemVer 匹配
    (预发布也参与),精确钉版会把本版适配版本之后的每个补丁版都判定为不兼容。`build.test.ts` 强制这一点。
12. **多会话检测 fail-open**:多会话指引只比较 `ctx.agents.roots()` 里的顶层会话(子代理不算并行会话)与
    `workingDirectory` 给出的会话目录,再用同步的 `peek` / sniff 解析 jj workspace 身份,不新增 DSH peer 依赖;
    **跨进程**:每个会话在组装提示词时把心跳写到 `<jjRepoPath>/dsh-jj/sessions/<id>.json`
    (`session-heartbeat.ts`,TTL 15 分钟、fail-open、损坏即忽略),`liveRootSessions(cwd, session)` 把同仓库心跳并进
    对端列表并按会话 id 排除自己;跨机器或心跳不可用时仍需 `multiSessionGuidance: always`。
    **存活不等于并发**:宿主在回合结束后仍保留 Agent,所以对端只有在 `sessionProjections.stateOf(session,
    'turnBoundary').openTurnStartSeq !== null`(正在执行回合)时才可能算并行;已知空闲(`active: false`)的对端
    必须被 `parallelPeerCwds` 过滤掉,否则单会话也会被误判而新建 jj workspace。活动状态服务 / 投影缺失或抛错时
    该对端按「可能存在并行」的保守行为处理(fail-open),agents / workingDirectory 缺失或抛错时按「没有其他会话」
    处理(`auto` 不注入),任何一条路径都不得阻断 prompt 组装。
    隔离建议固定为「先只提交自己的路径、再**不带 `parents`** 调用 `jj_workspace_add`」:不带 parents 时 jj 以
    当前 `@` 的父提交为起点,正好带上刚提交的那一步;传 `parents: ["@"]` 会把空的工作副本提交变成新 workspace
    提交链里的空提交、最终进入收尾/推送历史。不要在指引或工具描述里重新推荐 `parents ["@"]`。
13. **收尾自动化(`jj_handoff` / `jj_workspace_cleanup`)**:
    - `service.ts` 的 `handoff()` 是收尾的唯一入口:fetch(无远端不算错)→ 目标解析(显式 `destination` →
      配置 `rebaseTarget` → `trunk()` → 本地 `main` → `master`,跳过 root commit;显式目标解析到 root 是
      模型错误,必须报错而不是静默换目标;全失败才报「问用户」)→ `roots(::@ ~ ::target)` 探测整段栈 →
      `jj rebase -s` → 复核 base 并返回冲突数据。不要把这些步骤拆回 prompt;`needsCommit` 时先让模型
      `jj_commit`,不要代为描述。
    - rebase 后要检查 `stack` 里残留的空 change(`empty && !currentWorkingCopy`):`handoffNextSteps` 的 `nextSteps`
      必须列出它们的 change id 与处理建议,但不自动 abandon(可能是别的 workspace 的空工作副本);本会话自己的、
      rebase 后才变空的已描述 change 才提示用 `jj_abandon` 丢弃。
    - **stale 恢复必须包住整个流程**:stale 时连目标/栈的 `jj log` 读取都会失败,所以 `handoff()` 用
      「`handoffFlow()` 抛 stale → `jj workspace update-stale` → 重跑一次 `handoffFlow()`」实现;不要只在
      rebase 调用外加 retry,也不要把 stale 读取错误吞成「找不到目标」。
    - `firstChange` 必须是本 workspace 在目标之上那段栈的**栈底**(在 `roots(::@ ~ ::target)` 里):传 `@`
      或中间 change 会只移动一部分却返回 `rebased/onTarget` 成功,必须报错并给出候选。根(default)workspace
      的判定用**布局**而不是名字(`<root>/.jj/repo` 是目录 ⇒ 根 workspace,linked workspace 是 pointer 文件),
      这样 `jj workspace rename` 之后仍然要求 `firstChange`。
    - 目标解析/失败信息必须自带下一步(本地 bookmark 列表、`firstChange` 候选),不要返回裸 jj revset 错误;
      已集成路径同样要处理请求的 bookmark(移动或 `bookmarkSkipped`),不能静默丢弃。
    - **handoff 的安全不变量**(rebase 前 fail-closed 校验,失败即 `JJ_BAD_INPUT`、绝不执行 rebase):
      destination 必须覆盖本 workspace 的基线(`(::@ & ::target) ~ root()` 非空)——只共享 empty root 的
      无关 revision 会被拒绝,显式 `firstChange` 也不能绕过;`first::@` 与 `::bookmarks()` 的交集必须为空
      (唯一例外是本次 `bookmark` 参数请求移动、且它指向栈底之上的 bookmark),避免把共享 trunk 历史卷进
      source rebase;destination 解析回 `@` 本身直接拒绝。`roots(::@ ~ ::target)` 为空时是 workspace **落后**
      于 destination,返回 `rebased:false, alreadyIntegrated:false, onTarget:false`(不 rebase、不谎报成功)。
      bookmark 已存在时只有指向被 rebase 的栈内才移动,否则 `bookmarkSkipped`;冲突 bookmark(`conflicted`,
      `json(self).target` 是 `[add, remove, add…]` 合并形式,缺席的一侧是 `null`)一律 `bookmarkSkipped`,不替人选边,
      `bookmarkList` 的 `target` 取第一个存在的 add 侧,绝不能把 `null` 变成字面 revset `"null"`;bookmark 名在 rebase 前校验,
      rebase 后的 bookmark 失败收敛为 `bookmarkSkipped`(保留已成功的 rebase 结果)。
    - `jj_workspace_cleanup` 的前提是**本会话所有权**:只有通过 `jj_workspace_add` 工具创建(记在
      `ctx.jj` 的 `WorkspaceOwnership` 注册表:按 `exec.agent` 记录**名字+规范路径**,不随工具定义生灭)、
      当前 workspace 不是 `default`、working copy 无未提交改动/冲突的 workspace 才能注销;注销前必须先
      `workingDirectory.set` 把会话切回默认 workspace。目录文件永不删除。判定与编排在 `policies.ts` 的
      `decideWorkspaceCleanup` 与 `flows/cleanup.ts`:读取工作副本遇到 stale 会先 `update-stale` 再重试,
      不再因为一次快照失败就放弃清理。
      这是对旧「清理只能交给用户」规则的**唯一例外**,shell 里的 `jj workspace forget <other>` 仍由 guard 拒绝
      (`buildJjWorkspaceForgetRefusal`;jj 接受多个名字,`targetWorkspaces` 里任一不是当前 workspace 即拒绝)。
      `jj workspace remove` 会把 workspace(stale 的也一样)连目录一起删除、被忽略文件无法恢复,
      `jj-rules.ts` 把它归为 `destructive`,任何目标、任何 `guardJjRepositoryWide` 模式都由
      `buildJjWorkspaceRemoveRefusal` hard-deny。注销后还要用 `changeExists()` 检查被遗忘 workspace 的空工作副本
      是否仍可见(jj 只在「空 + 无描述 + 无后代」时才丢弃它),保留时在结果 `message` 里说明它仍在共享历史、可能
      显示为空提交;`workspaceForget` 对 stale 的默认 workspace(兄弟 workspace 的 handoff 改写了它检出的 change)
      必须 `update-stale` 后重试一次,清理不得因此失败。
    - `JjOperations.workspaceAdd` 必须显式传 `--name`(缺省名用 `basename`)并按名字/规范路径解析返回的
      workspace,不要用 `workspaces[last]` 猜:否则在 macOS symlink 路径下会把别的 workspace 记成本会话所有。
      `workspace list` 模板对 `name`/`root` 都用 `json(...)`(名字可含空格/制表符);比较名字时用解码后的裸名。
    - `workspaceAdd` 的 parents 必须**按 revision 解析**而不是按字符串匹配:`(parent) & @` 非空即表示该 parent
      指向当前工作副本——`@` 为空时丢弃这个 parent 并在结果 `note` 里说明,`@` 有未提交内容或多 parent 混用时
      抛 `JJ_BAD_INPUT`,绝不把工作副本提交塞进新 workspace 的链(从 `jj_status` 复制 change id 也不能绕过)。
    - 其它收尾输入的不变量:`jj new` 的位置参数前必须加 `--`;`describeChange` 只接受唯一 revision
      (0 个/多个都报错,绝不批量改描述);`jj op log` 的 `time` 取 `json(self).time.start`(jj 的
      `time` 是 `{start,end}` 对象),不是 `String(object)`;`Cannot access` 只有指向 `.jj`/`.git` 元数据时
      才归为 `JJ_REPO_BROKEN`。
    - 变更这套行为必须同步 `test/service-tools.test.ts`(handoff / cleanup 端到端,含 stale、firstChange
      校验、ambiguous roots、无关 destination、behind、bookmark 所有权、cleanup 所有权、cleanup stale 恢复与保留
      提示、handoff 空 change 上报)、
      `test/multi-session.test.ts`(收尾清单文案)、`test/guard.test.ts`(forget / remove 拒绝文案)与 README「任务收尾」。
14. **变更记录(`jj-changes` / 变更卡片)**:
    - bundle patch 禁用内置 `workspace-changes` 行并插入 `jj-changes`;`src/changes.ts` 的 `apply` 先
      `ctx.isolate('workspaceChanges')` 在隔离 scope 里跑内置 `apply`(拿到只读的 builtin service),再在父
      scope `ctx.provide('workspaceChanges', 合并服务)`。不要改成两个 provider 同时 provide(同一 scope 重复会抛错
      并可能拖垮 profile),也不要直接改内置包的内部状态。
    - 记录路径固定为「turn 开始读 `@` commit id(允许 jj 快照)→ turn 结束再读一次 → `jj diff --from A --to B`
      解析」。turn 结束的 `readCommit` 必须在 `readDiff` 之前;`--ignore-working-copy` 只用于 `readDiff`。
    - `readCommit` 同时解析快照命令 stderr 里的 `Refused to snapshot some files:` 警告:超过
      `snapshot.max-new-file-size`(默认 1 MiB)的新文件不会被快照进 `@`,commit id 也可能不变。轮结束时新出现的
      拒绝路径要以 `oversized: true`(0 行数、无对比内容)并入摘要,轮开始就已被拒绝的路径必须排除,「只有超大
      文件」的回合也要记录。解析在 `changes-diff.ts`(纯函数),`changes-jj.ts` 按命令 cwd 把路径解析为绝对路径。
    - 一切失败 fail-open:reader 返回 `undefined`、recorder 不写事件、合并服务退回内置 summary,任何路径都不得
      抛进宿主或阻断 turn。合并按绝对路径去重、jj 数据优先,`total` 在超出两边 `maxFiles` 时是近似值(已在
      `changes-service.ts` JSDoc 说明)。
    - 顶层会话才记录(与内置 recorder 一致);cwd 取 `working-directory/change` 事件维护的有效目录,而不是
      `session.header.cwd`;`agent/turn-stopping` 必须 `await recorder.stopping(...)`(否则 `turn/end` 先提交,
      卡片数据晚到)。`turn/start` 的基线快照是异步的:必须在 `tools/pre-execute` 里先
      `await recorder.settled(session.id)` 再放行工具写入,否则慢快照会把本轮第一个改动吞进 baseline(与内置
      recorder 的 `settled()` 语义对齐)。
    - 合并视图对**任一** recorder 的 `workspace/changes` seq 都要生效:Host 的 deliverables 只保留一轮中最后
      一个事件的 seq(真实顺序是内置先 append、jj 后 append),所以 own seq 命中时也必须合并 newest upstream,
      不能短路返回 jj-only;summary 与 diff 必须共用同一次合并解析,保证文件顺序/索引一致。
    - `workspaceChanges: off` 关闭 jj 记录与卡片数据,但仍 `provide` 一个只读空服务(`summary`/`diff` 均返回
      `undefined`),否则 deliverables 行(其 `inject` 含 `workspaceChanges`)会永久 pending,连带丢失
      `/api/present.*`、`/api/changes.*` 路由与文件引用提示词;已有其它 provider 时仍只 warn、不顶替。
    - 测试:`test/changes-diff.test.ts`(解析)、`test/changes-jj.test.ts`(真实 jj 读取)、
      `test/changes-recorder.test.ts`(状态机)、`test/changes-service.test.ts`(合并/路由)与
      `test/changes-entry.test.ts`(真实 Cordis 端到端:jj-native、colocated 合并、纯 Git 回退、三种模式)。
    - 修改 changes 的 `Config` 键、行名或 bundle 插入位置时,同步 `test/build.test.ts`(
      四个 entry、`REQUIRED_EXPORTS`、patch 断言)、`package.json` 的 `exports`/`files`、`changes/locale/*.json`
      与 README「变更卡片」「配置」。

15. **修正折叠(`jj_amend` / 修正窗口)**:
    - 窗口判定只有一处:`jj-templates.ts` 的 `isRewritableChange` = `!immutable && remoteBookmarks.length === 0`。
      只看 `immutable()` 不够——jj 默认 `immutable_heads()` 不覆盖已推送的 tracked bookmark,改写它会让本地与远端
      分叉;只看 remote bookmark 也不够(trunk / tag 可能没有 remote bookmark)。模板里的 `remote_bookmarks` 必须
      过滤 `@git`(colocated 仓库的本地镜像),否则任何带本地 bookmark 的提交都会被误判为已发布。
    - `JjOperations.amend()` 是唯一的折叠入口:先解析目标/源各为唯一 revision、目标必须是源的祖先,再检查改写范围
      `into::@`(**不是** `into::from`——`jj squash --into` 会把后代一直 rebase 到工作副本)内没有已发布提交,最后
      拒绝 merge 目标、空源与冲突源。任何校验失败都是 `JJ_BAD_INPUT`,执行前绝不落一次 squash。目标描述默认用
      `--use-destination-message` 保留(永不打开编辑器),需要时用 `message` 改写;stale 时 `updateStale()` 后重跑一次
      (与 handoff 相同),不要只在外层重试。
    - `jj_amend` 工具只做参数映射与 `nextStep` 文案;`jj_commit` 的输出必须带 `commitCorrectionHint`,把规则放在
      「刚提交完」这个决策点上。`jj_squash` 执行前同样校验发布边界 `((from)|(into))::@`(与 amend 一致),
      并把 jj 的 immutable 拒绝映射成 `JJ_BAD_INPUT`——两条改写路径的安全等级不允许不同。
    - 指引在 `commit-style.ts` 的 `CORRECTION_GUIDANCE`(与 `SPLIT_COMMITS_GUIDANCE` 分开),受 `preferAmendCorrections`
      (默认 true,runtime 行)控制;`false` 只关指引,不禁用工具。默认不要改成「所有后续改动都追加提交」或
      「自动改写」——修正只由用户指令触发。
    - 测试在 `test/service-tools.test.ts`(工作区/已提交修正、`paths`、`message`、trunk 与 tracked bookmark 两种
      发布边界、非祖先/merge/空源/冲突源、`jj_amend` 输出 schema 自校验)、`test/commit-style.test.ts`、
      `test/prompt-context.test.ts` 与 `test/config.test.ts`;改窗口判定或文案时同步 README「修正近期提交」「工具一览」
      与 `locale/*.json`、`tools/locale/*.json`。
16. **空提交防护(多会话/多工作区收尾的单链空提交)**:
    - 单链里的空提交有两个插件侧来源:把当前 `@` 当作新 workspace 的 parent(见规则 12/13),以及在空 `@` 上
      `jj_commit` / `jj_new`。两处都必须在**执行前**防护,不能事后补警告或自动 undo(撤销是破坏性改写)。
    - `JjOperations.commit()` 先用 `readAt(cwd)` 读取 `@`:空且非 conflict 时抛 `JJ_BAD_INPUT`(冲突的空合并
      change 保持原路径,它需要先解决冲突);`paths` 一个都没匹配上时 jj 仍会创建空提交,只能在成功结果里返回
      警告并提示用 `jj_abandon` 清理(现有测试锁定 warning-only 形状)。`newChange()` 在无 parents 且 `@` 已空时同样
      拒绝;显式 parents 的 `jj_new` 保持可用(用于在别的 revision 上开栈)。
    - `jj_handoff` 对 rebase 后才变空的 change 只报告不自动删除(见规则 13);清理由模型调用 `jj_abandon`
      (显式 revset、拒绝 `@` 与已发布提交),插件绝不自动 abandon,也不改写他人提交。
    - 修改这些守卫/文案时同步 `test/service-tools.test.ts`(commit/new 空提交拒绝、workspaceAdd parent
      丢弃/拒绝、handoff 空 change 上报、cleanup stale 恢复与保留提示)、`test/multi-session.test.ts`(隔离与
      收尾文案、prompt token 预算)与 README「多会话协作」「任务收尾」「已知限制」。

## 代码约定

- 任何改动都必须让 `pnpm test` 全绿(`vp check --deny-warnings` → `tsc` 类型检查 → `node --test`);改行为先补测试。
- TypeScript strict,`noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax` / `isolatedModules` /
  **`erasableSyntaxOnly`** 全开:不要用 `enum`、`namespace`、构造函数参数属性等不可擦除语法;类型导入用 `import type`。
- 相对导入带 `.ts` 扩展名(`rewriteRelativeImportExtensions` 在构建时改写为 `.js`)。
- 格式与 lint 由 Vite+ 统一,`vite.config.ts` 是唯一配置:Oxfmt(`printWidth: 120`、`singleQuote`、分号;缩进/换行
  由 `.editorconfig` 决定:2 空格、LF、结尾换行)与 Oxlint(默认 correctness 规则 + `unicorn` / `typescript` /
  `oxc` / `import` 插件)。不要手工对齐、排序或逐行修补格式——改完运行 `pnpm run format`(只检查用
  `pnpm run format:check`),提交前跑 `pnpm run lint`。门禁 `vp check --deny-warnings` 会把 lint warning 也当
  失败,不要用注释静默关规则来绕过门禁。模块头用 JSDoc `@module`,导出的 API 写 JSDoc。
  源码与测试注释用英文,README 等用户文档用中文。
- 源码注释中的 `design contract §…` 指历史设计文档(不在本仓库):以现有实现和测试对齐,不要臆造契约条款。
- 测试:`node:test` + `node:assert/strict`,一个测试文件对应一个模块;夹具用 `mktemp` 隔离、显式 `cwd`、
  并自检 jj root 指向夹具目录(防止在真实仓库里建/改夹具——曾发生过共享 workspace 被误操作的事故);
  不要 mock 仓库行为;改行为先补测试。
- `test/build.test.ts` 额外守护:产物清单从 `src/*.ts` 推导(含 `lib/types/*.d.ts`)、`package.json` 的
  `main`/`types`/`exports`/`files` 目标必须存在且**每个静态 exports 目标都被 `files` 覆盖**(tarball 不再包含
  无法从 `node_modules` 加载的 `src/**/*.ts`)、四个入口各自的 locale 与 `<entry>/icon` 导出、四个 entry 的
  `name`/`inject`/`Config` 形状、bundle patch 里四行入口各自只出现一次且「禁用内置 `workspace-changes`」只有
  一处、没有 `disabled: false` 重新启用行、纯模块的 DSH 运行时 import(静态/副作用/dynamic `import()`/`require`
  全部拒绝)、手写 `.ts` 禁止 tab/行尾空白/CRLF(>120 列仅提示),以及 pnpm + Vite+ 工具链接线(`packageManager`、
  `devDependencies`、`vp` 脚本、`pnpm-lock.yaml` / `pnpm-workspace.yaml` / `vite.config.ts` 存在,`vite` 别名
  版本与 `vite-plus` 一致)。新增源模块或改打包/工具链配置时先让这些断言通过。

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
会给出互相矛盾的风格。修正折叠与描述风格是两条独立策略:指引在 `CORRECTION_GUIDANCE`、`commitCorrectionHint`
与 `preferAmendCorrections`,动作为 `JjOperations.amend()` 与 `jj_amend`,窗口判定在 `isRewritableChange`;
改其中任何一处都要同时看本文件规则 15 的测试清单。

**修改 guard 行为**:命令分类表在 `git-rules.ts` / `jj-rules.ts`(解析原语在 `git-tokenize.ts`,均保持纯函数)→
`guard.ts` 文案与策略 → `test/guard*.test.ts` 与 `test/git-command.test.ts`;
不要把默认从 `warn` 改成 `deny`,也不要放开 hard-deny。

**修改多会话并行 / 收尾 rebase 指引**

1. `multi-session.ts`:检测(`ctx.agents.roots()` 顶层会话 + `turnBoundary` 活动状态 + workingDirectory,纯模块、fail-open)与模型可见文案
   (共用工作副本先隔离到仓库外的独立 workspace、同仓库不同 workspace 不要改写别人的提交、收尾清单);
   收尾清单现在要求模型**调用一次 `jj_handoff`**,而不是手工串 `jj git fetch` / 选目标 / `jj_rebase` / 复核;
   目标解析、source 模式整栈 rebase、stale 恢复、冲突上报都在 `service.ts` 的 `handoff()` 里实现
   (jj 的默认 `revisions`/`-r` 只移动指定提交,不会带走后代,所以整栈必须 `-s`);
   **shell 里的 `jj workspace forget` 仍不可要求模型执行**:只有 `jj_workspace_cleanup` 工具可以注销
   本会话通过 `jj_workspace_add` 创建的临时 workspace,其它情况清理交给用户(报告 `jj workspace list` 的名字/路径);
   并行会话一旦被检测到,收尾清单要在同一会话后续轮次继续注入(`parallelSeen` latch),子代理不注入;
   隔离段必须写成「先提交自己的路径,再**不带 parents** 调用 `jj_workspace_add`」,并解释 `parents ["@"]` 会把
   空工作副本提交带进新链;`jj_workspace_add` 的 parent 守卫与 `jj_commit` / `jj_new` 空提交守卫见规则 13/16;
2. `prompt-context.ts`:把这一段拼进 jj 会话上下文,受 `multiSessionGuidance` / `rebaseTarget` 控制;
3. `config.ts` 的 `Config` schema:`multiSessionGuidance`(`auto` / `always` / `off`,默认 `auto`)与 `rebaseTarget`
   (默认 `trunk()`,不得为空);
4. `index.ts`:在 `apply` 里把存活会话列表(含 `sessionProjections` 的 `turnBoundary` 活动状态)与 workingDirectory
   接给指引;已知空闲的对端必须在 `parallelPeerCwds` 里被过滤,检测 fail-open,不可阻断启动;
5. `service.ts` / `tools.ts`:收尾自动化(`handoff()`、`jj_handoff`、`jj_workspace_cleanup`)与
   guard 的 `jj workspace forget <other>` / `jj workspace remove` 拒绝文案(`buildJjWorkspaceForgetRefusal` /
   `buildJjWorkspaceRemoveRefusal`)要保持一致;
6. 测试:`test/multi-session.test.ts` 覆盖检测/模式/文案,`test/service-tools.test.ts` 覆盖 handoff / cleanup
   端到端(含 no-remote、already-integrated、needsCommit、conflicts、bookmark、默认 workspace 的 `firstChange`
   约束、cleanup 所有权与回退),同步 `test/prompt-context.test.ts`、`test/guard.test.ts` 与
   `test/build.test.ts` 的纯模块列表;
7. 同步 README「使用 / 配置 / 工具一览 / 已知限制」与 `locale/*.json` 的 meta.description;默认保持 `auto`
   (跨进程需用户显式配置 `always`),不要让多会话检测变成隐式依赖。

**修改变更记录 / 变更卡片(`jj-changes`)**

1. 数据链路:`changes-jj.ts`(注入 `RunJj` 读 commit id 与 diff)→ `changes-diff.ts`(纯解析)→
   `changes-recorder.ts`(每会话串行状态机,写 `workspace/changes` 事件)→ `changes-service.ts`(与内置
   recorder 的摘要按绝对路径合并/路由)→ `changes.ts`(Cordis 装配、隔离内置 provider、事件分发、合并服务)。
2. 保持 fail-open:reader/recorder 的失败都要吞掉并 warn,不得让宿主看到未处理的 rejection;新增 jj 命令必须走
   `createRunJj` 注入的 runner 和 `--ignore-working-copy` 约定(只有 turn 边界快照除外)。
3. 改展示语义时同步 `changes-paths.ts`(与内置 recorder 的 path/display 规则一致)和 README「变更卡片」。
4. 测试与断言见上一层规则 14;`test/changes-entry.test.ts` 是唯一的真实 Cordis 端到端证据(用进程内 fake
   subprocess service,不新增测试依赖)。

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
- `.gitignore` 由 jj/git 共用(没有 `.jjignore`);`lib/`、`node_modules/`、`scratch/`、`*.tgz`、`package-lock.json`、
  `yarn.lock`、`.npmrc` 均已忽略。**`pnpm-lock.yaml` 必须提交**,依赖变更时一起更新。
- 发布:插件版本号只在 `package.json`。发版步骤(jj 0.47):
  1. `jj commit -m "chore(release): vX.Y.Z"`(或 `jj describe -m …` 后 `jj new`)提交版本号改动,再 `jj bookmark set main -r @-`;
  2. `jj tag set -r @- vX.Y.Z` 创建 tag,`jj tag list` 确认(移动已存在的 tag 需加 `--allow-move`);
  3. `jj git push --bookmark main` 推送提交,`jj git push --tag vX.Y.Z` 推送 tag(触发 `release.yml`);
  4. 观察 `release.yml`:校验 tag 与 `package.json` 版本一致 → 跑同一门禁 `pnpm test` → 显式 `pnpm run build` →
     `pnpm pack --dry-run --ignore-scripts --json` 校验发布内容 → npm OIDC 发布 → GitHub Release;
     失败可用 `workflow_dispatch` 传入同一 tag 重跑。
- 工具链 pin 集中在 `package.json`(`packageManager: pnpm@12.16.1` 与 `devDependencies`)、`pnpm-lock.yaml`、
  `.github/workflows/ci.yml` / `release.yml` 与本文件「环境与准备」:Node 24(CI;`vite-plus` 要求 24.11+)、
  jj 0.47.1、`vite-plus` 1.4.0、`typescript` 7.0.2、`@types/node` 26.6.5;测试专用的
  `@deepseek-ai/dsh-session-projection` 跟随安装树里 `dsh-working-directory` 的 exact peer。升级时同步修改,
  lockfile 用 `pnpm install` 重算;不要手改插件版本号以外的 workflow 版本。

## 提交前检查清单

- [ ] `pnpm test` 全绿(`vp check --deny-warnings` → `tsc` 类型检查 → `node --test`)
- [ ] 改动已格式化:`pnpm run format` 后再用 `pnpm run format:check` 复核;没有手写对齐或排序
- [ ] `jj diff` 只含预期改动;没有把 `lib/`、`node_modules/` 或临时夹具带进来;`pnpm-lock.yaml` 的改动与依赖变更对应
- [ ] 用户可见变化已同步 `README.md`(功能/安装/工具表/配置表/已知限制)与对应 `locale/*.json`
- [ ] 没有新增运行时依赖,`devDependencies` 只放工具链;依赖变更已更新 `pnpm-lock.yaml`
- [ ] 没有绕过 guard、`jjNonInteractiveEnv` 或 runner 抽象
