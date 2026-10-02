export interface TelemetrySink {
  recordTime(metric: string, durationMs: number): void;
  increment(metric: string, count?: number): void;
  getMetrics(): Record<string, number>;
}

export class DefaultTelemetrySink implements TelemetrySink {
  private metrics: Record<string, number> = {};

  recordTime(metric: string, durationMs: number): void {
    if (!this.metrics[metric]) this.metrics[metric] = 0;
    this.metrics[metric] += durationMs;
  }

  increment(metric: string, count: number = 1): void {
    if (!this.metrics[metric]) this.metrics[metric] = 0;
    this.metrics[metric] += count;
  }

  getMetrics(): Record<string, number> {
    return { ...this.metrics };
  }
}
