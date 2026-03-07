import { TestRunner, expect } from '../../helpers/utils';
import { OpenSandbox } from '../../../src/infra/opensandbox/opensandbox-sandbox';

const runner = new TestRunner('OpenSandbox (Mock)');

function createMockSandbox() {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  let killed = false;
  let closed = false;
  let nativeReady = false;
  let nativeEvents: string[] = [];

  return {
    setNativeWatcher(opts: { ready: boolean; events?: string[] }) {
      nativeReady = opts.ready;
      nativeEvents = opts.events || [];
    },
    id: 'sbx-test-001',
    commands: {
      run: async (cmd: string, _opts?: any) => {
        if (cmd.includes('__KODE_INOTIFY_READY__')) {
          return {
            id: 'cmd-native-probe',
            logs: {
              stdout: nativeReady ? [{ text: '__KODE_INOTIFY_READY__\n', timestamp: Date.now() }] : [],
              stderr: [],
            },
            result: [],
          };
        }
        if (cmd === 'echo hello') {
          return {
            id: 'cmd-1',
            logs: { stdout: [{ text: 'hello\n', timestamp: Date.now() }], stderr: [] },
            result: [],
          };
        }
        if (cmd === 'boom') {
          throw new Error('command failed');
        }
        return {
          id: 'cmd-2',
          logs: { stdout: [], stderr: [] },
          result: [],
          error: { name: 'RuntimeError', value: 'failed', timestamp: Date.now(), traceback: [] },
        };
      },
      runStream: async function* (_cmd: string, _opts?: any, signal?: AbortSignal) {
        for (const path of nativeEvents) {
          yield { type: 'stdout', text: `${path}\n`, timestamp: Date.now() } as any;
        }
        while (!signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      getCommandStatus: async (_id: string) => ({ exitCode: 0 }),
    },
    files: {
      readFile: async (path: string) => {
        const entry = files.get(path);
        if (!entry) throw new Error(`File not found: ${path}`);
        return entry.content;
      },
      writeFiles: async (entries: Array<{ path: string; data?: any }>) => {
        for (const entry of entries) {
          files.set(entry.path, { content: String(entry.data ?? ''), mtimeMs: Date.now() });
        }
      },
      createDirectories: async (_entries: any[]) => undefined,
      getFileInfo: async (paths: string[]) => {
        const out: Record<string, any> = {};
        for (const p of paths) {
          const entry = files.get(p);
          if (entry) {
            out[p] = { path: p, modifiedAt: new Date(entry.mtimeMs) };
          }
        }
        return out;
      },
      search: async (entry: { path: string }) => {
        return Array.from(files.keys())
          .filter((p) => p.startsWith(entry.path))
          .map((path) => ({ path }));
      },
    },
    getInfo: async () => ({ status: { state: 'Running' } }),
    kill: async () => {
      killed = true;
    },
    close: async () => {
      closed = true;
    },
    _state: {
      files,
      isKilled: () => killed,
      isClosed: () => closed,
      touch(path: string) {
        const prev = files.get(path);
        files.set(path, { content: prev?.content || '', mtimeMs: Date.now() });
      },
    },
  };
}

runner
  .test('kind 和默认参数正确', async () => {
    const sandbox = new OpenSandbox({ kind: 'opensandbox' });
    expect.toEqual(sandbox.kind, 'opensandbox');
    expect.toEqual(sandbox.workDir, '/workspace');
  })
  .test('exec 返回成功结果', async () => {
    const sandbox = new OpenSandbox({ kind: 'opensandbox' });
    (sandbox as any).sandbox = createMockSandbox();
    const result = await sandbox.exec('echo hello');
    expect.toEqual(result.code, 0);
    expect.toContain(result.stdout, 'hello');
  })
  .test('exec 捕获异常并返回 code=1', async () => {
    const sandbox = new OpenSandbox({ kind: 'opensandbox' });
    (sandbox as any).sandbox = createMockSandbox();
    const result = await sandbox.exec('boom');
    expect.toEqual(result.code, 1);
    expect.toContain(result.stderr, 'command failed');
  })
  .test('watch mode=off 时返回 disabled id', async () => {
    const sandbox = new OpenSandbox({
      kind: 'opensandbox',
      watch: { mode: 'off' },
    });
    (sandbox as any).sandbox = createMockSandbox();
    const id = await sandbox.watchFiles(['a.txt'], () => undefined);
    expect.toContain(id, 'watch-disabled-');
  })
  .test('polling watcher 能感知 mtime 变化', async () => {
    const mock = createMockSandbox();
    await mock.files.writeFiles([{ path: '/workspace/a.txt', data: '1' }]);

    const sandbox = new OpenSandbox({
      kind: 'opensandbox',
      watch: { mode: 'polling', pollIntervalMs: 50 },
    });
    (sandbox as any).sandbox = mock;

    let changed = false;
    const id = await sandbox.watchFiles(['a.txt'], () => {
      changed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    mock._state.touch('/workspace/a.txt');
    await new Promise((resolve) => setTimeout(resolve, 120));

    sandbox.unwatchFiles(id);
    expect.toEqual(changed, true);
  })
  .test('native watcher 可用时会收到流式文件变更事件', async () => {
    const mock = createMockSandbox();
    mock.setNativeWatcher({
      ready: true,
      events: ['/workspace/native-a.txt', '/workspace/native-b.txt'],
    });

    const sandbox = new OpenSandbox({
      kind: 'opensandbox',
      watch: { mode: 'native', pollIntervalMs: 50 },
    });
    (sandbox as any).sandbox = mock;

    const changed: string[] = [];
    const id = await sandbox.watchFiles(['native-a.txt'], (event) => {
      changed.push(event.path);
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    sandbox.unwatchFiles(id);

    expect.toContain(changed, '/workspace/native-a.txt');
    expect.toContain(changed, '/workspace/native-b.txt');
  })
  .test('native watcher 不可用时会自动回退到 polling', async () => {
    const mock = createMockSandbox();
    mock.setNativeWatcher({ ready: false });
    await mock.files.writeFiles([{ path: '/workspace/fallback.txt', data: '1' }]);

    const sandbox = new OpenSandbox({
      kind: 'opensandbox',
      watch: { mode: 'native', pollIntervalMs: 50 },
    });
    (sandbox as any).sandbox = mock;

    let changed = false;
    const id = await sandbox.watchFiles(['fallback.txt'], () => {
      changed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    mock._state.touch('/workspace/fallback.txt');
    await new Promise((resolve) => setTimeout(resolve, 120));

    sandbox.unwatchFiles(id);
    expect.toEqual(changed, true);
  })
  .test('disposeAction=kill 时会 kill + close', async () => {
    const mock = createMockSandbox();
    const sandbox = new OpenSandbox({
      kind: 'opensandbox',
      lifecycle: { disposeAction: 'kill' },
    });
    (sandbox as any).sandbox = mock;
    await sandbox.dispose();
    expect.toEqual(mock._state.isKilled(), true);
    expect.toEqual(mock._state.isClosed(), true);
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
