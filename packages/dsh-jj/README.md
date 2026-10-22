# dsh-jj — DeepSeek Harness 的一等 Jujutsu (jj) 支持(基础层)

本包把 jj 当作**一等版本控制语义**接入 DSH:先做**仓库判别**(`git` / `jj-colocated` / `jj-native` / 不可用),
再做**防 git 混淆 guard**(jj 工作区里优先 jj:默认放行 mutating git 并把 jj 等价命令提示写进工具结果,可配置为拒绝),
并对 **jj 侧仓库级操作**(`jj undo` / `jj op restore` 等)给出作用域提示。工具层(`jj_*` 工具、`ctx.jj` 服务)
在后续步骤接入同一插件。

> 本包**不是** git 命令的别名封装:guard 的拒绝文案一律给出 jj 原生命令(revset、change id、bookmark、
> operation log、workspace),工具层的命令也全部走 jj。

## 策略:一等公民 = 优先 jj,而不是屏蔽 git

当 `.jj` 与 `.git` **同时存在**(colocated)时,dsh-jj 的做法是**优先 jj、保留 git**:

- jj 原生工具(`jj_*`)与服务(`ctx.jj`)是首选路径;工具描述明确写 "This is jj, not git"。
- **会话起始就把偏好写进模型上下文**(`preferJjContext: true`,默认):注册一个全局
  `systemPrompt.context`,其文本提供者读取 `AssembleContext.agent` 并解析该 agent 的当前目录——
  与 DSH 自带的 `dsh-working-directory` 同一模式,因此**对任何 provider / 任何模型 / 子代理都生效**,
  不依赖某个模型是否读了工具描述。非 jj 仓库时该上下文为空串(不占位)。
- mutating git **默认不被拦截**(`guardMutatingGit: warn`):命令照常执行,但 guard 会把一条
  「本仓库优先用 jj;等价命令是 `jj describe`/`jj new`…;git 写入不会进入 jj 的 operation log」
  的提示**追加到该次工具结果**里(`tools/post-execute`),让模型从结果中学会偏好。
- 需要严格拦截时把 `guardMutatingGit` 设为 `deny`;完全不想被打扰设为 `off`。
- 唯一默认拒绝的两类:①`create_worktree` 在 jj 工作区(它产出的 checkout jj 根本看不见);
  ②jj 侧**不可逆**操作(`jj restore` 无 pathspec、`jj abandon @`、`jj undo --allow-cross-workspace`)。

---

## 1. 目录结构

```
packages/dsh-jj/
├── package.json          # 裸包名 dsh-jj;exports: "." / "./tools" / "./guard" / "./detect" / "./git-command"
├── tsconfig.json         # outDir lib/, declarationDir lib/types/ (权威声明在 lib/types/**)
├── cordis.patch.yml      # 三条 bundle 行:jj-runtime / jj-tools / jj-guard
├── scripts/setup-links.mjs  # 离线依赖 symlink(不联网安装)
├── src/
│   ├── config.ts         # schemastery Config + 默认值 + 构造期校验
│   ├── types.ts          # VcsKind / VcsDescriptor / VcsNotice / RunCommand / DetectDeps ...
│   ├── detect.ts         # sniffVcsSync + detectVcs + TPL_WORKSPACE_LIST
│   ├── git-command.ts    # classifyGitInvocation / gitEquivalence / classifyJjInvocation
│   ├── guard.ts          # evaluateGitCommand + installGitConfusionGuard + guard 入口
│   ├── index.ts          # runtime 入口(jj 服务层占位 + guard 装配)
│   └── tools.ts          # tools 入口(13 个 jj_* 工具的装配位置)
├── lib/                  # tsc 产物(lib/*.js + lib/types/*.d.ts)
└── test/                 # node:test 用例(真实 jj/git 进程 + 临时目录夹具)
```

## 2. 环境前提

| 组件 | 本工作区实测版本 |
|---|---|
| jj | 0.46.0 |
| git | 2.56.0 |
| node | v24.22.1(用内置 TypeScript 类型擦除直接跑 `src/*.ts`) |
| tsc | /usr/bin/tsc(TypeScript 6.0.3) |

