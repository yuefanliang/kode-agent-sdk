import { Sandbox, SandboxKind, LocalSandbox, LocalSandboxOptions } from './sandbox';
import { E2BSandbox } from './e2b/e2b-sandbox';
import { E2BSandboxOptions } from './e2b/types';
import { OpenSandbox, OpenSandboxOptions } from './opensandbox';

export type SandboxFactoryFn = (config: Record<string, any>) => Sandbox;

export class SandboxFactory {
  private factories = new Map<SandboxKind, SandboxFactoryFn>();

  constructor() {
    this.factories.set('local', (config) => new LocalSandbox(config as LocalSandboxOptions));
    this.factories.set('e2b', (config) => new E2BSandbox(config as E2BSandboxOptions));
    this.factories.set('opensandbox', (config) => new OpenSandbox(config as OpenSandboxOptions));
  }

  register(kind: SandboxKind, factory: SandboxFactoryFn): void {
    this.factories.set(kind, factory);
  }

  create(config: { kind: SandboxKind } & Record<string, any>): Sandbox {
    const factory = this.factories.get(config.kind);
    if (!factory) {
      throw new Error(`Sandbox factory not registered: ${config.kind}`);
    }
    return factory(config);
  }

  async createAsync(config: { kind: SandboxKind } & Record<string, any>): Promise<Sandbox> {
    const sandbox = this.create(config);
    if (config.kind === 'e2b' && sandbox instanceof E2BSandbox) {
      await sandbox.init();
    }
    if (config.kind === 'opensandbox' && sandbox instanceof OpenSandbox) {
      await sandbox.init();
    }
    return sandbox;
  }
}
