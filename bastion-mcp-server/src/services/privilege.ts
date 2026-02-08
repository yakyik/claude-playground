/**
 * Privilege tier validation for command execution.
 *
 * Three privilege levels control which commands can be run:
 *   - Level 0 (read-only): Hardcoded allowlist of safe, read-only commands
 *   - Level 1 (configured): Config-provided regex allowlist + denylist
 *   - Level 2 (permissive): Allow all except denylist
 *
 * The denylist is ALWAYS checked regardless of privilege level.
 */

export interface PrivilegeConfig {
  /** Regex patterns for Level 1 allowlist (anchored with ^) */
  allowPatterns?: string[];
  /** Regex patterns for denylist (always blocked at all levels) */
  denyPatterns?: string[];
}

export interface ValidationResult {
  allowed: boolean;
  reason: string;
}

/** Commands allowed at Level 0 (read-only). Only the base command is checked.
 * NOTE: `env` removed — leaks BASTION_JWT_SECRET/BASTION_API_KEY.
 * NOTE: `echo` removed — shell expansion ($(), backticks) can be abused.
 */
const LEVEL_0_ALLOWLIST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'file',
  'stat', 'du', 'df', 'pwd', 'whoami', 'hostname', 'date',
  'git', 'tree', 'which', 'type', 'readlink',
  'basename', 'dirname', 'realpath', 'sha256sum', 'md5sum',
]);

/** Git subcommands allowed at Level 0 (read-only git operations) */
const LEVEL_0_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag', 'remote',
  'rev-parse', 'describe', 'shortlog', 'blame', 'ls-files',
  'ls-tree', 'cat-file',
]);

/** Patterns that are ALWAYS denied regardless of privilege level */
const HARDCODED_DENY_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$/,   // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\*\s*$/,  // rm -rf /*
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\{\s*:\|:&\s*\};:/,                       // fork bomb
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
  /\bsystemctl\s+(poweroff|reboot|halt)\b/,
  /\bchmod\s+(-[a-zA-Z]*\s+)*[0-7]*777\s+\//,   // chmod 777 /
  /\bchown\s+.*\s+\/\s*$/,                        // chown ... /
  />\s*\/dev\/sd/,                                 // redirect to block device
  /\bcurl\b.*\|\s*(ba)?sh/,                       // curl | sh
  /\bwget\b.*\|\s*(ba)?sh/,                       // wget | sh
  /\bbase64\b.*\|\s*(ba)?sh/,                     // base64 -d | sh
  /\bcurl\b.*-o\s+\S+.*&&\s*(ba)?sh\b/,          // curl -o file && sh file
  /\bwget\b.*-O\s+\S+.*&&\s*(ba)?sh\b/,          // wget -O file && sh file
];

/**
 * Patterns indicating shell metacharacters that chain multiple commands.
 * At Level 0 and Level 1, commands containing these are split and each
 * segment is validated independently. Subshell expansion is blocked outright.
 */
const SHELL_EXPANSION_PATTERNS = [
  /\$\(/,           // $(...) command substitution
  /`[^`]+`/,        // backtick command substitution
];

/**
 * Patterns that indicate dangerous pipe targets.
 * At Level 0 and Level 1, piped commands are split and each segment
 * is validated. As a catch-all, piping into interpreters is always denied.
 */
const DANGEROUS_PIPE_TARGETS = /\|\s*(ba)?sh\b|\|\s*python3?\b|\|\s*perl\b|\|\s*ruby\b|\|\s*node\b|\|\s*xargs\b/;

/** find arguments that allow arbitrary command execution */
const FIND_EXEC_PATTERN = /\s-(exec|execdir|ok|okdir)\s/;

/**
 * Validate whether a command is allowed at the given privilege level.
 */
export function validateCommand(
  command: string,
  privilegeLevel: number,
  config?: PrivilegeConfig
): ValidationResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { allowed: false, reason: 'Empty command' };
  }

  // At Level 0 and 1, block command substitution outright ($(), backticks)
  if (privilegeLevel <= 1) {
    for (const pattern of SHELL_EXPANSION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command contains shell expansion (${pattern.source}), which is not allowed at privilege level ${privilegeLevel}`,
        };
      }
    }
  }

  // At Level 0 and 1, split on shell chaining operators and validate each segment
  if (privilegeLevel <= 1) {
    const segments = splitShellSegments(trimmed);
    if (segments.length > 1) {
      for (const segment of segments) {
        const segResult = validateSingleCommand(segment.trim(), privilegeLevel, config);
        if (!segResult.allowed) {
          return {
            allowed: false,
            reason: `Chained command denied — segment '${segment.trim()}': ${segResult.reason}`,
          };
        }
      }
      return { allowed: true, reason: 'All chained command segments are allowed' };
    }
  }

  return validateSingleCommand(trimmed, privilegeLevel, config);
}

/**
 * Validate a single command (no chaining operators) against denylist and privilege level.
 */