**离线依赖(禁止联网安装)**:构建期需要 `@deepseek-ai/*` 与 `@types/node` 可解析。
在包内建立指向全局安装的 symlink:

```bash
cd packages/dsh-jj
node scripts/setup-links.mjs
# 等价手工命令(脚本执行的就是这两条,幂等):
#   ln -sfn /home/aqian/.cache/.bun/install/global/node_modules/@deepseek-ai node_modules/@deepseek-ai
#   ln -sfn /home/aqian/.cache/.bun/install/global/node_modules/@types        node_modules/@types
```

其它 DSH 安装位置:`DSH_NODE_MODULES=/path/to/node_modules node scripts/setup-links.mjs`。

## 3. 构建

```bash
cd packages/dsh-jj
tsc -p tsconfig.json          # 产出 lib/*.js 与 lib/types/*.d.ts,无 TS 错误
node -e "import('dsh-jj').then(m => console.log(m.name, m.inject, typeof m.apply))"
```

`lib/types/**` 是权威类型声明(`package.json` 的 `exports.*.types` 指向它)。

## 4. 测试(单一命令)

```bash
cd packages/dsh-jj
node scripts/setup-links.mjs && tsc -p tsconfig.json && node --test "test/**/*.test.js"
# 实测:224 tests / 224 pass / 0 fail(含 4 类仓库、guard、服务/操作层、13 工具 schema 与 argv 断言)
```

`npm test` 与上面等价(见 `package.json` scripts)。测试**不需要**先构建也能跑:
`test/*.test.js` 通过 Node 内置类型擦除直接 import `src/*.ts`,而所有 DSH import 都是 `import type`(运行时被擦除),
所以懒人入口 `node --test "test/**/*.test.js"` 也可以单独使用。

> **Node 24 陷阱(实测)**:`node --test test/`(目录参数)在 Node v24.22.1 上会被当成模块路径而失败
> (`Cannot find module '.../test'`)。请使用 glob(`node --test "test/**/*.test.js"`)或在包目录下用
> 无参 `node --test` 自动发现。契约 §4.2 里写的 `node --test test/` 在这个 Node 版本上不可用。

测试夹具规则(2026-10-22 共享工作区事故后的硬性要求):

1. 所有仓库夹具都用 `mkdtemp` 建在 `/tmp` 下,**绝不**在 `/home/aqian/dsh-jj`(colocated 仓库根)执行 mutating jj/git;
2. 每个夹具创建后自检 `jj root` / `git rev-parse --show-toplevel` 必须等于夹具目录,否则抛错(见 `test/helpers/fixtures.js`);
3. 破坏性命令一律用 `cwd`/`-R` 指定夹具,不依赖进程 cwd。

## 5. 四个入口(bundle 行)

| specifier | 文件 | `name` | `inject` | 职责 |
|---|---|---|---|---|
| `dsh-jj` | `lib/index.js` | `jj` | `['subprocess','workingDirectory']` | runtime 入口;当前装配 guard,服务层随后接入 |
| `dsh-jj/tools` | `lib/tools.js` | `jj-tools` | `['tools']` | 13 个 `jj_*` 工具的装配位置(工具层接入时 inject 增加 `'jj'`) |
| `dsh-jj/guard` | `lib/guard.js` | `jj-guard` | `['tools']` | 防混淆 guard + `create_worktree` 保护 |
| `dsh-jj/detect`, `dsh-jj/git-command` | 纯函数子入口 | — | — | 供其它插件/测试直接引用检测与分类 |

三个入口都导出**同一个** schemastery `Config`,profile 里的非法配置会在 `apply` 前被 loader 拒绝。

安装路径(隔离 `DSH_HOME`,不触碰用户 profile):

