# AGENTS.md

面向在本仓库工作的 AI 代理(以及人类协作者)的开发说明。用户文档在 [README.md](./README.md);
本文件只讲环境、架构、约定、验证与提交流程。内容以代码和 `npm test` 为准,发现过期请直接修正。
本仓库自身是 **jj-colocated** 工作区,版本控制一律用 jj。

## 项目速览

- `@aqian0/dsh-jj`:为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供一等 Jujutsu (jj) 支持的插件包。
- 三个可独立加载的 bundle 入口(声明在 `cordis.patch.yml`,加载顺序即行的顺序):
  - `dsh-jj`(Cordis 名 `jj`):`ctx.jj` 服务、仓库检测、会话级「优先用 jj」与多会话/收尾 rebase 上下文;
  - `dsh-jj/tools`(`jj-tools`):15 个 `jj_*` 模型工具;
  - `dsh-jj/guard`(`jj-guard`):git/jj 命令混淆防护。
- 纯 TypeScript + ESM,**零运行时依赖**:DSH 包全部通过 `peerDependencies` 由宿主提供(版本见 `package.json`)。
- 没有任何构建工具链依赖:构建只用 `tsc`,测试只用 `node --test`。

## 环境与准备

- Node.js 24+:测试直接由 Node 内置类型擦除运行 `.ts`;CI 固定 Node 24。
- 真实 `jj`(CI 固定 0.46.0)和 `git` 必须在 `PATH`:测试用真实仓库夹具,不 mock 二进制行为。
- `tsc` 6.x(CI 固定 `typescript@6.0.3`、`@types/node@26.6.5`;仓库刻意不带 devDependencies)。
- 首次准备:`npm run setup`。它把 `node_modules/@deepseek-ai`、`node_modules/@types` 软链到本机 DSH 全局安装
  (默认 `/home/aqian/.cache/.bun/install/global/node_modules`,用 `DSH_NODE_MODULES` 覆盖)。只有 `tsc` 需要这些软链,
  `node --test` 不依赖它们。
- 全程离线:不要新增依赖、不要提交 lockfile、不要让测试访问网络。
- 查 DSH API:类型与实现位于全局安装的 `node_modules/@deepseek-ai/*`(`lib/` + `lib/types/*.d.ts`),
  与 `scripts/setup-links.ts` 默认指向同一位置。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 提交前必须全绿:setup-links → 构建(`tsc`)→ 测试类型检查 → `node --test` |
| `npm run build` | `tsc -p tsconfig.json`:`src/` → `lib/`(构建产物,不入库) |
| `npm run typecheck` | 对 `src/` + `test/` + `scripts/` 做类型检查(`tsconfig.test.json`,`noEmit`) |
| `npm run check` | 构建项目的 `noEmit` 检查 |
| `npm run test:unit` | 只跑测试;仍要求真实 jj/git,`build.test.ts` 会先构建 `lib/` |
| `npm run setup` | 重建离线 `node_modules` 软链 |

没有 lint / format 脚本,也没有 PR CI;唯一的 workflow 是打 tag 触发的发布流程(`.github/workflows/release.yml`)。

## 仓库布局

| 路径 | 内容 |
|---|---|
| `src/index.ts` | 运行时入口:`JjService` 注册 + 全局 prompt context;`assembleBaseLayer` 供测试 |
| `src/service.ts` | `JjOperations`(纯 jj 操作层,注入 runner)+ `JjService`(Cordis 服务、TTL 缓存/`peek`/`warm`/dispose) |
| `src/tools.ts` | `jj_*` 工具的 `defineTool` 定义、拒绝文案、`registerJjTools` 与工具入口 `apply` |
| `src/detect.ts` | 仓库识别:同步文件系统 sniff + CLI 权威探测 |
| `src/git-command.ts` | 纯函数、表驱动的 git/jj 命令分类(无 I/O、无 subprocess) |
| `src/guard.ts` | git 混淆 guard:warm-up 预计算 + 同步决策 + 文案 |
| `src/jj-command.ts` | jj/git 子进程适配、非交互 env、错误归类 |
| `src/config.ts` | schemastery `Config`、`JjPluginConfig`、`resolveConfig`、启动校验 |
| `src/commit-style.ts` | 提交描述风格策略(继承历史 / 询问用户 / 预设与自定义)与拆分提交指引(纯模块,无 I/O) |
| `src/types.ts` | 共享类型与词汇(纯声明) |
| `src/prompt-context.ts` | 会话开始时注入「优先用 jj」、提交描述/拆分提交与多会话/收尾 rebase 的模型可见上下文 |
| `src/multi-session.ts` | 多会话检测(同一 jj 仓库里的顶层会话、workspace 是否共享)与模型可见的 workspace 隔离 / 收尾 rebase 指引(纯模块,无 subprocess) |
| `test/**/*.test.ts` | `node:test` 测试;`test/helpers/` 是真实仓库夹具与 runner |
| `test/multi-session.test.ts` | 多会话检测模式与指引文案的单元测试 |
| `scripts/setup-links.ts` | 离线依赖软链脚本 |
| `locale/`、`tools/locale/`、`guard/locale/` | 三个入口各自的本地化 meta(`en.json` / `zh.json`) |
| `cordis.patch.yml` | bundle patch:三行 `insert` + `agent-instructions` 配置覆盖 |
| `lib/` | `tsc` 产物,被忽略、不提交;发布包由 `package.json.files` 决定 |

