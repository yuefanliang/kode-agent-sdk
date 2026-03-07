import { TestRunner, expect } from '../../helpers/utils';
import fs from 'fs';
import path from 'path';
import { OpenSandbox } from '../../../src/infra/opensandbox';

const runner = new TestRunner('E2E - OpenSandbox');

function loadEnv(key: string): string | undefined {
  const filePath = path.resolve(process.cwd(), '.env.test');
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      let v = trimmed.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k === key) return v;
    }
  }
  return process.env[key];
}

const apiKey = loadEnv('OPEN_SANDBOX_API_KEY');
const endpoint = loadEnv('OPEN_SANDBOX_ENDPOINT') || loadEnv('OPEN_SANDBOX_DOMAIN');
const protocol = (loadEnv('OPEN_SANDBOX_PROTOCOL') as 'http' | 'https' | undefined) || undefined;
const image = loadEnv('OPEN_SANDBOX_IMAGE') || 'ubuntu';
const enabled = loadEnv('OPEN_SANDBOX_E2E') === '1';

if (!enabled) {
  runner.skip('OpenSandbox E2E 跳过：设置 OPEN_SANDBOX_E2E=1 后执行');
} else {
  let sandbox: OpenSandbox;
  let sandboxId: string | undefined;

  runner
    .beforeAll(async () => {
      sandbox = new OpenSandbox({
        kind: 'opensandbox',
        apiKey,
        endpoint,
        protocol,
        image,
        timeoutMs: 10 * 60 * 1000,
        execTimeoutMs: 120000,
        useServerProxy: false,
        watch: { mode: 'off' },
        lifecycle: { disposeAction: 'kill' },
      });
      await sandbox.init();
      sandboxId = sandbox.getSandboxId();
    })
    .afterAll(async () => {
      if (sandbox) {
        await sandbox.dispose();
      }
    })
    .test('创建成功并返回 sandboxId', async () => {
      expect.toBeTruthy(sandboxId);
    })
    .test('基本命令执行', async () => {
      const result = await sandbox.exec('echo "hello opensandbox"');
      expect.toEqual(result.code, 0);
      expect.toContain(result.stdout, 'hello opensandbox');
    })
    .test('文件写入与读取', async () => {
      const path = `e2e-${Date.now()}.txt`;
      await sandbox.fs.write(path, 'hello from e2e');
      const content = await sandbox.fs.read(path);
      expect.toEqual(content.trim(), 'hello from e2e');
    })
    .test('glob 可检索 txt 文件', async () => {
      const path = `glob-${Date.now()}.txt`;
      await sandbox.fs.write(path, 'glob test');
      const files = await sandbox.fs.glob('**/*.txt');
      const hasTarget = files.some((p) => p.endsWith(path));
      expect.toEqual(hasTarget, true);
    })
    .test('使用 sandboxId 连接已存在沙箱', async () => {
      if (!sandboxId) {
        throw new Error('sandboxId is empty');
      }
      const restored = new OpenSandbox({
        kind: 'opensandbox',
        apiKey,
        endpoint,
        protocol,
        sandboxId,
        useServerProxy: false,
        watch: { mode: 'off' },
        lifecycle: { disposeAction: 'close' },
      });
      await restored.init();
      const result = await restored.exec('echo "restore ok"');
      expect.toEqual(result.code, 0);
      expect.toContain(result.stdout, 'restore ok');
      await restored.dispose();
    });
}

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run()
    .then((result) => {
      if (result.output) {
        console.log(result.output);
      }
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