```bash
mkdir -p $DSH_HOME/profiles/<name>/node_modules
ln -sfn <DSH install>/node_modules/@deepseek-ai $DSH_HOME/profiles/<name>/node_modules/@deepseek-ai
ln -sfn /home/aqian/dsh-jj/packages/dsh-jj       $DSH_HOME/profiles/<name>/node_modules/dsh-jj
cp packages/dsh-jj/cordis.patch.yml              $DSH_HOME/profiles/<name>/cordis.patch.yml
DSH_HOME=$DSH_HOME dsh --profile <name> --dump-config   # 三条行可解析
```

本仓库的实测证据:`scratch/implementer/evidence/boot-check.txt`(真实 `dsh --profile jj-e2e --dump-config` 输出含三条行、
`web --help` exit 0)、`scratch/implementer/dsh-home/`(隔离 profile)。

## 6. 配置键(`Config`,全部可选)

| 键 | 默认 | 语义 |
|---|---|---|
| `jjCommand` / `gitCommand` | `jj` / `git` | 可执行名;`gitCommand` 只用于 git 探测与提示,不用于 jj 操作 |
| `timeoutMs` / `graceMs` | 30000 / 3000 | 子进程超时与终止宽限 |
| `maxOutputBytes` | 262144 | 单流输出上限 |
| `detectCacheTtlMs` | 10000 | 检测缓存 TTL(guard 的同步 cache 依据) |
| `guardMutatingGit` | `warn`(v3 策略) | jj 工作区内 mutating git 的处置:`warn` 放行 + 把「优先用 jj」提示**追加到工具结果**(模型可见) / `deny` 拒绝 / `off` 不干预 |
| `preferJjContext` | `true` | 会话起始把「这是 jj 仓库,优先用 jj」作为**模型可见上下文**注入(每个 agent 生效;非 jj 仓库注入空串) |
| `guardGitInJjNative` | `warn`(v3 策略) | **仅 jj-native** 内 git 的处置:`warn` 放行 + 一次性 notice / `deny` 拒绝 / `off` 忽略 |
| `guardJjRepositoryWide` | `warn` | jj 侧仓库级操作(`jj undo`/`jj op restore`/`jj redo`/`jj op revert`/`jj abandon <rev>`/`jj edit <rev>`/`jj new <rev>`/`jj workspace forget <自己>`)的处置;**默认放行**(它是首选恢复路径)+ `jj/repo-wide-op` 事件与一次性 notice(含 head op id 与回滚命令) |
| (硬拒绝,不可配置) | — | `jj restore`(无 pathspec)、`jj abandon @`、`jj undo --allow-cross-workspace`、`jj -R <祖先/外部仓库>`、`jj workspace forget <他人>` 一律拒绝 |
| `guardTools` | `['bash','pwsh','terminal_send']` | guard 检查的工具名 |
| `guardCreateWorktree` | `true` | 在 jj 仓库拒绝 `create_worktree` |
| `readOnlyGitNotice` | `true` | colocated 只读 git 的一次性 notice |
| `defaultLogLimit` / `maxLogLimit` | 30 / 200 | 日志工具参数(工具层) |
| `defaultCwd` | `''`(空 ⇒ `process.cwd()`) | 无 `workdir`/无 `workingDirectory` 时的回退 cwd |

## 7. 仓库判别(检测算法)

优先级:**文件嗅探(同步、无副作用)→ jj CLI 权威确认 → git 探测**。

- 嗅探向上遍历,记录**最近 `.jj` 目录**(普通文件 `.jj` 不算,F3)与**最近 `.git`**(目录或文件)的**深度**;
  **更近者胜**:git 仓库嵌在 jj 工作区内 ⇒ `kind='git'` + notice `jj-ancestor-shadowed`(F6);
  jj 工作区嵌在 git 仓库内 ⇒ jj 优先(F5)。
- 权威确认用 `jj --ignore-working-copy --no-pager --color=never workspace list -T <TPL_WORKSPACE_LIST>`,**不用 `jj root`**:
  空的 `.jj` 目录会让 `jj root` exit 0 误报,而 `workspace list` exit 255(F2);`.jj/repo` 断链 ⇒ exit 1 + `Cannot access`。
