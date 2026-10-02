/**
 * Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness Types
 */

export type ConformanceLayer = "SEMANTIC" | "DISTRIBUTED" | "SECURITY" | "SAFETY";

export interface ConformanceAssertion {
  readonly id: string;
  readonly description: string;
  readonly layer: ConformanceLayer;
  readonly passed: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

export interface LayerConformanceResult {
  readonly layer: ConformanceLayer;
  readonly passed: boolean;
  readonly totalAssertions: number;
  readonly passedAssertions: number;
  readonly failedAssertions: number;
  readonly assertions: ConformanceAssertion[];
}

export interface ProviderCertificationReceipt {
  readonly providerId: string;
  readonly certifiedAt: Date;
  readonly isCertified: boolean;
  readonly summary: {
    readonly semantic: boolean;
    readonly distributed: boolean;
    readonly security: boolean;
    readonly safety: boolean;
    readonly totalAssertions: number;
    readonly passedAssertions: number;
  };
  readonly layerResults: Record<ConformanceLayer, LayerConformanceResult>;
  readonly signature: string;
}
