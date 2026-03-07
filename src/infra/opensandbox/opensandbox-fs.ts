import path from 'path';
import { minimatch } from 'minimatch';
import type { Sandbox as OpenSandboxClient } from '@alibaba-group/opensandbox';
import { SandboxFS } from '../sandbox';

export interface OpenSandboxFSHost {
  workDir: string;
  getOpenSandbox(): OpenSandboxClient;
}

export class OpenSandboxFS implements SandboxFS {
  constructor(private readonly host: OpenSandboxFSHost) {}

  resolve(p: string): string {
    if (path.posix.isAbsolute(p)) return path.posix.normalize(p);
    return path.posix.normalize(path.posix.join(this.host.workDir, p));
  }

  isInside(_p: string): boolean {
    // OpenSandbox runtime is already isolated at container/sandbox level.
    return true;
  }

  async read(p: string): Promise<string> {
    const sandbox = this.host.getOpenSandbox();
    const resolved = this.resolve(p);
    return await sandbox.files.readFile(resolved);
  }

  async write(p: string, content: string): Promise<void> {
    const sandbox = this.host.getOpenSandbox();
    const resolved = this.resolve(p);
    const dir = path.posix.dirname(resolved);
    if (dir && dir !== '/') {
      await sandbox.files.createDirectories([{ path: dir, mode: 0o755 }]).catch(() => undefined);
    }
    await sandbox.files.writeFiles([{ path: resolved, data: content }]);
  }

  temp(name?: string): string {
    const tempName = name || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    return path.posix.join('/tmp', tempName);
  }

  async stat(p: string): Promise<{ mtimeMs: number }> {
    const sandbox = this.host.getOpenSandbox();
    const resolved = this.resolve(p);
    const info = await sandbox.files.getFileInfo([resolved]);
    const fileInfo = info[resolved] || Object.values(info)[0];
    if (!fileInfo) {
      throw new Error(`File not found: ${resolved}`);
    }

    const mtime = this.toTimestamp(
      (fileInfo as any).modifiedAt ??
      (fileInfo as any).modified_at ??
      (fileInfo as any).mtime ??
      (fileInfo as any).updatedAt
    );

    return { mtimeMs: mtime ?? Date.now() };
  }

  async glob(
    pattern: string,
    opts?: { cwd?: string; ignore?: string[]; dot?: boolean; absolute?: boolean }
  ): Promise<string[]> {
    const sandbox = this.host.getOpenSandbox();
    const searchRoot = opts?.cwd ? this.resolve(opts.cwd) : this.host.workDir;
    const items = await sandbox.files.search({
      path: searchRoot,
      pattern,
    });

    const includeDot = opts?.dot ?? false;
    const ignore = opts?.ignore || [];

    const matched = items
      .map((item) => this.resolve(String(item.path || '')))
      .filter((entry) => {
        if (!entry) return false;
        if (!includeDot && this.hasDotPath(entry)) return false;
        if (ignore.length === 0) return true;

        const relToRoot = path.posix.relative(searchRoot, entry);
        const relToWorkDir = path.posix.relative(this.host.workDir, entry);
        return !ignore.some((rule) => {
          return (
            this.matchGlob(rule, relToRoot) ||
            this.matchGlob(rule, relToWorkDir) ||
            this.matchGlob(rule, entry)
          );
        });
      });

    if (opts?.absolute) {
      return matched;
    }

    return matched.map((entry) => path.posix.relative(this.host.workDir, entry));
  }

  private hasDotPath(entry: string): boolean {
    const normalized = entry.replace(/\\/g, '/');
    return normalized.split('/').some((seg) => seg.startsWith('.') && seg.length > 1);
  }

  private toTimestamp(value: unknown): number | undefined {
    if (value == null) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private matchGlob(pattern: string, target: string): boolean {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const normalizedTarget = target.replace(/\\/g, '/');
    return minimatch(normalizedTarget, normalizedPattern, {
      dot: true,
      nocase: false,
      matchBase: false,
    });
  }
}