- 只读 jj 命令默认会**快照工作副本**,所以检测/peek 路径一律带 `--ignore-working-copy`。
- git 探测单独进行,尊重 `GIT_CEILING_DIRECTORIES`;jj-native 工作区上方的 git 仓库不会被当作本目录的仓库
  (`gitCeilingApplied=true`),并给 notice `jj-native-under-git-parent`(F13)。
- session cwd 就是工作区根时给 notice `jj-shared-workspace`(F14,事故场景)。

真实证据(四个种类 + 两个嵌套场景,真实 jj/git 输出):
`scratch/implementer/evidence/repo-kinds.txt`(由 `scratch/implementer/evidence/repo-kinds-evidence.mjs` 生成)。

```
jj-colocated  verified=true  confidence=high   colocated (jj git init --colocate)
jj-native     verified=true  confidence=high   jj-native (jj git init --no-colocate)
git           verified=true  confidence=high   plain git (git init)
none          verified=true  confidence=high   none (empty directory)
jj-native     verified=true  confidence=high   jj-native inside parent git repo   (gitCeilingApplied=true)
git           verified=true  confidence=high   nested git repo inside a jj workspace
```

> **注意**:jj 0.46 的 `git.colocate` 默认为 `true` —— `jj git init` 得到的是 **colocated** 仓库;
> 造 jj-native 夹具必须 `jj git init --no-colocate`。

## 8. 防混淆 guard

`ctx.tools.guard(...)` 是**同步**的,检测是异步的,所以分两段(契约 §8.1):

- **预热段**(可选):宿主提供 `on('tools/pre-execute')` 且传入 `service`/`warm` 时,先 `await warm(cwd)` 并把决策缓存到
  `Map<callId, reason>`;DSH 保证 pre-execute 跑完才评估 guard,因此不会"首次调用漏判"。
- **决策段**:`check(execution)` 取缓存,否则退回**同步文件嗅探**(独立可用;预热抛错时 fail-open,永不阻断调用)。

决策矩阵要点:

| 条件 | 动作 |
|---|---|
| mutating git + `kind=jj-*` | `guardMutatingGit`:**`warn` 默认**——命令照常执行,同时在 `tools/post-execute` 把 jj 优先提示追加到结果(模型可见)/`deny` 拒绝(文案含 jj 等价命令)/`off` 不干预 |
| git + `kind=jj-native` | `guardGitInJjNative`:`warn`(默认)放行 + 一次性 notice / `deny` 拒绝 / `off` 忽略 |
| 只读 git + `kind=jj-colocated` | 放行;`readOnlyGitNotice` 时发一次性 notice |
| `safety==='unknown'` 或无子命令 | **放行**(不得误判为 mutating) |
| `kind=git` / `none` / F6 遮蔽 | 不干预 |
| `create_worktree` + `kind=jj-*` | `guardCreateWorktree` 拒绝,指向 `jj workspace add`(含 4 条实测事实) |
| `jj undo` / `jj op restore` / `jj redo` / `jj abandon` / `jj op revert` | `guardJjRepositoryWide`:`warn`(默认)放行 + `jj/repo-wide-op` 事件 + 一次性 notice / `deny` 拒绝(文案含 `--at-op` 与 `jj_undo` 工具)/`off` 忽略 |
| `jj workspace forget <他人 workspace>` | **始终拒绝** |
| `jj -R <祖先/外部仓库> …`(scope creep) | **始终拒绝** |

拒绝文案示例(真实输出):

```
Blocked: `git commit` in a Jujutsu (jj) workspace (jj-colocated: /tmp/.../colo).
This is a colocated repository: git and jj share one working copy, but only jj knows the real change graph. ...
Use the jj equivalent instead:
  jj commit -m "…"      (or: jj describe -m "…" then jj new)
Read-only git commands are still allowed for inspection (for example `git log`, `git diff`, `git show`, `git rev-parse`).
If raw git is genuinely required here, your user can set the dsh-jj setting guardMutatingGit to "warn" or "off".
```

