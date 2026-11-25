# AGENTS.md

面向本仓库 AI 代理与开发者的开发说明。用户文档见 [README.md](./README.md)；内容以代码和 `vp run test` 为准。
本仓库自身是 **jj-colocated** 工作区，版本控制一律使用 jj。

## 项目速览

- `@aqian0/dsh-jj`：为 DeepSeek Harness 提供一等 Jujutsu (jj) 支持的插件包，纯 TypeScript + ESM，**零运行时依赖**。
- 四个 bundle 入口（顺序定义在 `cordis.patch.yml`）：
  - `dsh-jj`（`jj-runtime`）：`ctx.jj` 服务、仓库检测、会话上下文、心跳同步与只读面板 Host 路由；
  - `dsh-jj/tools`（`jj-tools`）：24 个 `jj_*` 模型工具；
  - `dsh-jj/guard`（`jj-guard`）：git/jj 命令混淆守卫；
  - `dsh-jj/changes`（`jj-changes`）：基于 jj 快照的变更卡片，禁用内置 Git-only `workspace-changes` 并在隔离 scope 复用其记录器。

## 环境与命令

- **工具链版本**：通过全局 `vp`（Vite+）统一管理环境与依赖（底层锁文件由 `packageManager: pnpm@12.16.1` 驱动）：Node.js 24.11+（CI 固定 Node 24）、`jj` 0.47.1 + `git`（均需在 `PATH`，测试使用真实仓库夹具）、`vite-plus@1.4.0`、`typescript@7.0.2`、`@types/node@26.6.5`。
- **测试专用 devDependency**：`@deepseek-ai/dsh-session-projection` 仅供 `test/guard-cwd.test.ts` 构造 `WorkingDirectoryService`，须与安装树中 `@deepseek-ai/dsh-working-directory` 的 exact peer 同步升级，更新后跑 `vp install` 刷新 `pnpm-lock.yaml`。
- **首次准备**：仓库根执行 `vp install`（`pnpm-lock.yaml` 已提交）；查询 DSH API 直接读本地 `node_modules/@deepseek-ai/*`。
- **构建/测试分工**：构建用 `tsc`（主包 `tsconfig.json` + 客户端 `tsconfig.client.json`），测试用 `node --test`（Node 原生类型擦除）；因此跑自定义脚本必须用 `vp run test` / `vp run build`（不要直接跑 `vp test` / `vp build`，它们是 Vite+ 内置的 Vitest/Vite 命令）。Oxfmt 与 Oxlint 配置见 `vite.config.ts`。

| 命令                                          | 作用                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `vp run test`                                 | 提交前完整门禁：`vp run check` → `vp run typecheck` → `vp run test:unit`         |
| `vp run build`                                | 编译 `src/` → `lib/`（含 `panel-client.js`，不入库）                             |
| `vp run typecheck`                            | `tsc -p tsconfig.test.json`（覆盖 `src/`、`test/`、`vite.config.ts`）            |
| `vp check --deny-warnings` / `vp check --fix` | Oxfmt + Oxlint 检查（警告即失败）/ 自动修复（对应 `vp run check` / `check:fix`） |
| `vp fmt` / `vp fmt --check`                   | Oxfmt 格式化 / 只检查                                                            |
| `vp run test:unit` / `test:coverage`          | 运行真实夹具单元测试 / 覆盖率报告                                                |

CI（`.github/workflows/ci.yml` / `release.yml`）均使用 `voidzero-dev/setup-vp`（固定 commit SHA）安装 `vp` 与 Node 24，执行 `vp install --frozen-lockfile` → `vp run test` → `vp pm pack --json -- --dry-run --ignore-scripts` 校验；`release.yml` 通过 npm OIDC 发布，并校验 jj 二进制 SHA-256。

## 仓库结构

