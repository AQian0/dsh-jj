/**
 * jj operations and the `ctx.jj` service (design contract §5.4 / §5.6).
 *
 * {@link JjOperations} holds every jj-native operation; it is pure with respect
 * to the host (one injected {@link RunJj}), which makes the whole operation layer
 * testable against real repositories without mounting Cordis.
 *
 * {@link JjService} is the Cordis face: it owns the TTL cache used by the
 * synchronous guard, the disposal ladder (abort → settle pending → clear cache),
 * and the process-lifetime version cache.
 *
 * @module dsh-jj/service
 */
import { Service } from '@deepseek-ai/cordis';
import { assertServiceableConfig, Config, resolveConfig } from "./config.js";
import { detectVcs } from "./detect.js";
import { createRunGit, createRunJj, JjError, runJjChecked } from "./jj-command.js";
/** `jj log -r <rev> --no-graph -T <TPL_STATUS>` template (contract §2.8, verbatim). */
export const TPL_STATUS = '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ ",\\"paths\\":" ++ json(self.diff().files().map(|f| f.path())) ++ "}\\n"';
/** `jj log` per-change template (contract §2.8, verbatim). */
export const TPL_LOG = '"{\\"change_id\\":" ++ json(change_id) ++ ",\\"commit_id\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ json(description.first_line()) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"current_working_copy\\":" ++ json(current_working_copy) ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"author\\":" ++ json(author.email()) ++ "}\\n"';
/** `jj workspace list` template used by the tools (tab-separated; names may contain spaces). */
export const TPL_WORKSPACE_LIST_TAB = 'name ++ "\\t" ++ root ++ "\\n"';
/**
 * `jj op log` template (contract §7.3.8): `json(self)` exposes id/description/
 * time/username/hostname/workspace_name/is_snapshot/attributes.
 */
export const TPL_OP_LOG = 'json(self) ++ "\\n"';
/** `jj bookmark list` template (contract §7.3.11). */
export const TPL_BOOKMARK_LIST = 'json(self) ++ "\\n"';
/** Bounded text helper. */
function bound(text, limit) {
    return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}
