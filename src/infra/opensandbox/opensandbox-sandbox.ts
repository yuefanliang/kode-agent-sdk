import {
  ConnectionConfig,
  Sandbox as OpenSandboxClient,
  type ConnectionConfigOptions,
  type SandboxConnectOptions,
  type SandboxCreateOptions,
} from '@alibaba-group/opensandbox';
import { Sandbox, SandboxExecResult, SandboxKind } from '../sandbox';
import { logger } from '../../utils/logger';
import { OpenSandboxFS } from './opensandbox-fs';
import { OpenSandboxOptions, OpenSandboxWatchMode } from './types';

interface PollWatcher {
  kind: 'polling';
  timer: NodeJS.Timeout;
  paths: string[];
  lastMtimes: Map<string, number | undefined>;
  polling: boolean;
  pending: boolean;
}

interface NativeWatcher {
  kind: 'native';
  paths: string[];
  abortController: AbortController;
  streamTask: Promise<void>;
}

type ActiveWatcher = PollWatcher | NativeWatcher;

export class OpenSandbox implements Sandbox {
  kind: SandboxKind = 'opensandbox';
  workDir: string;
  fs: OpenSandboxFS;

  private sandbox: OpenSandboxClient | null = null;
  private readonly options: OpenSandboxOptions;
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly watchMode: OpenSandboxWatchMode;
  private readonly pollIntervalMs: number;
  private readonly disposeAction: 'close' | 'kill';

  constructor(options: OpenSandboxOptions) {
    this.options = { ...options };
    this.workDir = options.workDir || '/workspace';
    this.fs = new OpenSandboxFS(this);
    this.watchMode = options.watch?.mode || 'polling';
    this.pollIntervalMs = Math.max(100, options.watch?.pollIntervalMs ?? 1000);
    this.disposeAction = options.lifecycle?.disposeAction || 'kill';
  }

  async init(): Promise<void> {
    if (this.sandbox) return;

    const connectionConfig = this.buildConnectionConfig();

    if (this.options.sandboxId) {
      const connectOptions: SandboxConnectOptions = {
        sandboxId: this.options.sandboxId,
        connectionConfig,
        skipHealthCheck: this.options.skipHealthCheck,
        readyTimeoutSeconds: this.options.readyTimeoutSeconds,
        healthCheckPollingInterval: this.options.healthCheckPollingInterval,
      };
      this.sandbox = await OpenSandboxClient.connect(connectOptions);
    } else {
      const createOptions: SandboxCreateOptions = {
        connectionConfig,
        image: this.options.image || this.options.template || 'ubuntu',
        timeoutSeconds: Math.max(1, Math.ceil((this.options.timeoutMs ?? 10 * 60 * 1000) / 1000)),
        env: this.options.env,
        metadata: this.options.metadata,
        resource: this.options.resource,
        networkPolicy: this.options.networkPolicy as any,
        skipHealthCheck: this.options.skipHealthCheck,
        readyTimeoutSeconds: this.options.readyTimeoutSeconds,
        healthCheckPollingInterval: this.options.healthCheckPollingInterval,
      };
      this.sandbox = await OpenSandboxClient.create(createOptions);
    }

    // Persist resolved sandbox id for Agent resume metadata.
    this.options.sandboxId = this.sandbox.id;

    // Best-effort workdir bootstrap.
    if (this.workDir && this.workDir !== '/') {
      await this.sandbox.commands
        .run(`mkdir -p ${quoteShell(this.workDir)}`, {
          workingDirectory: '/',
          timeoutSeconds: 10,
        })
        .catch(() => undefined);
    }
  }

  getOpenSandbox(): OpenSandboxClient {
    if (!this.sandbox) {
      throw new Error('OpenSandbox not initialized. Call init() first.');
    }
    return this.sandbox;
  }

  getSandboxId(): string | undefined {
    return this.sandbox?.id || this.options.sandboxId;
  }

