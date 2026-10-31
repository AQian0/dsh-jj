/**
 * Shell command-line tokenizer and parsing primitives for the git/jj command
 * classifiers (design contract §8.2 / §8.3).
 *
 * Pure module: no I/O, no subprocess, no `@deepseek-ai/*` imports. It turns a
 * raw shell command line into operator-delimited segments and words, handling
 * quoting, command substitution, redirections, heredocs, shell wrappers, and
 * `xargs`/`sudo`/`env` preludes. The rules modules and the public barrel
 * (`./git-command.ts`) build on these primitives.
 *
 * @module dsh-jj/git-tokenize
 */

export interface Token {
  readonly value: string;
  readonly text: string;
}

export interface RawSegment {
  readonly raw: string;
  readonly kind: 'command' | 'substitution';
  readonly words: readonly Token[];
  readonly parsed: boolean;
}

const OPERATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')']);

/** Maximum recursion depth for command substitutions and nested shell wrappers. */
export const MAX_NESTING = 6;

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

export function baseName(word: string): string {
  const parts = word.split(/[\\/]/);
  return parts[parts.length - 1] ?? word;
}

const WRAPPERS = new Set([
  'sudo',
  'doas',
  'command',
  'builtin',
  'nohup',
  'setsid',
  'exec',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'env',
  'xargs',
  'timeout',
]);

/** Shells (or shell-like hosts) whose `-c`/`/c` argument is a nested command line. */
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'pwsh', 'powershell', 'cmd', 'fish', 'nu']);

/** Shells whose `-c` may be combined with other single-letter flags (`bash -lc`). */
const BASH_LIKE_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

/**
 * Shell keywords that can precede a command in the same segment. They are not
 * wrappers, but skipping them keeps `! git commit`, `{ git commit; }`, and
 * `then git commit` classifiable.
 */
const SHELL_KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'then',
  'do',
  'else',
  'elif',
  'fi',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'if',
]);

/**
 * Multi-call wrappers whose inner command cannot be resolved statically. They are
 * reported through a one-time parser warning instead of being silently skipped.
 */
const DYNAMIC_WRAPPERS = new Set([
  'busybox',
  'toybox',
  'unbuffer',
  'parallel',
  'xcrun',
  'strace',
  'ltrace',
  'valgrind',
]);

const WRAPPER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sudo: [
    '-u',
    '-g',
    '-p',
    '-C',
    '-h',
    '-r',
    '-t',
    '-U',
    '--user',
    '--group',
    '--prompt',
    '--chdir',
    '--host',
    '--role',
    '--type',
    '--other-user',
  ],
  doas: ['-u', '-C'],
  env: ['-u', '--unset', '-S', '--split-string', '-C', '--chdir'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: [
    '-I',
    '-n',
    '-P',
    '-d',
    '-E',
    '-s',
    '-a',
    '-L',
    '--arg-file',
    '--max-args',
    '--max-procs',
    '--delimiter',
    '--eof',
    '--max-chars',
    '--replace',
  ],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  command: [],
  exec: ['-a'],
});

/** A nested command line option found in a wrapper's arguments. */
interface WrapperInner {
  /** True when the wrapper names a nested command-line option (`-c`, `/c`, `-Command`, `env -S`). */
  readonly found: boolean;
  /** The nested command line text, when one could be read. */
  readonly command?: string;
}

/**
 * The nested command line a shell wrapper would execute (`bash -c …`,
 * `pwsh -Command …`, `cmd /c …`, `fish -c …`).
 *
 * Shells accept `--` between the option and its value (`bash -c -- "…"`), so it
 * is skipped: without that the `-c` value was read as a literal `--`.
 */
function shellWrapperInnerCommand(name: string, rest: readonly string[]): WrapperInner {
  const afterFlag = (index: number): WrapperInner => {
    const value = rest[index + 1] === '--' ? rest[index + 2] : rest[index + 1];
    return { found: true, ...(value !== undefined && value.length > 0 ? { command: value } : {}) };
  };
  if (BASH_LIKE_SHELLS.has(name)) {
    const index = rest.findIndex((token) => token === '-c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    return index >= 0 ? afterFlag(index) : { found: false };
  }
  const lower = name.toLowerCase();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (lower === 'cmd' || lower === 'cmd.exe') {
      if (/^\/[cC]$/.test(token)) return afterFlag(index);
      continue;
    }
    if (token === '-c' || token === '-Command' || token === '-command') return afterFlag(index);
  }
  return { found: false };
}