function badInput(message, argv = []) {
    return new JjError('JJ_BAD_INPUT', message, { argv, exitCode: null, stderr: '', stdout: '' });
}
const OPERATION_ID_RE = /^[0-9a-f]{4,128}$/;
const BOOKMARK_NAME_RE = /^[^\s@]+$/;
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
function parseJsonLine(stdout, argv) {
    const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0);
    if (line === undefined) {
        throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` returned no parseable record.`, {
            argv,
            exitCode: 0,
            stderr: '',
            stdout: bound(stdout, 512).text,
        });
    }
    try {
        const parsed = JSON.parse(line);
        const record = asRecord(parsed);
        if (record === undefined)
            throw new Error('not an object');
        return record;
    }
    catch (error) {
        throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
            argv,
            exitCode: 0,
            stderr: error instanceof Error ? error.message : String(error),
            stdout: bound(stdout, 512).text,
        });
    }
}
function changeFromRecord(record) {
    const bookmarks = Array.isArray(record['bookmarks']) ? record['bookmarks'].map((entry) => String(entry)) : [];
    const paths = Array.isArray(record['paths']) ? record['paths'].map((entry) => String(entry)) : [];
    return {
        changeId: String(record['change_id'] ?? ''),
        commitId: String(record['commit_id'] ?? ''),
        description: String(record['description'] ?? '').replace(/\n$/, ''),
        empty: record['empty'] === true,
        conflict: record['conflict'] === true,
        currentWorkingCopy: record['current_working_copy'] === true,
        bookmarks,
        author: String(record['author'] ?? ''),
        paths,
    };
}
function parseChangeLines(stdout, argv) {
    const changes = [];
    for (const line of stdout.split('\n')) {
        if (line.trim().length === 0)
            continue;
        try {
            const record = asRecord(JSON.parse(line));
            if (record !== undefined)
                changes.push(changeFromRecord(record));
        }
        catch {
            throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(stdout, 512).text}`, {
                argv,
                exitCode: 0,
                stderr: '',
                stdout: bound(stdout, 512).text,
            });
        }
    }
    return changes;
}
/** Every jj-native operation dsh-jj exposes, over one injected runner. */
export class JjOperations {
    config;
    runJj;
    constructor(options) {
        this.config = resolveConfig(options.config ?? {});
        assertServiceableConfig(this.config);
        this.runJj = options.runJj;
    }
    /** Base jj options shared by every call. */
    options(cwd, argv, signal, env) {
        return {
            cwd,
            argv,
            timeoutMs: this.config.timeoutMs,
            graceMs: this.config.graceMs,
            maxOutputBytes: this.config.maxOutputBytes,
            jjCommand: this.config.jjCommand,
            ...(signal !== undefined ? { signal } : {}),
            ...(env !== undefined ? { env } : {}),
        };
    }
    async run(cwd, argv, signal) {
        return await runJjChecked(this.runJj, this.options(cwd, argv, signal), this.config);
    }
    /** `jj --version` / `git --version` (the only git call dsh-jj allows). */
    async version(cwd, signal) {
        let jj;
        try {
            const result = await this.runJj({ ...this.options(cwd, ['--version'], signal), jjCommand: this.config.jjCommand });
            if (result.exitCode === 0)
                jj = result.stdout.trim();
        }
        catch {
            jj = undefined;
        }
        return { jj, git: undefined };
    }
    /** `jj log -r @ --no-graph -T <TPL_STATUS>` plus `jj status`. */
    async status(cwd, signal) {
        const argv = ['log', '-r', '@', '--no-graph', '-T', TPL_STATUS];
        const changeResult = await this.run(cwd, argv, signal);
        const change = changeFromRecord(parseJsonLine(changeResult.stdout, argv));
        const statusArgv = ['status'];
        const statusResult = await this.run(cwd, statusArgv, signal);
        const raw = statusResult.stdout;
        const bounded = bound(raw, 8 * 1024);
        return {
            change,
            changedPaths: change.paths,
            diffStat: raw.trim(),
            raw: bounded.text,
            truncated: bounded.truncated,
        };
    }
    /** `jj log -r <revset> --no-graph --limit <n> -T <TPL_LOG>`. */
    async log(cwd, revset, limit, signal) {
        // Content-reporting reads intentionally snapshot: `jj log -r @` must show the
        // current working-copy content (contract §5.8's --ignore-working-copy applies
        // to metadata reads, which are listed below).
        const argv = ['log', '-r', revset, '--no-graph', '--limit', String(limit), '-T', TPL_LOG];
        const result = await this.run(cwd, argv, signal);
        return parseChangeLines(result.stdout, argv);
    }
    /** `jj diff -r <revset> (--stat|--git) [-- <paths…>]`. */
    async diff(cwd, revset, format, paths, signal) {
        const argv = ['diff', '-r', revset, format === 'stat' ? '--stat' : '--git'];
        if (paths.length > 0)
            argv.push('--', ...paths);
        const result = await this.run(cwd, argv, signal);
        const bounded = bound(result.stdout, this.config.maxOutputBytes);
        return { text: bounded.text, truncated: bounded.truncated };
    }
    /** `jj new [-m <message>] [<parent>…]` then read back `@`. */
    async newChange(cwd, parents, message, signal) {
        const argv = ['new'];
        if (message !== undefined && message.length > 0)
            argv.push('-m', message);
        argv.push(...parents);
        await this.run(cwd, argv, signal);
        return await this.readAt(cwd, signal);
    }
    /** `jj describe -r <revset> -m <message>` then read the revision back. */
    async describeChange(cwd, revset, message, signal) {
        const argv = ['describe', '-r', revset, '-m', message];
        await this.run(cwd, argv, signal);
        const readArgv = ['log', '-r', revset, '--no-graph', '-T', TPL_STATUS];
        const result = await this.run(cwd, readArgv, signal);
        return changeFromRecord(parseJsonLine(result.stdout, readArgv));
    }
    /** `jj squash --from <from> --into <into> [-m msg | --use-destination-message]`. */
    async squash(cwd, from, into, message, useDestinationMessage, signal) {
        if (message !== undefined && useDestinationMessage) {
            throw badInput('message and useDestinationMessage are mutually exclusive; pass only one.');
        }
        if (message === undefined && !useDestinationMessage) {
            // Contract §5.9/§7.3.6: never let jj open an editor for a headless tool call.
            throw badInput('jj_squash needs a message path: pass -m <message> or useDestinationMessage: true (jj would otherwise open an editor).');
        }
        const argv = ['squash', '--from', from, '--into', into];
        if (message !== undefined)
            argv.push('-m', message);
        if (useDestinationMessage)
            argv.push('--use-destination-message');
        await this.run(cwd, argv, signal);
        return await this.readAt(cwd, signal);
    }
    /** `jj undo` or `jj op restore <operationId>`; records the head operation first. */
    async undo(cwd, operationId, signal) {
        if (operationId !== undefined && !OPERATION_ID_RE.test(operationId)) {
            throw badInput('operationId must be a hexadecimal operation id prefix (4-128 characters) as shown by jj_op_log.');
        }
        const headOperationId = await this.headOperationId(cwd, signal);
        const argv = operationId === undefined ? ['undo'] : ['op', 'restore', operationId];
        const result = await this.run(cwd, argv, signal);
        const message = [
            bound(result.stdout.trim(), 2 * 1024).text,
            `head operation before this call: ${headOperationId} — to roll back, run \`jj op restore ${headOperationId}\` (a second \`jj undo\` would undo this undo, not redo it).`,
        ]
            .filter((line) => line.length > 0)
            .join('\n');
        return {
            mode: operationId === undefined ? 'undo' : 'restore',
            operationId: operationId ?? headOperationId,
            headOperationId,
            message,
        };
    }
    /** `jj op log -n 1 --no-graph -T 'self.id()'` — the self-protection step (contract §8.3b). */
    async headOperationId(cwd, signal) {
        try {
            const argv = ['op', 'log', '-n', '1', '--no-graph', '-T', 'self.id()'];
            const result = await this.runJj(this.options(cwd, argv, signal));
            const id = result.stdout.trim().split('\n')[0]?.trim();
            return id !== undefined && id.length > 0 ? id : 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    /** `jj op log -n <n> --no-graph -T 'json(self) ++ "\n"'`. */
    async opLog(cwd, limit, signal) {
        const argv = ['op', 'log', '-n', String(limit), '--ignore-working-copy', '--no-graph', '-T', TPL_OP_LOG];
        const result = await this.run(cwd, argv, signal);
        const operations = [];
        for (const line of result.stdout.split('\n')) {
            if (line.trim().length === 0)
                continue;
            let record;
            try {
                record = asRecord(JSON.parse(line));
            }
            catch {
                throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`, {
                    argv,
                    exitCode: 0,
                    stderr: '',
                    stdout: bound(result.stdout, 512).text,
                });
            }
            if (record === undefined)
                continue;
            const id = String(record['id'] ?? '');
            const attributes = asRecord(record['attributes']) ?? {};
            operations.push({
                id,
                shortId: id.slice(0, 12),
                description: String(record['description'] ?? ''),
                time: String(record['time'] ?? ''),
                user: `${String(record['username'] ?? '')}@${String(record['hostname'] ?? '')}`,
                workspaceName: record['workspace_name'] === null || record['workspace_name'] === undefined ? null : String(record['workspace_name']),
                isSnapshot: record['is_snapshot'] === true,
                tags: Object.keys(attributes),
            });
        }
        return operations;
    }
    /** `jj workspace add <path> [--name n] [-r r]… [-m m] [--colocate]`, then read the workspace back. */
    async workspaceAdd(cwd, path, name, parents, message, colocate, signal) {
        if (path.trim().length === 0 || path.startsWith('-')) {
            throw badInput('path must be a non-empty path that does not start with "-".');
        }
        const argv = ['workspace', 'add', path];
        if (name !== undefined && name.length > 0)
            argv.push('--name', name);
        for (const parent of parents)
            argv.push('-r', parent);
        if (message !== undefined && message.length > 0)
            argv.push('-m', message);
        if (colocate === true)
            argv.push('--colocate');
        await this.run(cwd, argv, signal);
        const workspaces = await this.workspaceList(cwd, signal);
        const created = workspaces.find((workspace) => workspace.name === name) ?? workspaces.find((workspace) => workspace.root === path) ?? workspaces[workspaces.length - 1];
        if (created === undefined) {
            throw new JjError('JJ_OUTPUT_INVALID', `\`jj workspace add\` did not report a new workspace for ${path}.`, {
                argv,
                exitCode: 0,
                stderr: '',
                stdout: '',
            });
        }
        const change = await this.readAt(created.root, signal);
        return { path: created.root, name: created.name, change };
    }
    /** `jj workspace list -T 'name ++ "\t" ++ root ++ "\n"'`. */
    async workspaceList(cwd, signal) {
        const argv = ['workspace', 'list', '--ignore-working-copy', '-T', TPL_WORKSPACE_LIST_TAB];
        const result = await this.run(cwd, argv, signal);
        const workspaces = [];
        for (const line of result.stdout.split('\n')) {
            if (line.trim().length === 0)
                continue;
            const [name, root] = line.split('\t');
            if (name === undefined || root === undefined)
                continue;
            workspaces.push({ name: name.trim(), root: root.trim() });
        }
        return workspaces;
    }
    /** `jj bookmark list [--all-remotes] -T 'json(self) ++ "\n"'`. */
    async bookmarkList(cwd, allRemotes, signal) {
        const argv = ['bookmark', 'list', '--ignore-working-copy'];
        if (allRemotes)
            argv.push('--all-remotes');
        argv.push('-T', TPL_BOOKMARK_LIST);
        const result = await this.run(cwd, argv, signal);
        const bookmarks = [];
        for (const line of result.stdout.split('\n')) {
            if (line.trim().length === 0)
                continue;
            let record;
            try {
                record = asRecord(JSON.parse(line));
            }
            catch {
                throw new JjError('JJ_OUTPUT_INVALID', `\`jj ${argv.join(' ')}\` produced unparseable output: ${bound(line, 512).text}`, {
                    argv,
                    exitCode: 0,
                    stderr: '',
                    stdout: bound(result.stdout, 512).text,
                });
            }
            if (record === undefined)
                continue;
            const target = Array.isArray(record['target']) ? record['target'] : [];
            bookmarks.push({
                name: String(record['name'] ?? ''),
                target: target.length > 0 ? String(target[0]) : '',
                remote: record['remote'] === undefined || record['remote'] === null ? null : String(record['remote']),
            });
        }
        return bookmarks;
    }
    /** `jj bookmark set <name> -r <revset> [--allow-backwards]`, then read the target back. */
    async bookmarkSet(cwd, name, revset, allowBackwards, signal) {
        if (!BOOKMARK_NAME_RE.test(name) || name.includes('@')) {
            throw badInput("bookmark names must be non-empty and must not contain whitespace or '@'.");
        }
        const before = await this.bookmarkList(cwd, false, signal);
        const existing = before.find((bookmark) => bookmark.name === name);
        const argv = ['bookmark', 'set', name, '-r', revset];
        if (allowBackwards)
            argv.push('--allow-backwards');
        await this.run(cwd, argv, signal);
        const after = await this.bookmarkList(cwd, false, signal);
        const target = after.find((bookmark) => bookmark.name === name)?.target ?? '';
        return { name, target, moved: existing !== undefined };
    }
    /** `jj rebase -r <revision> -d <destination>`. */
    async rebase(cwd, revision, destination, signal) {
        const argv = ['rebase', '-r', revision, '-d', destination];
        const result = await this.run(cwd, argv, signal);
        return bound(result.stdout.trim(), 2 * 1024).text;
    }
    /** Read `@` (or a revset) as a {@link JjChangeRecord}. */
    async readAt(cwd, signal, revset = '@') {
        const argv = ['log', '-r', revset, '--no-graph', '-T', TPL_STATUS];
        const result = await this.run(cwd, argv, signal);
        return changeFromRecord(parseJsonLine(result.stdout, argv));
    }
}
/** Plugin configuration schema re-exported for the service entry. */
export { Config };
/**
 * `ctx.jj` — the Cordis service face of {@link JjOperations}.
 *
 * The TTL cache is what makes the synchronous guard possible: `peek` never
 * spawns, `warm` refreshes, and disposal aborts in-flight work and clears it.
 */
export class JjService extends Service {
    static inject = ['subprocess', 'workingDirectory'];
    static Config = Config;
    operations;
    lifetime = new AbortController();
    pending = new Set();
    cache = new Map();
    versionCache;
    constructor(ctx, config = {}) {
        super(ctx, 'jj');
        const resolved = resolveConfig(config);
        assertServiceableConfig(resolved);
        this.operations = new JjOperations({
            config,
            runJj: (options) => this.track(createRunJj(ctx, resolved)(options)),
        });
        ctx.effect(() => async () => {
            this.lifetime.abort(new Error('dsh-jj service disposed'));
            await Promise.allSettled(this.pending);
            this.pending.clear();
            this.cache.clear();
        });
    }
    /** Track one in-flight jj call so disposal can settle it. */
    track(promise) {
        this.pending.add(promise);
        void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
        return promise;
    }
    /** TTL-cached detection (contract §6.4). */
    async detect(cwd, signal) {
        const key = this.cacheKey(cwd);
        const cached = this.cache.get(key);
        if (cached !== undefined && Date.now() - cached.probedAt <= this.operations.config.detectCacheTtlMs) {
            return cached.descriptor;
        }
        return await this.warm(cwd, signal);
    }
    /** Forced refresh of the detection cache. */
    async warm(cwd, signal) {
        const descriptor = await this.track(detectVcs(cwd, this.detectDeps(), signal));
        this.cache.set(this.cacheKey(cwd), { descriptor, probedAt: descriptor.probedAt });
        return descriptor;
    }
    /** Synchronous cache read for the guard; `undefined` on a miss (fail-open). */
    peek(cwd) {
        return this.cache.get(this.cacheKey(cwd))?.descriptor;
    }
    /** Single-line human summary (contract §5.4). */
    describe(target) {
        if (typeof target === 'string') {
            switch (target) {
                case 'git':
                    return 'Git repository (no Jujutsu workspace)';
                case 'jj-native':
                    return 'Jujutsu (jj) native repository';
                case 'jj-colocated':
                    return 'Jujutsu (jj) colocated with Git';
                case 'none':
                    return 'No repository';
            }
        }
        const descriptor = target;
        return `${descriptor.kind} workspace "${descriptor.workspaceName ?? 'unknown'}" at ${descriptor.root} (${descriptor.jjVersion ?? 'jj version unknown'})`;
    }
    /** Process-lifetime version cache. */
    async version(cwd, signal) {
        if (this.versionCache !== undefined)
            return this.versionCache;
        const probe = await this.operations.version(cwd, signal);
        const descriptor = this.peek(cwd);
        this.versionCache = { jj: probe.jj ?? descriptor?.jjVersion, git: descriptor?.gitVersion };
        return this.versionCache;
    }
    cacheKey(cwd) {
        try {
            return resolveKey(cwd);
        }
        catch {
            return cwd;
        }
    }
    detectDeps() {
        const resolved = this.operations.config;
        return {
            runJj: createRunJj(this.ctx, resolved),
            runGit: createRunGit(this.ctx, resolved),
            jjCommand: resolved.jjCommand,
            gitCommand: resolved.gitCommand,
            timeoutMs: resolved.timeoutMs,
        };
    }
}
function resolveKey(cwd) {
    // path.resolve without realpath: the guard's sync path cannot do I/O.
    return cwd.startsWith('/') ? cwd.replace(/\/+$/, '') || '/' : cwd;
}