  async isRunning(): Promise<boolean> {
    try {
      const info = await this.getOpenSandbox().getInfo();
      const state = String((info as any)?.status?.state || '').toLowerCase();
      return state === 'running';
    } catch {
      return false;
    }
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult> {
    const sandbox = this.getOpenSandbox();
    const timeoutMs = this.resolveExecTimeoutMs(opts);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

    try {
      const execution = await sandbox.commands.run(cmd, {
        workingDirectory: this.workDir,
        timeoutSeconds,
      });

      const stdout = execution.logs.stdout.map((m) => m.text).join('');
      let stderr = execution.logs.stderr.map((m) => m.text).join('');
      let code = execution.error ? 1 : 0;

      if (execution.id) {
        try {
          const status = await sandbox.commands.getCommandStatus(execution.id);
          if (typeof status.exitCode === 'number') {
            code = status.exitCode;
          } else if (status.running === false && status.error) {
            code = 1;
          }
        } catch {
          // keep fallback code when status API is unavailable
        }
      }

      if (execution.error && !stderr) {
        const traces = Array.isArray(execution.error.traceback) ? execution.error.traceback.join('\n') : '';
        stderr = [execution.error.name, execution.error.value, traces].filter(Boolean).join('\n');
      }

      return { code, stdout, stderr };
    } catch (error: any) {
      return {
        code: 1,
        stdout: '',
        stderr: error?.message || String(error),
      };
    }
  }

  async watchFiles(
    paths: string[],
    listener: (event: { path: string; mtimeMs: number }) => void
  ): Promise<string> {
    if (this.watchMode === 'off') {
      return `watch-disabled-${Date.now()}`;
    }

    const id = `opensandbox-watch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const resolved = Array.from(new Set(paths.map((p) => this.fs.resolve(p))));

    if (this.watchMode === 'native') {
      const nativeStarted = await this.startNativeWatcher(id, resolved, listener);
      if (nativeStarted) {
        return id;
      }
      logger.warn('[OpenSandbox] native watch unavailable, falling back to polling mode.');
    }

    await this.startPollingWatcher(id, resolved, listener);
    return id;
  }

  unwatchFiles(id: string): void {
    const watcher = this.watchers.get(id);
    if (!watcher) return;

    if (watcher.kind === 'polling') {
      clearInterval(watcher.timer);
    } else {
      watcher.abortController.abort();
    }

    this.watchers.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of Array.from(this.watchers.keys())) {
      this.unwatchFiles(id);
    }

    if (!this.sandbox) return;

    let disposeError: unknown;
    const sandbox = this.sandbox;
    this.sandbox = null;

    if (this.disposeAction === 'kill') {
      try {
        await sandbox.kill();
      } catch (error) {
        disposeError = error;
      }
    }

    try {
      await sandbox.close();
    } catch (error) {
      disposeError = disposeError || error;
    }

    if (disposeError) {
      throw disposeError;
    }
  }

  private buildConnectionConfig(): ConnectionConfig {
    const config: ConnectionConfigOptions = {
      apiKey: this.options.apiKey,
      domain: this.options.endpoint || this.options.domain,
      protocol: this.options.protocol,
      requestTimeoutSeconds: this.options.requestTimeoutSeconds,
      useServerProxy: this.options.useServerProxy ?? false,
    };
    return new ConnectionConfig(config);
  }

  private async pollWatcher(
    id: string,
    listener: (event: { path: string; mtimeMs: number }) => void
  ): Promise<void> {
    const watcher = this.watchers.get(id);
    if (!watcher || watcher.kind !== 'polling' || watcher.polling) return;
    watcher.polling = true;

    try {
      do {
        watcher.pending = false;

        for (const path of watcher.paths) {
          if (!this.watchers.has(id)) {
            return;
          }

          const current = await this.safeMtime(path);
          const previous = watcher.lastMtimes.get(path);
          watcher.lastMtimes.set(path, current);

          if (previous === undefined && current === undefined) continue;
          if (previous === current) continue;

          listener({ path, mtimeMs: current ?? Date.now() });
        }
      } while (this.watchers.has(id) && watcher.pending);
    } finally {
      if (this.watchers.get(id) === watcher) {
        watcher.polling = false;
      }
    }
  }

  private async safeMtime(path: string): Promise<number | undefined> {
    try {
      const stat = await this.fs.stat(path);
      return stat.mtimeMs;
    } catch {
      return undefined;
    }
  }

  private resolveExecTimeoutMs(opts?: { timeoutMs?: number }): number {
    return opts?.timeoutMs ?? this.options.execTimeoutMs ?? this.options.timeoutMs ?? 120000;
  }

  private async startPollingWatcher(
    id: string,
    paths: string[],
    listener: (event: { path: string; mtimeMs: number }) => void
  ): Promise<void> {
    const lastMtimes = new Map<string, number | undefined>();
    for (const p of paths) {
      lastMtimes.set(p, await this.safeMtime(p));
    }

    const watcher: PollWatcher = {
      kind: 'polling',
      timer: setInterval(() => {
        const current = this.watchers.get(id);
        if (!current || current.kind !== 'polling') return;
        current.pending = true;
        if (!current.polling) {
          void this.pollWatcher(id, listener);
        }
      }, this.pollIntervalMs),
      paths,
      lastMtimes,
      polling: false,
      pending: true,
    };

    this.watchers.set(id, watcher);
    void this.pollWatcher(id, listener);
  }

  private async startNativeWatcher(
    id: string,
    paths: string[],
    listener: (event: { path: string; mtimeMs: number }) => void
  ): Promise<boolean> {
    const probe = await this.exec('command -v inotifywait >/dev/null 2>&1 && echo __KODE_INOTIFY_READY__', {
      timeoutMs: 5000,
    });
    if (probe.code !== 0 || !probe.stdout.includes('__KODE_INOTIFY_READY__')) {
      return false;
    }

    const sandbox = this.getOpenSandbox();
    const abortController = new AbortController();
    const nativeWatchCommand = buildNativeWatchCommand(paths);
    let stdoutBuffer = '';

    const streamTask = (async () => {
      try {
        for await (const event of sandbox.commands.runStream(
          nativeWatchCommand,
          { workingDirectory: this.workDir },
          abortController.signal
        )) {
          if (abortController.signal.aborted) {
            break;
          }
          if (event.type !== 'stdout' || typeof event.text !== 'string') {
            continue;
          }

          stdoutBuffer += event.text;
          let lineBreak = stdoutBuffer.indexOf('\n');
          while (lineBreak >= 0) {
            const line = stdoutBuffer.slice(0, lineBreak).trim();
            stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
            if (line) {
              listener({ path: line, mtimeMs: Date.now() });
            }
            lineBreak = stdoutBuffer.indexOf('\n');
          }
        }

        const tail = stdoutBuffer.trim();
        if (tail) {
          listener({ path: tail, mtimeMs: Date.now() });
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          logger.warn('[OpenSandbox] native watch stream failed, fallback to polling.', error);
        }
      } finally {
        const current = this.watchers.get(id);
        if (!current || current.kind !== 'native' || current.abortController !== abortController) {
          return;
        }

        this.watchers.delete(id);
        if (!abortController.signal.aborted) {
          try {
            await this.startPollingWatcher(id, paths, listener);
            logger.warn('[OpenSandbox] native watch stopped, switched to polling mode.');
          } catch (error) {
            logger.warn('[OpenSandbox] failed to start polling fallback after native watch exit.', error);
          }
        }
      }
    })();

    const watcher: NativeWatcher = {
      kind: 'native',
      paths,
      abortController,
      streamTask,
    };
    this.watchers.set(id, watcher);
    return true;
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildNativeWatchCommand(paths: string[]): string {
  const targets = paths.map((p) => quoteShell(p)).join(' ');
  const script = `exec inotifywait -m -e modify,create,delete,move --format '%w%f' -- ${targets}`;
  return `sh -lc ${quoteShell(script)}`;
}