## 架构与硬性规则

1. **入口契约**:每个入口导出 `name` / `inject` / `apply` / `Config`;`build.test.ts` 会校验这些值与 `inject` 列表。
2. **分层**:`index.ts` 拥有 `ctx.jj`;tools/guard 通过 `inject: ['tools', 'jj'(, 'workingDirectory')]` 消费。
   删改 `inject` 会破坏其他行加载。
3. **纯模块**:`detect.ts`、`git-command.ts`、`types.ts`、`commit-style.ts`、`multi-session.ts` 不得在运行时 import 任何 `@deepseek-ai/*`
   (由 `build.test.ts` 强制)。DSH 运行时 import 仅限:`config.ts`(schemastery)、`service.ts`(cordis)、
   `tools.ts`(dsh-tools)、`jj-command.ts`(dsh-subprocess)。
4. **不直接 spawn**:所有 jj/git 调用都走注入的 `RunJj` / `RunCommand`(统一超时、宽限、输出截断、env 清洗)。
   这是可测试性的基础,也保证 guard/service 行为一致。
5. **检测语义**:`detectVcs` 永远返回 `VcsDescriptor`,仓库问题通过 `notices` + `verified === false` 上报,
   不抛业务异常;CLI 权威是 `jj --ignore-working-copy workspace list`,不是 `jj root`。
6. **guard 必须同步**:工具守卫是同步接口,子进程探测不能在其中发生,因此由 `tools/pre-execute` warm-up 预计算,
   `ctx.tools.guard` 只读缓存;任何环节失败都 fail-open(不阻塞调用)。默认策略是 `warn`(放行并给模型提示),
   `deny` 可通过配置开启;hard-deny(如 scope creep、越权 workspace 操作)不可通过配置放开。
7. **非交互**:jj 调用统一经 `jjNonInteractiveEnv` 等封装,设置 `ui.color=never` 并屏蔽编辑器/prompt
   (测试 V2/V4 覆盖)。新增 jj 命令不要绕过这层。
8. **拒绝文案**:「非 jj 仓库 / jj 缺失 / 元数据损坏」的模型可见文案集中在 `tools.ts` 的 `jjRefusalText`;
   guard 拒绝文案在 `guard.ts` 的 `build*` 函数。任何路径都不得静默回退到 git。
9. **配置一致**:`Config`(schemastery 默认值)、`JjPluginConfig`、`ResolvedJjConfig`、`resolveConfig`、
   `assertServiceableConfig` 必须保持同步。
10. **bundle patch 语义**:`cordis.patch.yml` 里非 `insert` 行会**整体替换**目标行 config:只写改动项会清掉其余键,
    必须重述所有要保留的键(如 `maxBytes: 65536`),并在 `build.test.ts` 里补对应断言。
11. **版本兼容**:DSH peer 依赖(`@deepseek-ai/dsh-*`)必须写成 caret 范围(如 `^0.2.1-rc.2`),
    不要钉死精确版本——宿主在安装和 profile 启动时用运行时版本(`dsh --version`)与该范围做 SemVer 匹配
    (预发布也参与),精确钉版会把本版适配版本之后的每个补丁版都判定为不兼容。`build.test.ts` 强制这一点。
12. **多会话检测 fail-open**:多会话指引只比较 `ctx.agents.roots()` 里的顶层会话(子代理不算并行会话)与
    `workingDirectory` 给出的会话目录,再用同步的 `peek` / sniff 解析 jj workspace 身份,不新增 DSH peer 依赖;
    agents / workingDirectory 缺失或抛错时按「没有其他会话」处理(`auto` 不注入),不得阻断 prompt 组装。

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

