export type OpenSandboxWatchMode = 'native' | 'polling' | 'off';

export interface OpenSandboxOptions {
  kind: 'opensandbox';
  apiKey?: string;
  endpoint?: string;
  domain?: string;
  protocol?: 'http' | 'https';
  sandboxId?: string;
  image?: string;
  template?: string;
  workDir?: string;
  timeoutMs?: number;
  execTimeoutMs?: number;
  requestTimeoutSeconds?: number;
  useServerProxy?: boolean;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resource?: Record<string, string>;
  networkPolicy?: Record<string, any>;
  skipHealthCheck?: boolean;
  readyTimeoutSeconds?: number;
  healthCheckPollingInterval?: number;
  watch?: {
    mode?: OpenSandboxWatchMode;
    pollIntervalMs?: number;
  };
  lifecycle?: {
    disposeAction?: 'close' | 'kill';
  };
}
