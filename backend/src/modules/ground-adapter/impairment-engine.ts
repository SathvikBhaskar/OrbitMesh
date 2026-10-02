export interface ImpairmentProfile {
  latencyMs?: number;
  jitterMs?: number;
  dropRate?: number; // 0.0 to 1.0
  burstLossCount?: number; // drop next N frames
  isDisconnected?: boolean;
  duplicateRate?: number;
}

export class TransportImpairmentEngine {
  private profile: ImpairmentProfile = {};
  private burstDropRemaining: number = 0;

  constructor(initialProfile?: ImpairmentProfile) {
    if (initialProfile) {
      this.configure(initialProfile);
    }
  }

  public configure(profile: ImpairmentProfile): void {
    this.profile = { ...this.profile, ...profile };
    if (profile.burstLossCount && profile.burstLossCount > 0) {
      this.burstDropRemaining = profile.burstLossCount;
    }
  }

  public reset(): void {
    this.profile = {};
    this.burstDropRemaining = 0;
  }

  public shouldDropPacket(): boolean {
    if (this.profile.isDisconnected) {
      return true;
    }

    if (this.burstDropRemaining > 0) {
      this.burstDropRemaining--;
      return true;
    }

    if (this.profile.dropRate && this.profile.dropRate > 0) {
      return Math.random() < this.profile.dropRate;
    }

    return false;
  }

  public shouldDuplicatePacket(): boolean {
    if (this.profile.duplicateRate && this.profile.duplicateRate > 0) {
      return Math.random() < this.profile.duplicateRate;
    }
    return false;
  }

  public calculateDelay(): number {
    const baseLatency = this.profile.latencyMs || 0;
    const jitter = this.profile.jitterMs || 0;
    if (jitter === 0) return baseLatency;

    // Uniform jitter between -jitter and +jitter
    const delta = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(baseLatency + delta));
  }
}
