# OpenSandbox Guide

KODE SDK supports OpenSandbox as a sandbox backend for isolated command execution and file operations.

---

## Overview

| Feature | Description |
|---------|-------------|
| **Deployment** | Self-hosted OpenSandbox server |
| **Runtime** | Container-based isolated execution environment |
| **Lifecycle** | Create/connect/dispose by `sandboxId` |
| **Compatibility** | Works with existing `bash_*` and `fs_*` tools |

### When to Use OpenSandbox vs E2B vs Local

| Scenario | Recommended |
|----------|-------------|
| You need self-hosted control in your own infra | OpenSandbox |
| You want fully managed cloud sandbox | E2B |
| Local development and offline debugging | Local Sandbox |

---

## Prerequisites

1. Docker daemon is running and can pull required images.
2. OpenSandbox server is running (for example on `http://127.0.0.1:8080`).
3. If your server enables auth, prepare an API key.

Optional environment variables:

```bash
export OPEN_SANDBOX_API_KEY=...                      # optional, only when auth is enabled
export OPEN_SANDBOX_ENDPOINT=http://127.0.0.1:8080   # optional
export OPEN_SANDBOX_IMAGE=ubuntu                      # optional
```

---

## Quick Start

### Create and Use a Sandbox

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

## Configuration

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
  template?: string; // alias of image in current implementation
  workDir?: string;  // default '/workspace'
  timeoutMs?: number;
  execTimeoutMs?: number;
  requestTimeoutSeconds?: number;
  useServerProxy?: boolean; // default false
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resource?: Record<string, string>;
  networkPolicy?: Record<string, any>;
  skipHealthCheck?: boolean;
  readyTimeoutSeconds?: number;
  healthCheckPollingInterval?: number;
  watch?: {
    mode?: 'native' | 'polling' | 'off'; // default 'polling'
    pollIntervalMs?: number;              // default 1000
  };
  lifecycle?: {
    disposeAction?: 'close' | 'kill';     // default 'kill'
  };
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPEN_SANDBOX_API_KEY` | Optional API key (required only when server auth is enabled) |
| `OPEN_SANDBOX_ENDPOINT` | OpenSandbox server endpoint |
| `OPEN_SANDBOX_IMAGE` | Default image when creating a new sandbox |

---

## Agent Integration

### Use Sandbox Config (recommended)

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

When you pass sandbox config, `SandboxFactory.createAsync()` initializes OpenSandbox automatically.

### Use Sandbox Instance

```typescript
const sandbox = new OpenSandbox({ kind: 'opensandbox', endpoint: 'http://127.0.0.1:8080' });
await sandbox.init();

const agent = await Agent.create({ templateId: 'coder', sandbox }, deps);
```

When you pass sandbox instance directly, call `sandbox.init()` yourself before `Agent.create()`.

### Resume with `sandboxId`

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

## Watch and Lifecycle Semantics

1. `watch.mode='native'` uses `inotifywait` in the sandbox container.
2. If `inotifywait` is unavailable or native stream exits unexpectedly, the SDK auto-falls back to polling mode.
3. `watch.mode='off'` disables file watch registration.
4. `disposeAction='kill'` performs `kill()` first, then `close()`.
5. `disposeAction='close'` only closes the connection.
6. Polling watch is level-triggered by mtime delta and may coalesce multiple writes within one polling interval.
7. Polling watch does not guarantee one callback per write operation; treat events as "file changed" hints.

---

## Troubleshooting

1. `DOCKER::SANDBOX_IMAGE_PULL_FAILED` or `DOCKER::SANDBOX_EXECD_START_FAILED`: Docker cannot pull required images (`image` and `opensandbox/execd`).
2. Verify OpenSandbox server endpoint is reachable from the SDK process.
3. If you use a proxy, verify Docker daemon proxy and OpenSandbox server network settings separately.