## 常见任务

**新增一个 `jj_*` 工具**

1. `service.ts` 的 `JjOperations` 加方法(复用 runner、超时/截断/非交互);
2. `tools.ts` 用 `defineTool` 定义:名称 `jj_*`、description 首句点明 this is jj / not git、参数 schema、
   输出 schema + `render`,非 jj 目录经 `requireWorkspace` / `jjRefusalText` 拒绝;
3. `test/service-tools.test.ts` 补定义、schema 校验、端到端与「只走 jj、不走 git」用例;
4. 同步 README「工具一览」,以及 `prompt-context.ts` 中的命令列表(如相关)。

**新增配置键**:`config.ts` 五处同步 → README「配置」表 → 按影响补 guard/detect/service 测试。

**修改提交描述策略**:`commit-style.ts` 纯函数(分类 / 检测 / 策略 / 文案)→ `config.ts` 五处同步 →
`prompt-context.ts` 与 `tools.ts`(`jj_commit_style`、`jj_commit`)注入 → `test/commit-style.test.ts` 与
`test/service-tools.test.ts`;默认保持 `auto`(继承历史、无法确定时询问用户),不要改成静默固定风格,
也不要让默认 `preferSplitCommits` 退化回「只改当前工作区」。提交策略以 `ctx.jj`(runtime 行)的配置为
唯一来源:`jj_commit_style` 读 `service.operations.config`,不要改回读 tools 行配置,否则 prompt 与工具
会给出互相矛盾的风格。

**修改 guard 行为**:`git-command.ts` 分类表(保持纯函数)→ `guard.ts` 文案与策略 → `test/guard*.test.ts`;
不要把默认从 `warn` 改成 `deny`,也不要放开 hard-deny。

**修改多会话并行 / 收尾 rebase 指引**

1. `multi-session.ts`:检测(`ctx.agents.roots()` 顶层会话 + workingDirectory,纯模块、fail-open)与模型可见文案
   (共用工作副本先隔离到仓库外的独立 workspace、同仓库不同 workspace 不要改写别人的提交、收尾标准 rebase 清单);
   整栈 rebase 必须用 `jj_rebase` 的 `source` 模式(或 `jj rebase -s`):jj 0.46 的默认 `revisions`/`-r` 只移动指定提交,
   不会带走后代,`service.ts` 的 `rebase()` 因此带 `mode` 参数(默认仍是 `revisions`);
   目标要带 preflight(`trunk()` 在没有远端时解析为 root,且本地 `main` 领先远端时不能 rebase 到 `trunk()`);
   **指引绝不能要求模型执行 `jj workspace forget`**:forget 当前 workspace 会成功但该目录不再有 working copy,
   forget 别的 workspace 被 guard hard-deny,清理只能交给用户(报告 `jj workspace list` 的名字/路径);
   并行会话一旦被检测到,收尾清单要在同一会话后续轮次继续注入(`parallelSeen` latch),子代理不注入;
2. `prompt-context.ts`:把这一段拼进 jj 会话上下文,受 `multiSessionGuidance` / `rebaseTarget` 控制;
3. `config.ts` 五处同步:`multiSessionGuidance`(`auto` / `always` / `off`,默认 `auto`)与 `rebaseTarget`
   (默认 `trunk()`,不得为空);
4. `index.ts`:在 `apply` 里把存活会话列表与 workingDirectory 接给指引;检测 fail-open,不可阻断启动;
5. 测试:`test/multi-session.test.ts` 覆盖检测/模式/文案,同步 `test/prompt-context.test.ts` 与
   `test/build.test.ts` 的纯模块列表;
6. 同步 README「使用 / 配置 / 已知限制」与 `locale/*.json` 的 meta.description;默认保持 `auto`
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
- 发布:版本号在 `package.json`,打 `vX.Y.Z` tag 触发 `release.yml`(校验 tag 与版本一致 → typecheck/build/test →
  npm OIDC 发布 → GitHub Release);不要手改 workflow 中的具体版本号。

## 提交前检查清单

- [ ] `npm test` 全绿
- [ ] `jj diff` 只含预期改动;没有把 `lib/`、`node_modules/` 或临时夹具带进来
- [ ] 用户可见变化已同步 `README.md`(功能/安装/工具表/配置表/已知限制)与对应 `locale/*.json`
- [ ] 没有新增运行时依赖、网络安装或 lockfile
- [ ] 没有绕过 guard、`jjNonInteractiveEnv` 或 runner 抽象