| 路径                                                                       | 职责                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/index.ts`、`src/service.ts`、`src/jj-*.ts`                            | 运行时入口、`JjService` 缓存/生命周期、`JjOperations`、模板解析与子进程适配                         |
| `src/tools.ts`、`src/tool-*.ts`、`src/flows/cleanup.ts`                    | 24 个 `jj_*` 工具定义、共享 schema/文案、审批接线与 cleanup 流程                                    |
| `src/guard.ts`、`src/git-*.ts`、`src/jj-rules.ts`、`src/capabilities.ts`   | shell 分词/展开、git/jj 规则表、能力矩阵与同步守卫                                                  |
| `src/changes*.ts`                                                          | jj 快照读取、diff 解析、会话状态机、与内置 recorder 合并服务及入口装配                              |
| `src/detect.ts`、`src/config.ts`、`src/types.ts`                           | 仓库嗅探与 CLI 探测、联合/分片配置 schema 与归属校验、共享类型                                      |
| `src/policies.ts`、`src/session-heartbeat.ts`、`src/workspace-registry.ts` | 工作区所有权与持久化、cleanup/孤儿策略、沙箱分类与路径边界、跨进程心跳                              |
| `src/commit-style.ts`、`src/multi-session.ts`、`src/prompt-context.ts`     | 提交风格与修正折叠指引、多会话检测与收尾指引、会话 prompt 拼装                                      |
| `src/panel-host.ts`、`src/panel-client.ts`                                 | 只读 Web 面板 Host 路由与经典脚本客户端（独立 `tsconfig.client.json`）                              |
| `test/**/*.test.ts`、`test/helpers/`                                       | 按模块划分的单元测试与真实 jj/git 仓库夹具（`test/build.test.ts` 守卫打包、导出、纯模块与工具链）   |
| `cordis.patch.yml`、`**/locale/*.json`                                     | bundle patch（4 入口 + 禁用内置 `workspace-changes` + `agent-instructions`）与各入口 `en`/`zh` meta |

## 架构与核心约束

1. **入口契约**：四个入口各导出 `name` / `inject` / `apply` / `Config`。根入口 `src/index.ts` 只导出白名单（契约值、`JjService`、`assembleBaseLayer` 与少量类型），其余实现走公开子路径，`test/build.test.ts` 强校验。
2. **服务分层**：`index.ts` 提供 `ctx.jj`；tools/guard 通过 `inject: ['tools', 'jj' (, 'workingDirectory')]` 消费，changes 通过 `inject: ['subprocess', 'fs', 'jj']` 消费。勿随意改动 `inject`。
3. **纯模块边界**：`detect`、`git-*`、`jj-rules`、`types`、`commit-style`、`multi-session`、`jj-templates`、`policies`、`session-heartbeat`、`workspace-registry`、`capabilities`、`changes-types`/`paths`/`diff`/`jj`/`recorder`/`service` 禁止在运行时 import `@deepseek-ai/*`（允许 `import type`）。DSH 运行时 import 仅限 `config` / `jj-service` / `tool-definitions` / `jj-command` / `changes`（`build.test.ts` 拒绝静态、动态 `import()` 与 `require`）。
4. **子进程与非交互**：禁止直接 spawn；所有 jj/git 调用走注入的 `RunJj` / `RunCommand`，统一经 `jjNonInteractiveEnv` 设 `ui.color=never` 并屏蔽编辑器/交互提示。
5. **检测语义与拒绝文案**：`detectVcs` 始终返回 `VcsDescriptor`（问题经 `notices` + `verified: false` 上报，不抛业务异常）；CLI 权威为 `jj --ignore-working-copy workspace list`。模型可见拒绝文案集中在 `tool-shared.ts` / `guard.ts`，任何路径不得静默回退 git。
6. **同步 guard**：`ctx.tools.guard` 为同步接口，经 `tools/pre-execute` warm-up 预填缓存，失败一律 fail-open。默认策略 `warn`，hard-deny 不可通过配置放开。命令分类按 shell 语义递归展开常见 wrapper 与静态目录切换，无法解析时 fail-open 并一次性告警。
7. **配置唯一事实来源**：`src/config.ts` 的 `Config` 是键集合、类型与默认值的唯一声明；`ROW_CONFIG_KEYS` 是归属唯一来源（模块加载时校验完整覆盖）。四个入口均用 `configSchemaFor(owner)` + `assertScopedConfig(config, owner)` 在构造期拒绝放错行或未知的键（含显式写成默认值的键）。
8. **Bundle patch 与 peer 兼容**：`cordis.patch.yml` 非 `insert` 行整体替换目标 `config`，必须重述保留键；`disabled: true` 用于禁用内置 `workspace-changes`（上游缺失时只 warn，不阻断启动）。`@deepseek-ai/dsh-*` peer 必须写 caret 范围（`build.test.ts` 强校验），禁止精确钉版。
9. **多会话检测与心跳**：仅将正在执行回合的顶层会话（`agents.roots()` + `turnBoundary.openTurnStartSeq !== null`；子代理除外）视为并行，全程 fail-open。跨进程心跳写 `<jjRepoPath>/dsh-jj/sessions/*.json`（TTL 15 分钟，`turn/end` 置 `active: false`，离开仓库/销毁删除，`read-only` 禁止写或清理）；读取时用 `excludeSessionIds` 排除同进程所有已观测会话。隔离指引固定为先提交自身路径、再不带 `parents` 调 `jj_workspace_add`（优先 `/tmp/<repo>-<name>`），绝不推荐 `parents: ["@"]`。
10. **收尾自动化（`handoff` / `cleanup` / `restore`）**：
    - `JjOperations.handoff()` 统一编排 fetch → 目标解析 → `roots(::@ ~ ::target)` → `jj rebase -s` → base/冲突复核，并在外层包整流程 stale 自动恢复。
    - Rebase 前 fail-closed 校验：目标须与 `@` 共享非 root 基线、栈内无共享 bookmark、拒绝解析回 `@`、落后目标时不谎报成功；根 workspace 按 `.jj/repo` 目录布局判定并强制校验栈底 `firstChange`；`dryRun` 跳过 fetch 且不改写历史；冲突 bookmark 一律 `bookmarkSkipped`。
    - 跨 workspace 边界：用 `working_copies() & (<first>::)` 检测外来工作副本，活跃/脏/冲突拒绝，无主且空的 rebase 后自动 `update-stale`（结果 `foreignWorkingCopies`）。
    - `workspace_add` 记录持久化于 `<jjRepoPath>/dsh-jj/workspaces/`（按 session id 归属）。`cleanup` 只注销本会话创建或记录中的干净孤儿 workspace（不删目录），切回 default 前条件满足时把 default 空 `@` rebase 到栈顶；shell 侧越权 `jj workspace forget` 与任何 `jj workspace remove` 由 guard hard-deny。
    - `workspace_restore` 仅按记录的 `baseChangeId` 重建已注销且目录为空的 workspace。`workspaceAdd` 按 revision 校验禁止把 `@` 带入新链。
11. **变更卡片（`jj-changes`）**：`src/changes.ts` 通过 `ctx.isolate('workspaceChanges')` 隔离运行内置实现并在父 scope provide 合并服务（`workspaceChanges: off` 仍 provide 只读空服务，避免 deliverables 永久 pending）。每轮在 turn 边界快照 `@`，`readDiff` 传 `--ignore-working-copy`；解析 stderr 的 `Refused to snapshot some files:` 标为 `oversized`；`tools/pre-execute` 等 `settled()`、`agent/turn-stopping` 等 `stopping()`；任意失败 fail-open 退回内置结果。
12. **修正折叠（`jj_amend`）**：可改写窗口唯一判定在 `jj-templates.ts` 的 `isRewritableChange`（`!immutable && remoteBookmarks.length === 0`，过滤 `@git` 镜像）。`amend()` 与 `jj_squash` 执行前均校验 `into::@` / `((from)|(into))::@` 内无已发布提交，拒绝 merge/空源/冲突源，绝不传 `--ignore-immutable`。
13. **空提交防护**：执行前拒绝空 `@` 上的 `jj_commit`、`jj_new`（无显式 parents）及指向 `@` 的 `workspaceAdd` parent；`handoff` 对 rebase 后变空的提交仅在 `emptyChanges` 上报不自动删除；唯一自动 abandon 例外是 `cleanup` 后残留的空、无冲突、无后代、未发布工作副本。
14. **只读面板（`panel-host` / `panel-client`）**：
    - Host 侧全部读取传 `--ignore-working-copy`、`purgeExpired: false`，经 `isAllowedCwd` 限制会话目录及同仓库兄弟 workspace（越界 403），GET 走 5s 缓存与在飞去重，异常降级为带 `reason` 的 200 响应。
    - Client 侧为无打包器的经典 script（`tsconfig.client.json` + `moduleDetection: legacy`，不含运行时 `import`/`export`），整文件包进 IIFE 防止 HMR/升级重复注入重声明（`build.test.ts` 用 `node:vm` 连续执行两次验证），经 `window.__ModuleLoader__.load` 注册。UI 只用 DSH 设计令牌与 `jjPanel` locale，`tool.call.toolview` 键必须为 wire 工具名，所有注册与 JSON 解析失败均降级不抛出。
15. **工具契约与沙箱门禁**：
    - 每个工具输出带共享 `nextActions`（≤3 条真实 `jj_*` 工具，`args` 仅基本类型），不写散文版下一步；`jj_status` 默认不跑 `jj status`（`details: true` 才读 diff）；`jj_bookmark_list` 默认隐藏 `@git`。
    - `policies.ts` 的 `JJ_TOOL_SANDBOX_CLASSES` 覆盖全部 24 工具（`test/policies.test.ts` 校验不漂移），经 `tools/pre-execute` 审批瀑布流与 `withSandboxGate` 兜底去重对齐 `sandboxPolicy` / `approval`（缺审批服务 fail-closed）；路径边界向上 `realpathSync` 校验防符号链接逃逸；`read-only` 下只读与切换工具强制 `ignoreWorkingCopy: true`、`persist: false` 且跳过 `update-stale`。

## 代码约定与打包守卫

- TypeScript strict + `erasableSyntaxOnly` + `verbatimModuleSyntax`：禁用 `enum`/`namespace`/参数属性，类型导入用 `import type`，相对导入带 `.ts` 扩展名。
- 格式与 lint 统一由 `vite.config.ts` 管理（`printWidth: 120`、`singleQuote`、2 空格、LF）。改动后运行 `vp fmt` 与 `vp run test`，禁止用注释绕过 lint 告警。源码与测试注释用英文，用户文档用中文。
- 测试夹具用 `mktemp` 隔离并显式传 `cwd`，自检 jj root 指向夹具目录，避免误操作真实仓库。
- **新增公开子路径**时同步三处：`src/<name>.ts`、`package.json` 的 `exports`/`files` 与 `tsconfig.test.json` 的 `paths`（`./client` 为经典脚本不进 `paths`）；缺 `paths` 会在干净 checkout 的 typecheck 报 TS2307。
- **新增工具或配置键**时同步：`policies.ts`（沙箱分类）/ `config.ts`（`Config` + `ROW_CONFIG_KEYS`）→ 对应测试 → `README.md` 与 `locale/*.json`。

## 版本控制与发布

- 工作副本 `@` 即提交：`jj commit -m "…"`（或 `jj describe` + `jj new`），提交后执行 `jj bookmark set main -r @-`。**禁止 git 写操作**。
- 提交信息采用 Conventional Commits + 中文简述（类型：`feat` / `fix` / `refactor` / `docs` / `style` / `test` / `chore` / `ci` / `build`）。未获明确要求不要 push。
- `lib/`、`node_modules/`、`scratch/`、`*.tgz` 均已忽略；**`pnpm-lock.yaml` 必须提交**。
- 发版步骤：改 `package.json` 版本 → `jj commit -m "chore(release): vX.Y.Z"` → `jj bookmark set main -r @-` → `jj tag set -r @- vX.Y.Z` → `jj git push --bookmark main` 与 `jj git push --tag vX.Y.Z`（触发 `release.yml`）。

## 提交前检查

- [ ] `vp run test` 全绿（`vp check --deny-warnings` → `typecheck` → `test:unit`）
- [ ] `jj diff` 仅含预期改动，未混入构建产物或临时文件
- [ ] 用户可见变更已同步 `README.md` 与对应 `locale/*.json`
- [ ] 未新增运行时依赖，依赖变更已更新 `pnpm-lock.yaml`
