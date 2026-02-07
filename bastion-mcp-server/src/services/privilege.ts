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

/** Commands allowed at Level 0 (read-only). Only the base command is checked. */
const LEVEL_0_ALLOWLIST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'file',
  'stat', 'du', 'df', 'pwd', 'whoami', 'hostname', 'date',
  'env', 'echo', 'git', 'tree', 'which', 'type', 'readlink',
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
  /^rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$/,   // rm -rf /
  /^rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\*\s*$/,  // rm -rf /*
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
];

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

  // Denylist is ALWAYS checked first (all levels)
  for (const pattern of HARDCODED_DENY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Command matches hardcoded denylist: ${pattern.source}` };
    }
  }

  // Check config-provided denylist (all levels)
  if (config?.denyPatterns) {
    for (const pattern of config.denyPatterns) {
      if (new RegExp(pattern).test(trimmed)) {
        return { allowed: false, reason: `Command matches configured deny pattern: ${pattern}` };
      }
    }
  }

  // Level 0: hardcoded allowlist only
  if (privilegeLevel === 0) {
    return validateLevel0(trimmed);
  }

  // Level 1: config-provided regex allowlist
  if (privilegeLevel === 1) {
    return validateLevel1(trimmed, config);
  }

  // Level 2: permissive (passed denylist, so allowed)
  if (privilegeLevel === 2) {
    return { allowed: true, reason: 'Privilege level 2: command passed denylist checks' };
  }

  return { allowed: false, reason: `Unknown privilege level: ${privilegeLevel}` };
}

function validateLevel0(command: string): ValidationResult {
  // Extract the base command (first word, ignoring env var assignments)
  const baseCommand = extractBaseCommand(command);

  if (!baseCommand) {
    return { allowed: false, reason: 'Could not determine base command' };
  }

  if (!LEVEL_0_ALLOWLIST.has(baseCommand)) {
    return {
      allowed: false,
      reason: `Command '${baseCommand}' is not in the Level 0 read-only allowlist`,
    };
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
 * Extract the base command name from a shell command string.
 * Handles env var assignments (e.g., "FOO=bar ls -la" → "ls"),
 * and pipe chains (takes first command).
 */
function extractBaseCommand(command: string): string | null {
  // Take only the first command in a pipe chain
  const firstCmd = command.split('|')[0].trim();

  // Skip env var assignments (KEY=val ...)
  const parts = firstCmd.split(/\s+/);
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
