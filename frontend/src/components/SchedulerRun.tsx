import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const SchedulerRun = () => {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/scheduler-runs');
      setRuns(data);
    } catch (err) {
      console.error(err);
      setError('Unable to load scheduler logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRuns();
  }, []);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <p style={{ color: 'var(--text-secondary)' }}>Detailed telemetry from Meta-Scheduler executions.</p>

      {error ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</p>
          <button className="btn btn-outline" onClick={fetchRuns}>Retry</button>
        </div>
      ) : loading ? (
        <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading scheduler logs...
        </div>
      ) : runs.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          No scheduler runs recorded. Run the Meta-Scheduler to see telemetry.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {runs.map((run: any) => (
            <div key={run.id} className="glass-panel" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className="mono" style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{run.id.slice(0, 8)}</span>
                    <span className="badge badge-success">{run.executionStatus}</span>
                  </h3>
                  <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    {format(new Date(run.startedAt), 'yyyy-MM-dd HH:mm:ss')} (Took {((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(3)}s)
                  </span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--accent-secondary)' }}>{run.selectedPolicy || 'NONE'}</div>
                  <div style={{ fontSize: '0.875rem', color: 'var(--warning)' }}>{run.selectionReason || 'N/A'}</div>
                </div>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', fontSize: '0.875rem' }}>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Load Pressure</div>
                  <div className="mono">{run.loadPressure != null ? Number(run.loadPressure).toFixed(2) : 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>P10 Deadline</div>
                  <div className="mono">{run.deadlinePressureP10 != null ? `${Number(run.deadlinePressureP10).toFixed(1)}s` : 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>High Priority %</div>
                  <div className="mono">{run.highPriorityFraction != null ? Number(run.highPriorityFraction).toFixed(2) : 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Fragmentation</div>
                  <div className="mono">{run.fragmentationPressure != null ? Number(run.fragmentationPressure).toFixed(2) : 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Scheduled</div>
                  <div className="mono" style={{ color: 'var(--success)' }}>{run.scheduledCount ?? 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Unscheduled</div>
                  <div className="mono" style={{ color: 'var(--danger)' }}>{run.unscheduledCount ?? 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Usable Capacity</div>
                  <div className="mono">{run.usableCapacitySeconds != null ? `${Number(run.usableCapacitySeconds).toFixed(0)}s` : 'N/A'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Total Demand</div>
                  <div className="mono">{run.totalTaskDemandSeconds != null ? `${Number(run.totalTaskDemandSeconds).toFixed(0)}s` : 'N/A'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

