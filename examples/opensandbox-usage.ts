import './shared/load-env';

import { OpenSandbox } from '@shareai-lab/kode-sdk';

function printUsage() {
  console.log(`
OpenSandbox 示例
================

环境变量:
  OPEN_SANDBOX_API_KEY=...                      # 可选（服务开启鉴权时需要）
  OPEN_SANDBOX_ENDPOINT=http://127.0.0.1:8080   # 可选
  OPEN_SANDBOX_IMAGE=ubuntu                      # 可选

运行:
  npm run example:opensandbox
`);
}

async function main() {
  printUsage();

  const sandbox = new OpenSandbox({
    kind: 'opensandbox',
    apiKey: process.env.OPEN_SANDBOX_API_KEY,
    endpoint: process.env.OPEN_SANDBOX_ENDPOINT,
    image: process.env.OPEN_SANDBOX_IMAGE || 'ubuntu',
    timeoutMs: 10 * 60 * 1000,
    execTimeoutMs: 120000,
    useServerProxy: false,
    watch: { mode: 'polling', pollIntervalMs: 1000 },
    lifecycle: { disposeAction: 'kill' },
  });

  await sandbox.init();
  console.log(`sandboxId: ${sandbox.getSandboxId()}`);

  const shell = await sandbox.exec('echo "hello opensandbox"');
  console.log(`exec code=${shell.code}`);
  console.log(shell.stdout.trim());

  await sandbox.fs.write('demo.txt', 'hello from opensandbox');
  const text = await sandbox.fs.read('demo.txt');
  console.log(`file content: ${text.trim()}`);

  const files = await sandbox.fs.glob('**/*.txt');
  console.log(`txt files: ${files.join(', ')}`);

  await sandbox.dispose();
  console.log('disposed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
