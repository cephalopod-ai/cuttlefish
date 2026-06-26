import type { Engine, CuttlefishConfig, ModelRegistry } from "../../shared/types.js";
import { isKnownEngine, type EngineName } from "../../shared/models.js";
import type { ProviderAdapter, ProviderAdapterResult } from "./types.js";
import { adapterNotFound, providerOk } from "./types.js";
import { createLocalEchoAdapter } from "./local-echo-adapter.js";
import { createManualAdapter } from "./manual-adapter.js";
import { createRealProviderAdapter } from "./real-adapter.js";
import { createStubAdapter } from "./stub-adapter.js";

export const LIVE_PROVIDER_IDS = ["claude", "codex", "antigravity", "grok", "hermes", "pi", "kiro"] as const satisfies readonly EngineName[];

export interface LiveProviderAdapterRegistryOptions {
  engines: ReadonlyMap<string, Engine>;
  getConfig: () => CuttlefishConfig;
  getModelRegistry?: () => ModelRegistry;
  isEngineAvailable?: (config: CuttlefishConfig, engine: EngineName) => boolean;
  now?: () => Date;
  maxRuns?: number;
  includeInertAdapters?: boolean;
}

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  resolve(provider: string): ProviderAdapterResult<ProviderAdapter> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return adapterNotFound(provider);
    return providerOk(adapter);
  }

  listIds(): string[] {
    return [...this.adapters.keys()].sort((a, b) => a.localeCompare(b));
  }
}

export function createProviderAdapterRegistry(adapters: ProviderAdapter[] = defaultAdapters()): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry(adapters);
}

export function createLiveProviderAdapterRegistry(opts: LiveProviderAdapterRegistryOptions): ProviderAdapterRegistry {
  const adapters = opts.includeInertAdapters === false ? [] : defaultAdapters();
  for (const id of LIVE_PROVIDER_IDS) {
    if (!isKnownEngine(id) || !opts.engines.has(id)) continue;
    adapters.push(createRealProviderAdapter({
      id,
      engines: opts.engines,
      getConfig: opts.getConfig,
      getModelRegistry: opts.getModelRegistry,
      isEngineAvailable: opts.isEngineAvailable,
      now: opts.now,
      maxRuns: opts.maxRuns,
    }));
  }
  return new ProviderAdapterRegistry(adapters);
}

function defaultAdapters(): ProviderAdapter[] {
  return [
    createStubAdapter("stub"),
    createManualAdapter("manual"),
    createLocalEchoAdapter({ id: "local_echo" }),
    createLocalEchoAdapter({ id: "mock" }),
  ];
}