function validateSingleCommand(
  command: string,
  privilegeLevel: number,
  config?: PrivilegeConfig
): ValidationResult {
  if (!command) {
    return { allowed: false, reason: 'Empty command segment' };
  }

  // Denylist is ALWAYS checked first (all levels)
  for (const pattern of HARDCODED_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Command matches hardcoded denylist: ${pattern.source}` };
    }
  }

  // Check config-provided denylist (all levels)
  if (config?.denyPatterns) {
    for (const pattern of config.denyPatterns) {
      if (new RegExp(pattern).test(command)) {
        return { allowed: false, reason: `Command matches configured deny pattern: ${pattern}` };
      }
    }
  }

  // Level 0: hardcoded allowlist only
  if (privilegeLevel === 0) {
    return validateLevel0(command);
  }

  // Level 1: config-provided regex allowlist
  if (privilegeLevel === 1) {
    return validateLevel1(command, config);
  }

  // Level 2: permissive (passed denylist, so allowed)
  if (privilegeLevel === 2) {
    return { allowed: true, reason: 'Privilege level 2: command passed denylist checks' };
  }

  return { allowed: false, reason: `Unknown privilege level: ${privilegeLevel}` };
}

/**
 * Split a command string on shell chaining operators: ;  &&  ||
 * Pipe (|) is validated separately in validateLevel0.
 */
function splitShellSegments(command: string): string[] {
  // Split on ; && || but not inside quotes (simplified — handles common cases)
  return command.split(/\s*(?:;|&&|\|\|)\s*/).filter(Boolean);
}

function validateLevel0(command: string): ValidationResult {
  // Block dangerous pipe targets (piping into interpreters like sh, bash, python, xargs)
  if (DANGEROUS_PIPE_TARGETS.test(command)) {
    return {
      allowed: false,
      reason: 'Command pipes into a dangerous target (interpreter/xargs), which is not allowed at Level 0',
    };
  }

  // Validate all pipe segments — every command in the pipeline must be allowlisted
  const pipeSegments = command.split('|').map((s) => s.trim()).filter(Boolean);
  for (const segment of pipeSegments) {
    const segBase = extractBaseCommandFromSegment(segment);
    if (!segBase) {
      return { allowed: false, reason: `Could not determine base command in pipe segment: '${segment}'` };
    }
    if (!LEVEL_0_ALLOWLIST.has(segBase)) {
      return {
        allowed: false,
        reason: `Pipe target '${segBase}' is not in the Level 0 read-only allowlist`,
      };
    }
  }

  // Extract the base command from the first segment for further checks
  const baseCommand = extractBaseCommandFromSegment(pipeSegments[0]);
  if (!baseCommand) {
    return { allowed: false, reason: 'Could not determine base command' };
  }

  // Special handling for git: check subcommand
  if (baseCommand === 'git') {
    const gitSubcommand = extractGitSubcommand(command);
    if (gitSubcommand && !LEVEL_0_GIT_SUBCOMMANDS.has(gitSubcommand)) {
      return {
        allowed: false,
        reason: `Git subcommand '${gitSubcommand}' is not allowed at Level 0 (read-only)`,
      };
    }
  }

  // Special handling for find: block -exec/-execdir/-ok/-okdir
  if (baseCommand === 'find' && FIND_EXEC_PATTERN.test(command)) {
    return {
      allowed: false,
      reason: 'find with -exec/-execdir is not allowed at Level 0 (read-only)',
    };
  }

  return { allowed: true, reason: 'Command is in Level 0 read-only allowlist' };
}

function validateLevel1(
  command: string,
  config?: PrivilegeConfig
): ValidationResult {
  if (!config?.allowPatterns || config.allowPatterns.length === 0) {
    return {
      allowed: false,
      reason: 'Privilege level 1 requires configured allow patterns, but none are set',
    };
  }

  for (const pattern of config.allowPatterns) {
    if (new RegExp(`^${pattern}`).test(command)) {
      return {
        allowed: true,
        reason: `Command matches configured allow pattern: ${pattern}`,
      };
    }
  }

  return {
    allowed: false,
    reason: 'Command does not match any configured Level 1 allow patterns',
  };
}

/**
 * Extract the base command name from a single command segment (no pipes).
 * Handles env var assignments (e.g., "FOO=bar ls -la" → "ls").
 */
function extractBaseCommandFromSegment(segment: string): string | null {
  const parts = segment.split(/\s+/);
  for (const part of parts) {
    if (!part.includes('=') || part.startsWith('-')) {
      return part;
    }
  }
  return null;
}

function extractGitSubcommand(command: string): string | null {
  const match = command.match(/\bgit\s+([a-z-]+)/);
  return match ? match[1] : null;
}

/**
 * Returns the allowlist for a given privilege level.
 */
export function getCommandAllowlist(
  privilegeLevel: number,
  config?: PrivilegeConfig
): string[] {
  if (privilegeLevel === 0) {
    return [...LEVEL_0_ALLOWLIST].sort();
  }
  if (privilegeLevel === 1) {
    return config?.allowPatterns ?? [];
  }
  return ['*'];
}
