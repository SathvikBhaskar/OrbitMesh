import React from 'react';
import { Beaker, CheckCircle, Target, Database } from 'lucide-react';

export const Experiments = () => {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div className="glass-panel" style={{ padding: '2rem' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', color: 'var(--text-primary)' }}>
          <Beaker className="text-gradient" size={24} />
          Final Meta-Scheduler Validation Benchmark
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '2rem' }}>
          The 2,160-run final benchmark on the frozen <span className="mono">202601-202605</span> holdout workload has successfully completed. 
          The analysis script rigidly enforced the 4-tier lexicographic Oracle objective, separating the Meta-Scheduler from the Oracle optimal candidate set.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '2rem' }}>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
            <Database size={24} color="var(--accent-primary)" style={{ margin: '0 auto 1rem' }} />
            <div className="metric-value">2,160</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>Total Runs Processed</div>
          </div>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
            <Target size={24} color="var(--accent-secondary)" style={{ margin: '0 auto 1rem' }} />
            <div className="metric-value">540</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>Unique Workload Configs</div>
          </div>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
            <CheckCircle size={24} color="var(--success)" style={{ margin: '0 auto 1rem' }} />
            <div className="metric-value" style={{ color: 'var(--success)' }}>100%</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>Fingerprint Verification</div>
          </div>
        </div>

        <h3 style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>Final Reproducibility & Oracle Regret Metrics</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          The system successfully reproduced the aggregate characteristics observed in the pilot runs, confirming that the pipeline is highly deterministic under frozen conditions.
        </p>

        <div className="table-container" style={{ marginBottom: '2rem' }}>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Metric</th>
                <th style={{ textAlign: 'right' }}>Final Benchmark</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Meta scheduled</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold', color: 'var(--accent-secondary)' }}>68.1%</td>
              </tr>
              <tr>
                <td><strong>Weighted success</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold', color: 'var(--success)' }}>73.0%</td>
              </tr>
              <tr>
                <td><strong>Deadline misses</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>0.2%</td>
              </tr>
              <tr>
                <td><strong>P95 wait</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>14,118 s</td>
              </tr>
              <tr>
                <td><strong>Miss-rate regret</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>0.07%</td>
              </tr>
              <tr>
                <td><strong>Throughput regret</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>2.39%</td>
              </tr>
              <tr>
                <td><strong>Weighted-success regret</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>0.36%</td>
              </tr>
              <tr>
                <td><strong>P95 regret</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>864 s</td>
              </tr>
              <tr>
                <td><strong>Exact Oracle accuracy</strong></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>54.1%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ background: 'rgba(var(--accent-primary-rgb), 0.1)', borderLeft: '4px solid var(--accent-primary)', padding: '1rem 1.5rem', borderRadius: '0 4px 4px 0', marginBottom: '2rem' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            <strong>Note:</strong> The exact Oracle accuracy has converged with Top-Set accuracy because the Lexicographic evaluation strictly reduces ties, leaving only genuine mathematical dead-heats between candidate policies.
          </p>
        </div>

        <h3 style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>Selected Policy Distribution</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '2rem' }}>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
            <div className="metric-value" style={{ color: 'var(--accent-secondary)' }}>163</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>FCFS Selected</div>
          </div>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
            <div className="metric-value" style={{ color: 'var(--warning)' }}>377</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>PRIORITY Selected</div>
          </div>
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center', opacity: 0.5 }}>
            <div className="metric-value">0</div>
            <div className="metric-title" style={{ marginTop: '0.5rem' }}>HYBRID_SLACK Selected</div>
            <div style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: 'var(--text-muted)' }}>(Filtered out; no empirical training justification)</div>
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.02)', padding: '2rem', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
          <h3 style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>Final Conclusion</h3>
          <p style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: '800px', margin: '0 auto' }}>
            <strong>OrbitMesh demonstrates a reproducible, workload-aware adaptive scheduling strategy with a favorable multi-objective tradeoff, but it is not universally optimal.</strong>
          </p>
          <p style={{ marginTop: '1rem', color: 'var(--text-muted)', maxWidth: '800px', margin: '1rem auto 0', lineHeight: 1.6 }}>
            The system is highly stable, fail-safe (with rigorous fallback observability and reservation constraints), and correctly favors Priority for weighted success maximization under extreme pressure. It stands as a capable foundation for a production space network resource broker.
          </p>
        </div>

      </div>
    </div>
  );
};