git 子命令分类表是**表驱动**的(`GIT_SUBCOMMAND_RULES`):`read`(放行)/`mutate`(拒绝)/`unknown`(放行);
`contextual` 子命令(`branch`/`tag`/`config`/`remote`/`stash`/`worktree`/`reflog`/`symbolic-ref`/`bisect`/`notes`/`add`/`apply`/`push`/`fetch`/`bundle`/`hash-object`/`submodule`)按 flag/位置参数判定。
识别形态:`git X`、`/usr/bin/git X`、`"git" X`、`git.exe X`、`sudo/env/nohup/time/nice/stdbuf/xargs/timeout git X`、
`A=1 git X`、`git -C p X`、`--git-dir=`/`--work-tree=`、`cd x && git X`、`;`/`|`/`||`/换行串联、`$(git X)`、反引号、`bash -c "git X"`。

## 8.1 工具层:`ctx.jj` 服务与 13 个 `jj_*` 工具(task-6)

`src/service.ts` 提供 `ctx.jj`(`JjService extends Service`,`static inject = ['subprocess','workingDirectory']`,`static Config = Config`):

- **检测**:`detect(cwd, signal)`(TTL 缓存)/ `warm`(强制刷新)/ `peek`(同步,供 guard)/ `describe(target)`;
- **操作**(全部走注入的 `RunJj`,真实运行时绑定 `ctx.subprocess`):
  `status` · `log` · `diff` · `newChange` · `describeChange` · `squash` · `undo`(`jj undo` / `jj op restore`,先记录 head op id)· `opLog` · `workspaceAdd` · `workspaceList` · `bookmarkList` · `bookmarkSet` · `rebase` · `version`;
- **生命周期**:`ctx.effect` disposer 先 abort → `await Promise.allSettled(pending)` → 清缓存(契约 §5.6)。

`src/tools.ts` 注册 13 个模型工具(英文描述逐字取自契约 §7.3,首句均点明 “Jujutsu (jj)”):

| 工具 | 作用 | 关键 jj 语义 |
|---|---|---|
| `jj_status` | 工作副本状态(`@`) | 无暂存区;`@` 就是提交 |
| `jj_log` | revset 选提交 | `@`/`@-`/`::@`/`bookmarks()`,不是 git 分支/范围语法 |
| `jj_diff` | `-r <revset>` 的 stat/patch | 没有 index/stash |
| `jj_new` | 新建 change 并设为 `@` | 上一个 change 保持身份,无需 commit |
| `jj_describe` | 就地改描述 | 取代 `git commit --amend` |
| `jj_squash` | 把改动搬进另一个提交 | 取代交互式暂存;后代自动 rebase |
| `jj_undo` | 撤销/恢复到某个 operation | operation log 是图级恢复;**返回 head op id** 供回滚 |
| `jj_op_log` | operation 历史 | 找 `jj_undo` 的 op id |
| `jj_workspace_add` | 新建 jj workspace | 与 `git worktree` 不同,登记在 jj;**建议放仓库根之外、支持绝对路径** |
| `jj_workspace_list` | 列出 workspace | 每个 workspace 有自己的 `@` |
| `jj_bookmark_list` / `jj_bookmark_set` | bookmark | bookmark 可选,不像 git 分支必需 |
| `jj_rebase` | rebase + 后代 | 无分支重放、无 merge 步骤 |

**非 jj 仓库的拒绝**(契约 §7.4,英文多行):git-only 仓库指出“这是 Git 仓库 + `jj git init` 共存路径”;空目录给 `jj git init` / `--no-colocate`;`.jj` 损坏给出 `jj --ignore-working-copy workspace list` 与修复建议;jj 未安装说明**绝不回退 git**。拒绝发生在任何 jj 子进程启动之前(有测试断言)。

**argv 纪律**:所有选择参数(revset / bookmark 名 / path)都是独立 argv 元素,不做 shell 拼接;工具从不传 `-R`(禁止在别的仓库上操作);元数据只读(`jj op log`/`workspace list`/`bookmark list`)带 `--ignore-working-copy`,而内容型只读(`jj_status`/`jj_log`/`jj_diff`)**故意快照**,否则 `@` 反映不出当前文件内容。

## 8.2 与 DSH 现有 git-only 组件的边界(task-10)

