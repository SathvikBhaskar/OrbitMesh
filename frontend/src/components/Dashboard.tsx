import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Activity, Satellite, ListTodo, CalendarCheck, Zap } from 'lucide-react';
import { OrbitalSyncPanel } from './OrbitalSyncPanel';

export const Dashboard = () => {
  const [stats, setStats] = useState({
    tasks: 0,
    scheduled: 0,
    pending: 0,
    completed: 0,
    stations: 0,
    satellites: 0,
    reservations: 0
  });
  
  const [latestRun, setLatestRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const [tasks, stations, satellites, runs] = await Promise.all([
          api.get('/mission-tasks'),
          api.get('/ground-stations'),
          api.get('/satellites'),
          api.get('/scheduler-runs')
        ]);
        
        const scheduled = tasks.filter((t: any) => t.status === 'SCHEDULED').length;
        const pending = tasks.filter((t: any) => t.status === 'PENDING').length;
        const completed = tasks.filter((t: any) => t.status === 'COMPLETED').length;
        
        setStats({
          tasks: tasks.length,
          scheduled,
          pending,
          completed,
          reservations: scheduled, // In this model 1 reservation per scheduled task
          stations: stations.length,
          satellites: satellites.length
        });

        if (runs.length > 0) {
          setLatestRun(runs[0]);
        }
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchDashboard();
  }, []);

  if (loading) return <div className="p-6">Loading telemetry...</div>;

  const renderPolicyExplanation = (policy: string, reason: string) => {
    if (policy === 'FCFS') {
      return "The workload does not exhibit extreme deadline or high-priority pressure. FCFS was selected as the default throughput-oriented policy.";
    }
    if (policy === 'PRIORITY') {
      return "Extreme deadline pressure was detected. The scheduler prioritizes high-value tasks to reduce deadline risk.";
    }
    return reason || "Unknown reasoning.";
  };

  const execTime = latestRun ? (new Date(latestRun.completedAt).getTime() - new Date(latestRun.startedAt).getTime()) : 0;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Top Metrics Row */}
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '1.5rem', textAlign: 'center' }}>
          <div>
            <div className="metric-title">Tasks</div>
            <div className="metric-value">{stats.tasks}</div>
          </div>
          <div>
            <div className="metric-title">Scheduled</div>
            <div className="metric-value" style={{ color: 'var(--success)' }}>{stats.scheduled}</div>
          </div>
          <div>
            <div className="metric-title">Pending</div>
            <div className="metric-value" style={{ color: 'var(--warning)' }}>{stats.pending}</div>
          </div>
          <div>
            <div className="metric-title">Completed</div>
            <div className="metric-value" style={{ color: 'var(--accent-secondary)' }}>{stats.completed}</div>
          </div>
          <div>
            <div className="metric-title">Reservations</div>
            <div className="metric-value">{stats.reservations}</div>
          </div>
          <div style={{ borderLeft: '1px solid var(--border-color)' }}>
            <div className="metric-title">Stations</div>
            <div className="metric-value">{stats.stations}</div>
          </div>
          <div>
            <div className="metric-title">Satellites</div>
            <div className="metric-value">{stats.satellites}</div>
          </div>
        </div>
      </div>

      {/* Orbital Data Synchronization */}
      <OrbitalSyncPanel />

      {/* Meta-Scheduler Decision Showcase */}
      <div className="glass-panel" style={{ padding: '2rem', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '-50px', right: '-50px', opacity: 0.1, pointerEvents: 'none' }}>
          <Zap size={200} />
        </div>
        
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '1.1rem' }}>
          <Zap className="text-gradient" size={20} /> 
          Meta-Scheduler Decision
        </h2>
        
        {latestRun ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                  <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--accent-secondary)', letterSpacing: '0.1em' }}>
                    {latestRun.selectedPolicy}
                  </div>
                </div>
                
                <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6, textAlign: 'center', fontSize: '0.9rem' }}>
                  {renderPolicyExplanation(latestRun.selectedPolicy, latestRun.selectionReason)}
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '1rem' }}>Scheduling Result</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="metric-title">Evaluated</span>
                    <span className="mono">{latestRun.taskCount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="metric-title">Runtime</span>
                    <span className="mono">{execTime} ms</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="metric-title">Scheduled</span>
                    <span className="mono" style={{ color: 'var(--success)' }}>{latestRun.scheduledCount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="metric-title">Unscheduled</span>
                    <span className="mono" style={{ color: 'var(--warning)' }}>{latestRun.unscheduledCount}</span>
                  </div>
                </div>
              </div>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', paddingLeft: '2rem', borderLeft: '1px solid var(--border-color)' }}>
              <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Workload Features</h3>
              
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Load Pressure</span>
                <span className="mono">{latestRun.loadPressure != null ? Number(latestRun.loadPressure).toFixed(2) : 'N/A'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">P10 Deadline Pressure</span>
                <span className="mono">{latestRun.deadlinePressureP10 != null ? `${Number(latestRun.deadlinePressureP10).toFixed(1)} s` : 'N/A'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Tight Task Fraction</span>
                <span className="mono">{latestRun.tightTaskFraction != null ? Number(latestRun.tightTaskFraction).toFixed(2) : 'N/A'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">High Priority Fraction</span>
                <span className="mono">{latestRun.highPriorityFraction != null ? Number(latestRun.highPriorityFraction).toFixed(2) : 'N/A'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Fragmentation Pressure</span>
                <span className="mono">{latestRun.fragmentationPressure != null ? Number(latestRun.fragmentationPressure).toFixed(2) : 'N/A'}</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem 0' }}>
            No scheduling runs recorded yet. Click "Run Meta-Scheduler" to initiate.
          </div>
        )}
      </div>
      
    </div>
  );
};

