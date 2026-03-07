# OpenSandbox 沙箱指南

KODE SDK 支持 OpenSandbox 作为沙箱后端，用于隔离命令执行和文件操作。

---

## 概述

| 特性 | 说明 |
|------|------|
| **部署方式** | 自建 OpenSandbox 服务 |
| **运行时** | 基于容器的隔离执行环境 |
| **生命周期** | 基于 `sandboxId` 的创建/连接/销毁 |
| **兼容性** | 可直接复用 `bash_*` 与 `fs_*` 工具 |

### OpenSandbox / E2B / Local 的选择

| 场景 | 推荐 |
|------|------|
| 需要在自有基础设施内自托管 | OpenSandbox |
| 需要全托管云沙箱 | E2B |
| 本地开发与离线调试 | Local Sandbox |

---

## 前置条件

1. Docker daemon 已启动，且可拉取所需镜像。
2. OpenSandbox server 已启动（例如 `http://127.0.0.1:8080`）。
3. 如果服务启用了鉴权，准备 API Key。

可选环境变量：

```bash
export OPEN_SANDBOX_API_KEY=...                      # 可选，仅服务启用鉴权时需要
export OPEN_SANDBOX_ENDPOINT=http://127.0.0.1:8080   # 可选
export OPEN_SANDBOX_IMAGE=ubuntu                      # 可选
```

---

## 快速开始

### 创建并使用沙箱

```typescript
import { OpenSandbox } from '@shareai-lab/kode-sdk';

const sandbox = new OpenSandbox({
  kind: 'opensandbox',
  apiKey: process.env.OPEN_SANDBOX_API_KEY,
  endpoint: process.env.OPEN_SANDBOX_ENDPOINT,
  image: process.env.OPEN_SANDBOX_IMAGE || 'ubuntu',
  timeoutMs: 600_000,
  execTimeoutMs: 120_000,
  useServerProxy: false,
  watch: { mode: 'polling', pollIntervalMs: 1000 },
  lifecycle: { disposeAction: 'kill' },
});

await sandbox.init();
console.log('sandboxId:', sandbox.getSandboxId());

const result = await sandbox.exec('echo "hello opensandbox"');
console.log(result.code, result.stdout.trim());

await sandbox.fs.write('demo.txt', 'hello from opensandbox');
const content = await sandbox.fs.read('demo.txt');
console.log(content.trim());

await sandbox.dispose();
```

---

## 配置项

### OpenSandboxOptions

```typescript
interface OpenSandboxOptions {
  kind: 'opensandbox';
  apiKey?: string;
  endpoint?: string;
  domain?: string;
  protocol?: 'http' | 'https';
  sandboxId?: string;
  image?: string;
  template?: string; // 当前实现中与 image 同义
  workDir?: string;  // 默认 '/workspace'
  timeoutMs?: number;
  execTimeoutMs?: number;
  requestTimeoutSeconds?: number;
  useServerProxy?: boolean; // 默认 false
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resource?: Record<string, string>;
  networkPolicy?: Record<string, any>;
  skipHealthCheck?: boolean;
  readyTimeoutSeconds?: number;
  healthCheckPollingInterval?: number;
  watch?: {
    mode?: 'native' | 'polling' | 'off'; // 默认 'polling'
    pollIntervalMs?: number;              // 默认 1000
  };
  lifecycle?: {
    disposeAction?: 'close' | 'kill';     // 默认 'kill'
  };
}
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `OPEN_SANDBOX_API_KEY` | 可选 API Key（仅服务启用鉴权时需要） |
| `OPEN_SANDBOX_ENDPOINT` | OpenSandbox server 地址 |
| `OPEN_SANDBOX_IMAGE` | 创建新沙箱时使用的默认镜像 |

---

## Agent 集成

### 使用沙箱配置（推荐）

```typescript
const agent = await Agent.create({
  templateId: 'coder',
  sandbox: {
    kind: 'opensandbox',
    endpoint: process.env.OPEN_SANDBOX_ENDPOINT,
    apiKey: process.env.OPEN_SANDBOX_API_KEY,
    image: 'debian:latest',
    lifecycle: { disposeAction: 'kill' },
  },
}, deps);
```

传入沙箱配置时，`SandboxFactory.createAsync()` 会自动完成 OpenSandbox 初始化。

### 使用沙箱实例

```typescript
const sandbox = new OpenSandbox({ kind: 'opensandbox', endpoint: 'http://127.0.0.1:8080' });
await sandbox.init();

const agent = await Agent.create({ templateId: 'coder', sandbox }, deps);
```

传入沙箱实例时，需要在 `Agent.create()` 前手动调用 `sandbox.init()`。

### 基于 `sandboxId` 的恢复

```typescript
const sandbox = new OpenSandbox({ kind: 'opensandbox', endpoint: 'http://127.0.0.1:8080' });
await sandbox.init();
const id = sandbox.getSandboxId();

const restored = new OpenSandbox({
  kind: 'opensandbox',
  endpoint: 'http://127.0.0.1:8080',
  sandboxId: id,
});
await restored.init();
```

---

## Watch 与生命周期语义

1. `watch.mode='native'` 会在沙箱容器内使用 `inotifywait`。
2. 若 `inotifywait` 不可用，或 native 流异常退出，SDK 会自动回退到 polling。
3. `watch.mode='off'` 会关闭文件监听注册。
4. `disposeAction='kill'` 先执行 `kill()`，再执行 `close()`。
5. `disposeAction='close'` 仅关闭连接。
6. polling 监听基于 mtime 变化，轮询间隔内的多次写入可能被合并为一次事件。
7. polling 不保证“一次写入对应一次回调”，应将事件视为“文件已变化提示”。

---

## 排障建议

1. `DOCKER::SANDBOX_IMAGE_PULL_FAILED` 或 `DOCKER::SANDBOX_EXECD_START_FAILED`：Docker 无法拉取必须镜像（业务镜像与 `opensandbox/execd`）。
2. 确认 SDK 进程能访问 OpenSandbox server 地址。
3. 若使用代理，请分别检查 Docker daemon 代理与 OpenSandbox server 的网络配置。