/**
 * The command line carried by one `env` argument, when that argument is
 * `-S`/`--split-string` or the attached `-S'…'` spelling (one token after
 * tokenization).
 *
 * @param token - the `env` argument under inspection.
 * @param next - the following argument (the split string for the spaced spelling).
 */
function envSplitValue(token: string, next: string | undefined): WrapperInner {
  if (token === '-S' || token === '--split-string') {
    return { found: true, ...(next !== undefined && next.length > 0 ? { command: next } : {}) };
  }
  if (token.startsWith('-S') && token.length > 2) {
    const value = token.slice(2);
    return { found: true, ...(value.length > 0 ? { command: value } : {}) };
  }
  const attached = /^--split-string=(.*)$/.exec(token);
  if (attached !== null) {
    const value = attached[1];
    return { found: true, ...(value !== undefined && value.length > 0 ? { command: value } : {}) };
  }
  return { found: false };
}

/**
 * Nested command lines carried by one segment: shell wrapper `-c` arguments and
 * `env -S` split strings. The returned text is re-tokenized by the classifiers,
 * recursively (a nested line may itself hide a wrapped command), so their
 * invocations are classified instead of silently missed.
 *
 * @param segment - one parsed segment of the outer command line.
 * @param warnings - receives a one-time parser warning for a wrapper whose nested
 *   command line cannot be read (never dropped silently).
 * @returns the nested command lines, outermost first.
 */
export function nestedCommandStrings(segment: RawSegment, warnings: string[] = []): string[] {
  const prelude = scanPrelude(segment.words, []);
  const nested: string[] = [];
  for (const split of prelude.envSplitStrings) nested.push(split);
  const program = segment.words[prelude.programIndex]?.value;
  if (program === undefined) return nested;
  const name = baseName(program);
  if (SHELL_WRAPPERS.has(name)) {
    const inner = shellWrapperInnerCommand(
      name,
      segment.words.slice(prelude.programIndex + 1).map((token) => token.value),
    );
    if (inner.command !== undefined) nested.push(inner.command);
    else if (inner.found) {
      warnings.push(
        `\`${name} -c\` has no command string to inspect; the wrapped command was not classified (inspect it manually).`,
      );
    }
  }
  return nested;
}

