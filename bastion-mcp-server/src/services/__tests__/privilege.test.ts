import { describe, it, expect } from 'vitest';
import { validateCommand, getCommandAllowlist } from '../privilege.js';

describe('Privilege validation', () => {
  describe('Level 0 (read-only)', () => {
    it('allows basic read commands', () => {
      expect(validateCommand('ls -la', 0).allowed).toBe(true);
      expect(validateCommand('cat /etc/hostname', 0).allowed).toBe(true);
      expect(validateCommand('grep -r pattern .', 0).allowed).toBe(true);
      expect(validateCommand('find . -name "*.ts"', 0).allowed).toBe(true);
      expect(validateCommand('wc -l file.txt', 0).allowed).toBe(true);
      expect(validateCommand('head -20 file.txt', 0).allowed).toBe(true);
      expect(validateCommand('tail -f log.txt', 0).allowed).toBe(true);
    });

    it('allows read-only git subcommands', () => {
      expect(validateCommand('git status', 0).allowed).toBe(true);
      expect(validateCommand('git diff', 0).allowed).toBe(true);
      expect(validateCommand('git log --oneline', 0).allowed).toBe(true);
      expect(validateCommand('git show HEAD', 0).allowed).toBe(true);
      expect(validateCommand('git branch -a', 0).allowed).toBe(true);
    });

    it('denies write git subcommands', () => {
      expect(validateCommand('git push', 0).allowed).toBe(false);
      expect(validateCommand('git commit -m "test"', 0).allowed).toBe(false);
      expect(validateCommand('git checkout main', 0).allowed).toBe(false);
      expect(validateCommand('git reset --hard', 0).allowed).toBe(false);
    });

    it('denies non-allowlisted commands', () => {
      expect(validateCommand('curl http://example.com', 0).allowed).toBe(false);
      expect(validateCommand('wget http://example.com', 0).allowed).toBe(false);
      expect(validateCommand('rm file.txt', 0).allowed).toBe(false);
      expect(validateCommand('python3 -c "print(1)"', 0).allowed).toBe(false);
    });

    it('denies rm -rf / at all levels', () => {
      expect(validateCommand('rm -rf /', 0).allowed).toBe(false);
      expect(validateCommand('rm -rf /', 1).allowed).toBe(false);
      expect(validateCommand('rm -rf /', 2).allowed).toBe(false);
    });
  });

  describe('Level 1 (configured)', () => {
    const config = {
      allowPatterns: ['npm\\s+', 'node\\s+', 'python3\\s+'],
      denyPatterns: ['rm\\s+-rf'],
    };

    it('allows commands matching configured patterns', () => {
      expect(validateCommand('npm test', 1, config).allowed).toBe(true);
      expect(validateCommand('node script.js', 1, config).allowed).toBe(true);
      expect(validateCommand('python3 -c "print(1)"', 1, config).allowed).toBe(true);
    });

    it('denies commands not matching configured patterns', () => {
      expect(validateCommand('curl http://example.com', 1, config).allowed).toBe(false);
    });

    it('denylist always blocks even if allow pattern matches', () => {
      expect(validateCommand('rm -rf /tmp/test', 1, config).allowed).toBe(false);
    });

    it('rejects when no allow patterns configured', () => {
      expect(validateCommand('ls', 1).allowed).toBe(false);
    });
  });

  describe('Level 2 (permissive)', () => {
    it('allows most commands', () => {
      expect(validateCommand('curl http://example.com', 2).allowed).toBe(true);
      expect(validateCommand('npm install express', 2).allowed).toBe(true);
      expect(validateCommand('docker ps', 2).allowed).toBe(true);
    });

    it('still blocks hardcoded denylist', () => {
      expect(validateCommand('rm -rf /', 2).allowed).toBe(false);
      expect(validateCommand('mkfs.ext4 /dev/sda', 2).allowed).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('rejects empty command', () => {
      expect(validateCommand('', 0).allowed).toBe(false);
      expect(validateCommand('   ', 0).allowed).toBe(false);
    });

    it('rejects unknown privilege level', () => {
      expect(validateCommand('ls', 5).allowed).toBe(false);
    });
  });

  describe('getCommandAllowlist', () => {
    it('returns sorted Level 0 allowlist', () => {
      const list = getCommandAllowlist(0);
      expect(list).toContain('ls');
      expect(list).toContain('cat');
      expect(list).toContain('git');
      expect(list).toEqual([...list].sort());
    });

    it('returns configured patterns for Level 1', () => {
      const config = { allowPatterns: ['npm\\s+', 'node\\s+'] };
      const list = getCommandAllowlist(1, config);
      expect(list).toEqual(['npm\\s+', 'node\\s+']);
    });

    it('returns wildcard for Level 2', () => {
      expect(getCommandAllowlist(2)).toEqual(['*']);
    });
  });
});
