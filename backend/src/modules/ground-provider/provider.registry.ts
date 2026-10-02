import { IGroundStationProviderAdapter } from "./provider.types";
import { MockGroundStationProviderAdapter } from "./adapters/mock-provider.adapter";

export class ProviderRegistry {
  private adapters = new Map<string, IGroundStationProviderAdapter>();

  constructor() {
    // Register default mock provider
    this.registerAdapter(new MockGroundStationProviderAdapter("default-provider"));
  }

  registerAdapter(adapter: IGroundStationProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  getAdapter(providerId: string): IGroundStationProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`Ground station provider adapter [${providerId}] not found in registry`);
    }
    return adapter;
  }

  hasAdapter(providerId: string): boolean {
    return this.adapters.has(providerId);
  }
}

export const providerRegistry = new ProviderRegistry();