/** One pending heredoc on the current logical line. */
interface HeredocSpec {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

/**
 * Parse the delimiter word that follows a `<<`/`<<-` heredoc operator.
 *
 * @param commandLine - the whole command line.
 * @param start - index of the first character after the operator (and `-`).
 * @returns the delimiter after shell quote removal (`undefined` when the line
 *   ends first) and the index of the last consumed character.
 */
function parseHeredocDelimiter(commandLine: string, start: number): { delimiter?: string; nextIndex: number } {
  let index = start;
  while (index < commandLine.length && (commandLine[index] === ' ' || commandLine[index] === '\t')) index += 1;
  let delimiter = '';
  let found = false;
  while (index < commandLine.length) {
    const char = commandLine[index] ?? '';
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      for (;;) {
        if (index >= commandLine.length) return { nextIndex: commandLine.length - 1 };
        const inner = commandLine[index] ?? '';
        if (inner === '\\' && quote === '"') {
          delimiter += commandLine[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        delimiter += inner;
        index += 1;
      }
      found = true;
      continue;
    }
    if (char === '\\') {
      delimiter += commandLine[index + 1] ?? '';
      index += 2;
      found = true;
      continue;
    }
    if (/[ \t\n;&|()<>]/.test(char)) break;
    delimiter += char;
    index += 1;
    found = true;
  }
  return found ? { delimiter, nextIndex: index - 1 } : { nextIndex: index - 1 };
}

/**
 * Skip the bodies of all heredocs queued on a command line, starting at `start`
 * (the character right after the newline that opens the first body).
 *
 * @returns the index of the last consumed character, or `undefined` when a body
 *   is unterminated (the shell would wait for more input).
 */
function consumeHeredocBodies(
  commandLine: string,
  start: number,
  heredocs: readonly HeredocSpec[],
): number | undefined {
  let index = start;
  for (const heredoc of heredocs) {
    let lineStart = index;
    for (;;) {
      const newline = commandLine.indexOf('\n', lineStart);
      const line = newline === -1 ? commandLine.slice(lineStart) : commandLine.slice(lineStart, newline);
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === heredoc.delimiter) {
        index = newline === -1 ? commandLine.length : newline + 1;
        break;
      }
      if (newline === -1) return undefined;
      lineStart = newline + 1;
    }
  }
  return index - 1;
}

/** Split a command line into words and operator-delimited segments. */
export function tokenize(
  commandLine: string,
  kind: 'command' | 'substitution',
  nesting: number,
): { segments: RawSegment[]; warnings: string[] } {
  const segments: RawSegment[] = [];
  const warnings: string[] = [];
  let words: Token[] = [];
  let current = '';
  let currentText = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let parsed = true;
  let raw = '';
  /** True while the next word is a redirection target (dropped, never classified). */
  let discardTarget = false;
  /** Heredocs whose bodies start after the next newline. */
  const heredocs: HeredocSpec[] = [];

  const invalidateParsedSegments = (): void => {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment !== undefined && segment.parsed) segments[index] = { ...segment, parsed: false };
    }
  };

  const flushWord = (): void => {
    if (currentText.length > 0 || current.length > 0) {
      if (!discardTarget) words.push({ value: current, text: currentText });
      discardTarget = false;
      current = '';
      currentText = '';
    }
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) segments.push({ raw, kind, words, parsed });
    words = [];
    raw = '';
    parsed = true;
    discardTarget = false;
  };

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index] ?? '';
    if (escaped) {
      current += char === '\n' ? '' : char;
      currentText += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      raw += char;
      currentText += char;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      raw += char;
      currentText += char;
      continue;
    }
    if ((char === '$' && commandLine[index + 1] === '(') || char === '`') {
      const closing = char === '`' ? '`' : ')';
      const start = index + (char === '`' ? 1 : 2);
      let depth = 1;
      let end = start;
      let substitutionQuote: "'" | '"' | undefined;
      for (; end < commandLine.length; end += 1) {
        const inner = commandLine[end] ?? '';
        if (inner === '\\') {
          end += 1;
          continue;
        }
        if (substitutionQuote === "'") {
          if (inner === "'") substitutionQuote = undefined;
          continue;
        }
        if (substitutionQuote === '"') {
          if (inner === '"') substitutionQuote = undefined;
          continue;
        }
        if (inner === "'" || inner === '"') {
          substitutionQuote = inner;
          continue;
        }
        if (char === '$' && inner === '(') depth += 1;
        if (inner === closing) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const innerText = commandLine.slice(start, end);
      if (nesting < MAX_NESTING) {
        const nested = tokenize(innerText, 'substitution', nesting + 1);
        segments.push(...nested.segments);
        warnings.push(...nested.warnings);
      } else {
        warnings.push('Command substitution nesting limit reached; deeper substitutions were not classified.');
      }
      const text = commandLine.slice(index, Math.min(end + 1, commandLine.length));
      words.push({ value: '$SUBST', text });
      raw += text;
      index = end;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else current += char;
      raw += char;
      currentText += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      raw += char;
      currentText += char;
      continue;
    }
    // Process substitution: keep scanning the inner command (legacy behaviour).
    if ((char === '>' || char === '<') && commandLine[index + 1] === '(') {
      current += char;
      currentText += char;
      raw += char;
      continue;
    }
    // Redirection operators: their targets are data, never command words.
    if (char === '>' || char === '<' || (char === '&' && commandLine[index + 1] === '>')) {
      if (char === '&') {
        raw += '&>';
        index += 1;
        if (commandLine[index + 1] === '>') {
          raw += '>';
          index += 1;
        }
        discardTarget = true;
        continue;
      }
      const descriptorPrefix = currentText.length > 0 && current === currentText && /^[0-9]+$/.test(current);
      if (descriptorPrefix) {
        current = '';
        currentText = '';
      } else {
        flushWord();
      }
      if (char === '>') {
        const next = commandLine[index + 1] ?? '';
        if (next === '>') {
          raw += '>>';
          index += 1;
        } else if (next === '&') {
          raw += '>&';
          index += 1;
        } else if (next === '|') {
          raw += '>|';
          index += 1;
        } else {
          raw += '>';
        }
        discardTarget = true;
        continue;
      }
      const next = commandLine[index + 1] ?? '';
      if (next === '<') {
        if (commandLine[index + 2] === '<') {
          raw += '<<<';
          index += 2;
          discardTarget = true;
          continue;
        }
        const stripTabs = commandLine[index + 2] === '-';
        const parsedDelimiter = parseHeredocDelimiter(commandLine, index + 2 + (stripTabs ? 1 : 0));
        raw += commandLine.slice(index, Math.min(parsedDelimiter.nextIndex + 1, commandLine.length));
        index = Math.max(parsedDelimiter.nextIndex, index + 1);
        if (parsedDelimiter.delimiter === undefined) {
          warnings.push('Command line contains a heredoc operator without a delimiter; the shell would reject it.');
          parsed = false;
          invalidateParsedSegments();
          index = commandLine.length;
          continue;
        }
        heredocs.push({ delimiter: parsedDelimiter.delimiter, stripTabs });
        continue;
      }
      if (next === '&') {
        raw += '<&';
        index += 1;
        discardTarget = true;
        continue;
      }
      if (next === '>') {
        raw += '<>';
        index += 1;
        discardTarget = true;
        continue;
      }
      raw += '<';
      discardTarget = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      flushWord();
      raw += char;
      continue;
    }
    if (OPERATORS.has(char)) {
      if (char === '\n' && heredocs.length > 0) {
        flushSegment();
        const bodyEnd = consumeHeredocBodies(commandLine, index + 1, heredocs);
        heredocs.length = 0;
        if (bodyEnd === undefined) {
          warnings.push('Command line contains an unterminated heredoc body; the shell would reject it.');
          invalidateParsedSegments();
          parsed = false;
          index = commandLine.length;
          continue;
        }
        index = bodyEnd;
        continue;
      }
      let operator = char;
      if ((char === '&' || char === '|') && commandLine[index + 1] === char) {
        operator = char + char;
        index += 1;
      }
      flushSegment();
      raw = operator;
      flushSegment();
      continue;
    }
    current += char;
    currentText += char;
    raw += char;
  }

  if (escaped) {
    warnings.push('Command line ends with a trailing backslash; the shell would wait for more input.');
    parsed = false;
  }
  if (quote !== undefined) {
    warnings.push(
      `Command line contains an unterminated ${quote === "'" ? 'single' : 'double'} quote; the shell would reject it before running anything.`,
    );
    parsed = false;
  }
  if (heredocs.length > 0) {
    warnings.push('Command line contains a heredoc without a body; the shell would wait for more input.');
    parsed = false;
    invalidateParsedSegments();
  }
  flushSegment();
  return { segments, warnings };
}