本包的 `cordis.patch.yml` 除了三条 `insert` 行,还带一条 **id-targeted patch**,让 DSH 的项目根发现理解 jj workspace:

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
    projectRootMarkers: ['.git', '.jj']
```

- **修好了什么**:`@deepseek-ai/dsh-agent-instructions` 的 `projectRootMarkers` 默认是 `['.git']`。
  在 **jj-native** 仓库(根目录没有 `.git`)里,cwd 位于子目录时**工作区根的 `AGENTS.md` 不会被发现**;加入 `.jj` 后根与子目录都能发现。
  真实证据(`scratch/implementer/evidence/project-root.txt`,脚本用真实 `discoverBaselineInstructionFiles` + `jj git init --no-colocate` 夹具,cwd 自检一致):

  ```
  cwd=sub,  markers=['.git']        -> AGENTS.md              (只有子目录的,工作区根的丢失)
  cwd=sub,  markers=['.git','.jj']  -> AGENTS.md, sub/AGENTS.md (根的被发现)
  cwd=root, markers=['.git','.jj']  -> AGENTS.md
  ```

- **没修好什么**:`@deepseek-ai/dsh-skill-filesystem` 的项目 skills 根**硬编码 `.git`**(实现内部,Config 未暴露,本包无法覆盖),
  因此 jj-native 工作区里**项目级 skill 仍可能找不到根**;这是需要上游改造的点(把标记改成可配置或复用同一套 marker)。
  过渡缓解(不属本任务验收):该包的 `customSkillDirs` 是**绝对路径列表**且不经过项目根发现,可在 profile patch 里给 `skill-filesystem` 行加
  `config: { customSkillDirs: ['/abs/path/to/workspace/.agents/skills'] }`;代价是**路径写死、每个工作区各配一次**,上游修好后应移除。
- **如何与他人的 patch 合并(避免覆盖)**:非 `insert` 的 patch 会**整体替换**该行的 `config`,所以
  1) 必须重述你想要保留的既有键(本包重述了组合配置里的 `maxBytes: 65536`);
  2) 如果使用者自己的 profile patch 里**已经**有 `- id: agent-instructions` 行,请把它合并成一条(在 `config` 里同时写 `maxBytes`、`projectRootMarkers` 以及你自己的键),
     **不要**保留两条同名行——后写的整条替换前面的,容易静默丢键;
  3) 行顺序:profile 的 `cordis.patch.yml` 是“用户层”,在 bundle 层之后应用,因此**用户层优先**;若使用者已有自己的 `agent-instructions` 行,以它为准并自行加上 `.jj`。
- **默认值依据**:`instructionFileCandidates`、`localInstructionFileCandidates`、`maxSourceBytes` 在包内有默认值,本次 patch 未重复声明(仅重述会被整体替换影响的 `maxBytes`)。

真实组合与 boot 证据(命令 + 片段):

```bash
DSH_HOME=/home/aqian/dsh-jj/scratch/lead/dsh-home dsh --profile jj-real --dump-config | grep -A6 '^- id: agent-instructions'
# - id: agent-instructions
#   name: '@deepseek-ai/dsh-agent-instructions'
#   config:
#     maxBytes: 65536
#     projectRootMarkers:
#       - .git
#       - .jj

