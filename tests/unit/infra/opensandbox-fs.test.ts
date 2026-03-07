import { TestRunner, expect } from '../../helpers/utils';
import { OpenSandboxFS, OpenSandboxFSHost } from '../../../src/infra/opensandbox/opensandbox-fs';

const runner = new TestRunner('OpenSandboxFS');

function createMockHost(workDir = '/workspace') {
  const state = {
    files: new Map<string, string>(),
    mtime: new Map<string, number>(),
    searched: [] as Array<{ path: string; pattern?: string }>,
  };

  const sandbox = {
    files: {
      readFile: async (path: string) => {
        if (!state.files.has(path)) {
          throw new Error(`File not found: ${path}`);
        }
        return state.files.get(path)!;
      },
      writeFiles: async (entries: Array<{ path: string; data?: any }>) => {
        for (const entry of entries) {
          state.files.set(entry.path, String(entry.data ?? ''));
          state.mtime.set(entry.path, Date.now());
        }
      },
      createDirectories: async (_entries: any[]) => undefined,
      getFileInfo: async (paths: string[]) => {
        const out: Record<string, any> = {};
        for (const p of paths) {
          if (state.files.has(p)) {
            out[p] = {
              path: p,
              modifiedAt: new Date(state.mtime.get(p) || Date.now()),
            };
          }
        }
        return out;
      },
      search: async (entry: { path: string; pattern?: string }) => {
        state.searched.push(entry);
        return Array.from(state.files.keys())
          .filter((p) => p.startsWith(entry.path))
          .map((p) => ({ path: p }));
      },
    },
  };

  const host: OpenSandboxFSHost = {
    workDir,
    getOpenSandbox: () => sandbox as any,
  };

  return { host, state };
}

runner
  .test('resolve 处理相对/绝对路径', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    expect.toEqual(fs.resolve('a/b.txt'), '/workspace/a/b.txt');
    expect.toEqual(fs.resolve('/tmp/a.txt'), '/tmp/a.txt');
  })
  .test('read/write 可读写文件内容', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('a.txt', 'hello');
    const text = await fs.read('a.txt');
    expect.toEqual(text, 'hello');
  })
  .test('stat 返回 mtimeMs', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('mtime.txt', 'x');
    const stat = await fs.stat('mtime.txt');
    expect.toBeTruthy(stat.mtimeMs > 0);
  })
  .test('glob 支持 absolute=false 返回相对路径', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('a.txt', '1');
    await fs.write('dir/b.txt', '2');
    const paths = await fs.glob('**/*.txt');
    expect.toContain(paths, 'a.txt');
    expect.toContain(paths, 'dir/b.txt');
  })
  .test('glob 支持 ignore', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('keep/a.txt', '1');
    await fs.write('skip/b.txt', '2');
    const paths = await fs.glob('**/*.txt', { ignore: ['skip/**'] });
    expect.toContain(paths, 'keep/a.txt');
    expect.toBeFalsy(paths.includes('skip/b.txt'));
  })
  .test('glob ignore 支持 brace 模式', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('src/a.test.ts', '1');
    await fs.write('src/b.test.js', '2');
    await fs.write('src/c.ts', '3');
    const paths = await fs.glob('**/*', { ignore: ['**/*.test.{ts,js}'] });
    expect.toBeFalsy(paths.includes('src/a.test.ts'));
    expect.toBeFalsy(paths.includes('src/b.test.js'));
    expect.toContain(paths, 'src/c.ts');
  })
  .test('glob dot 选项控制隐藏文件可见性', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('.secret.txt', '1');
    await fs.write('normal.txt', '2');
    const hiddenOff = await fs.glob('**/*.txt');
    expect.toBeFalsy(hiddenOff.includes('.secret.txt'));
    const hiddenOn = await fs.glob('**/*.txt', { dot: true });
    expect.toContain(hiddenOn, '.secret.txt');
    expect.toContain(hiddenOn, 'normal.txt');
  })
  .test('glob 支持 absolute=true', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    await fs.write('abs.txt', '1');
    const paths = await fs.glob('**/*.txt', { absolute: true });
    expect.toContain(paths, '/workspace/abs.txt');
  })
  .test('temp 生成 /tmp 路径', async () => {
    const { host } = createMockHost('/workspace');
    const fs = new OpenSandboxFS(host);
    const path = fs.temp('file.txt');
    expect.toEqual(path, '/tmp/file.txt');
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