/** Split arguments into flags and positionals, honouring value-taking flags. */
export function scanArgs(
  args: readonly string[],
  valueFlags: readonly string[],
): { flags: string[]; positionals: string[] } {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith('-') && token !== '-') {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      flags.push(flag);
      if (eq < 0 && valueFlags.includes(flag)) index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

/** Wrapper/environment prelude decoded for one shell segment. */
export interface PreludeScan {
  /** Index of the first word that is not an assignment, keyword, or wrapper. */
  readonly programIndex: number;
  /** Command lines carried by `env -S`/`--split-string` in the prelude chain. */
  readonly envSplitStrings: readonly string[];
}

/**
 * Skip leading `VAR=value` assignments, shell keywords, wrapper commands, and
 * shell wrappers.
 *
 * Wrappers may be chained (`sudo -u root env A=1 command bash -c …`), so the
 * walk repeats until it reaches the program the shell would actually run. The
 * `env -S` split strings found on the way are returned for the caller to
 * re-tokenize, and a wrapper whose nested command line cannot be read produces a
 * one-time warning instead of disappearing silently.
 *
 * @param words - dequoted words of one shell segment.
 * @param warnings - receives parser warnings (never a silent drop).
 * @returns the program index and the env split strings found in the prelude.
 */
export function scanPrelude(words: readonly Token[], warnings: string[]): PreludeScan {
  let index = 0;
  const envSplitStrings: string[] = [];
  for (;;) {
    while (index < words.length && isAssignment(words[index]?.value ?? '')) index += 1;
    const head = words[index]?.value;
    if (head === undefined) return { programIndex: index, envSplitStrings };
    const name = baseName(head);
    if (SHELL_KEYWORDS.has(name)) {
      index += 1;
      continue;
    }
    if (SHELL_WRAPPERS.has(name)) {
      // The inner command line is expanded by `nestedCommandStrings`, which
      // re-tokenizes it recursively; its warnings surface there.
      return { programIndex: index, envSplitStrings };
    }
    if (!WRAPPERS.has(name)) {
      if (name === 'eval') {
        warnings.push('`eval` hides the command text from static classification; it was not inspected.');
      } else if (head.includes('$') || head.includes('`')) {
        warnings.push('the program name contains a shell expansion, so the command cannot be classified statically.');
      } else if (DYNAMIC_WRAPPERS.has(name)) {
        warnings.push(`\`${name}\` is a wrapper the parser does not understand; its inner command was not inspected.`);
      } else if (name === 'find' && words.some((token) => token.value === '-exec' || token.value === '-execdir')) {
        warnings.push('`find -exec` runs another command, but that inner command cannot be classified statically.');
      } else if (name === 'ssh' && words.slice(1).some((token) => /(^|\s)(git|jj)(\s|$)/.test(token.value))) {
        warnings.push('`ssh` runs the command on another host; the remote Git/jj command was not inspected.');
      }
      break;
    }
    const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? [];
    index += 1;
    while (index < words.length) {
      const token = words[index]?.value ?? '';
      if (isAssignment(token)) {
        index += 1;
        continue;
      }
      if (token === '--') {
        index += 1;
        break;
      }
      if (token.startsWith('-') && token !== '-') {
        const eq = token.indexOf('=');
        const flag = eq >= 0 ? token.slice(0, eq) : token;
        if (name === 'env') {
          const split = envSplitValue(token, words[index + 1]?.value);
          if (split.found) {
            if (split.command !== undefined) envSplitStrings.push(split.command);
            else warnings.push('`env -S` has no split string to inspect; the wrapped command was not classified.');
          }
        }
        index += eq < 0 && valueFlags.includes(flag) ? 2 : 1;
        continue;
      }
      break;
    }
    if (name === 'timeout' && index < words.length && !(words[index]?.value ?? '').startsWith('-')) index += 1;
  }
  return { programIndex: index, envSplitStrings };
}

/** True when a `cd` argument can be resolved without shell expansion. */
export function isStaticDirectoryTarget(target: string): boolean {
  if (target.length === 0 || target === '-') return false;
  return !target.includes('$') && !target.includes('`') && !target.startsWith('~');
}

/** Directory change carried by the leading `cd`/`pushd`/`popd` of one segment. */
export interface SegmentDirectoryChange {
  /** Raw target directory, when one was written (`cd -P dir`, `pushd dir`). */
  readonly target?: string;
  /** One-time warning for a directory change that cannot be followed statically. */
  readonly warning?: string;
}

/** Commands that change the current directory of the following segments. */
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd']);

/**
 * Target of a leading `cd`/`pushd` in one shell segment.
 *
 * `cd` accepts flags before the path (`cd -P dir`, `cd -- dir`) and `cd -` returns
 * to the previous directory, which cannot be resolved statically. `pushd -n` only
 * touches the directory stack without changing the directory, while `pushd`/`popd`
 * without a statically known target leave the next directory unknown — those get a
 * parser warning so the guard never silently follows a guessed directory.
 *
 * @param words - dequoted words of one shell segment.
 * @returns the directory change, or `undefined` when the segment does not start
 *   with a directory-changing command.
 */
export function segmentDirectoryChange(words: readonly Token[]): SegmentDirectoryChange | undefined {
  const { programIndex } = scanPrelude(words, []);
  const program = words[programIndex]?.value;
  if (program === undefined) return undefined;
  const name = baseName(program);
  if (!DIRECTORY_COMMANDS.has(name)) return undefined;
  const rest = words.slice(programIndex + 1).map((token) => token.value);
  if (name === 'popd') {
    return { warning: '`popd` returns to a directory on the stack; the guard could not follow that directory.' };
  }
  let noChange = false;
  let index = 0;
  for (; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-') {
      return {
        target: token,
        warning: '`cd -` returns to the previous directory, which cannot be followed statically.',
      };
    }
    if (!token.startsWith('-')) break;
    // pushd -n pushes onto the stack without changing the current directory.
    if (name === 'pushd' && token === '-n') noChange = true;
  }
  if (noChange) return undefined;
  const target = rest[index];
  if (target === undefined) {
    return name === 'pushd'
      ? { warning: '`pushd` without a directory argument swaps the directory stack; the guard could not follow it.' }
      : undefined;
  }
  return { target };
}