DSH_HOME=/home/aqian/dsh-jj/scratch/lead/dsh-home dsh --profile jj-real web --help   # exit 0
```

(为完成 task-10 验收,同一行也已写入 `scratch/lead/dsh-home/profiles/jj-real/cordis.patch.yml`——该路径在 task-10 的 write scope 内;
它属于隔离验收 profile,不是用户 profile。)

## 9. 与 git 的边界(为什么不能混用)

- **工作副本即提交**:jj 没有暂存区,`@` 就是当前 change;`git commit` 不会产生 jj change,也不进 operation log。
- **change id vs commit id**:jj 用 change id(稳定)标识变更,git 只有 SHA。
- **operation log vs reflog**:jj 的恢复路径是 `jj undo` / `jj op restore` / `jj --at-op=<id> <read-cmd>`;
  git 侧写操作对 jj 不可见。
- **仓库级爆炸半径**:`jj undo` / `jj op restore` 会**重写当前工作区的整个工作副本**
  (2026-10-22 事故:共享工作区里一次 `jj undo` 删掉了约 28 个文件)。因此 guard 默认**放行但告警**,
  而不是一刀切拒绝——它们同样是首选的救援路径。**不要在共享工作区根目录执行这些命令。**
- **colocated 的 `.git` 与 jj 共用对象库**:`git gc` / `git prune` 可能清理 jj 仅通过 operation log 可达的对象,
  分类为 mutate 并推荐 `jj util gc`。

## 10. 已知限制

1. **hygiene**:库层的 guard 目前只覆盖 `guardTools` 名单里的 shell/终端工具与 `create_worktree`;
   其它工具(如未来新增的终端/执行类工具)需要加入配置。
2. **别名与包装脚本**:`git` 别名、shell 函数、`eval`、指向 git 的自定义脚本无法静态识别(返回 `unknown` → 放行)。
   heredoc 体会按行扫描,但未建模 heredoc 结构;**未闭合引号的行直接不分类**(shell 本身会拒绝执行该行)。
3. **cwd 近似**:guard 用 `workdir` 参数 → `workingDirectory.get(agent)` → `defaultCwd` → `process.cwd()` 解析 base cwd;
   `cd`/`-C` 会被跟随,但子 shell 分组 `( cd x && … )` 之后的 cwd 变化属于近似处理。
4. **缓存**:`peek` 按 `path.resolve` 归一化,不做 realpath(同步路径禁 I/O);同一目录的 symlink 别名可能各缓存一次。
5. **检测失败不回落 git**:`.jj` 存在但仓库损坏时 `kind='none'` 且保留 `jjRoot`/notices,绝不静默改用 git。
6. **工具层已实现**(`ctx.jj` + 13 个 `jj_*` 工具);`jj_diff` 的 `paths` 按原样传给 jj(相对 cwd 解析),未做绝对化重写;`jj_workspace_add` 不做路径越界校验(jj 允许任意目标目录,README 建议放仓库根之外)。
7. **app 级 boot 证据**(已闭环):隔离 profile `jj-e2e` 里在三条行之后追加一个 `inject: ['tools','jj']` 的探针插件,
   `DSH_HOME=… dsh --profile jj-e2e web --help` → exit 0,探针 apply 执行并观察到 `ctx.jj=object`(证明 runtime 行注册了服务、
   tools/guard 行的 `['tools','jj']` 依赖已满足);lead 的 `jj-real` profile boot 亦 exit 0。
   证据:`scratch/implementer/evidence/boot-check.txt`、`apply-order.txt`、`boot-jj-e2e.txt`。
   未复现项:给 `dsh-jj/guard` 行传非法 `guardMutatingGit` 值未观察到 loader 报错,待 verifier 用真实 app boot 复核。

## 11. 与契约的对应

实现与最初契约描述的两处**兼容性扩展**及差异,
记录在 `scratch/implementer/contract-notes.md`:

- `detectVcs(cwd, input, signal?)` 同时接受 task-4 的 `RunCommand`(argv 含程序名)与契约 §6.1 的 `DetectDeps`(`runJj`/`runGit`,argv 不含程序名);
- `VcsDescriptor` 采用契约 §5.3 字段(`jjWorkspaceRoot`/`jjStore`/`workspaces`/`remotes`/`verified`/`notices`/`probedAt`),
  并追加基础层扩展字段(`confidence`/`confirmedBy`/`jjAvailable`/`gitAvailable`/`gitCeilingApplied`/`jjRepoPath`);
- 契约 §4.2 的 `node --test test/` 在 Node v24.22.1 不可用(见 §4);
- `installGitConfusionGuard(host, options)` 同时接受裸 `JjPluginConfig`(task-4 用法)与契约 §8.1 的 `{service, config, warm}`;
  返回的句柄**本身可当 disposer 调用**(契约签名),并附带 `check`/`warnings`/`config`/`peek` 测试钩子。