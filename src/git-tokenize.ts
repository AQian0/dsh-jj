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
const MAX_NESTING = 6;

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
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'fi', 'done', 'while', 'until', 'for', 'case', 'esac', 'if']);

/** Multi-call wrappers whose inner command cannot be resolved statically. */
const DYNAMIC_WRAPPERS = new Set(['busybox', 'toybox', 'unbuffer', 'parallel']);

const WRAPPER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sudo: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user'],
  doas: ['-u', '-C'],
  env: ['-u', '--unset', '-S', '--split-string', '-C', '--chdir'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-n', '-P', '-d', '-E', '-s', '-a', '-L', '--arg-file', '--max-args', '--max-procs', '--delimiter', '--eof', '--max-chars', '--replace'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  command: [],
});

/**
 * The nested command line a shell wrapper would execute (`bash -c …`,
 * `pwsh -Command …`, `cmd /c …`, `fish -c …`).
 */
function shellWrapperInnerCommand(name: string, rest: readonly string[]): string | undefined {
  if (BASH_LIKE_SHELLS.has(name)) {
    const index = rest.findIndex((token) => token === '-c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    return index >= 0 ? rest[index + 1] : undefined;
  }
  const lower = name.toLowerCase();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (lower === 'cmd' || lower === 'cmd.exe') {
      if (/^\/[cC]$/.test(token)) return rest[index + 1];
      continue;
    }
    if (token === '-c' || token === '-Command' || token === '-command') return rest[index + 1];
  }
  return undefined;
}

/** The command line carried by `env -S`/`--split-string`. */
function envSplitString(rest: readonly string[]): string | undefined {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token === '-S' || token === '--split-string') return rest[index + 1];
    const match = /^(?:-S|--split-string)=(.*)$/.exec(token);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * Nested command lines carried by one segment: shell wrapper `-c` arguments and
 * `env -S` split strings. Their text is re-tokenized so the wrapped Git/jj
 * command is classified.
 */
export function nestedCommandStrings(segment: RawSegment): string[] {
  const program = segment.words[0]?.value;
  if (program === undefined) return [];
  const name = baseName(program);
  const nested: string[] = [];
  if (SHELL_WRAPPERS.has(name)) {
    const inner = shellWrapperInnerCommand(name, segment.words.slice(1).map((token) => token.value));
    if (inner !== undefined && inner.length > 0) nested.push(inner);
  }
  if (name === 'env') {
    const split = envSplitString(segment.words.slice(1).map((token) => token.value));
    if (split !== undefined && split.length > 0) nested.push(split);
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
function consumeHeredocBodies(commandLine: string, start: number, heredocs: readonly HeredocSpec[]): number | undefined {
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
export function tokenize(commandLine: string, kind: 'command' | 'substitution', nesting: number): { segments: RawSegment[]; warnings: string[] } {
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
export function scanArgs(args: readonly string[], valueFlags: readonly string[]): { flags: string[]; positionals: string[] } {
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

/** Skip leading `VAR=value` assignments, shell keywords, wrapper commands, and shell wrappers; returns the program index. */

export function skipPrelude(words: readonly Token[], warnings: string[]): number {
  let index = 0;
  for (;;) {
    while (index < words.length && isAssignment(words[index]?.value ?? '')) index += 1;
    const head = words[index]?.value;
    if (head === undefined) return index;
    const name = baseName(head);
    if (SHELL_KEYWORDS.has(name)) {
      index += 1;
      continue;
    }
    if (SHELL_WRAPPERS.has(name)) {
      const inner = shellWrapperInnerCommand(name, words.slice(index + 1).map((token) => token.value));
      if (inner !== undefined && inner.length > 0) {
        warnings.push(...tokenize(inner, 'substitution', MAX_NESTING).warnings);
      }
      return index;
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
        index += eq < 0 && valueFlags.includes(flag) ? 2 : 1;
        continue;
      }
      break;
    }
    if (name === 'timeout' && index < words.length && !(words[index]?.value ?? '').startsWith('-')) index += 1;
  }
  return index;
}
