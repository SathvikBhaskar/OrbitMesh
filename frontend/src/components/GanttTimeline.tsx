import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';
import { Lock, Settings, RefreshCw, CheckCircle, AlertTriangle, XCircle, Calendar, BarChart2, Shield } from 'lucide-react';

interface ContactWindow {
  id: string;
  groundStationId: string;
  satelliteId: string;
  aos: string;
  los: string;
  durationSeconds: number;
}

interface GroundStation {
  id: string;
  code: string;
  name: string;
  supportedFrequencyBands?: string[];
  maxConcurrentContacts?: number;
  maxDataRateMbps?: number;
  status: string;
}

interface Reservation {
  id: string;
  missionTaskId: string;
  contactWindowId: string;
  groundStationId: string;
  satelliteId: string;
  windowAos: string;
  windowLos: string;
  taskDurationSeconds: number;
  allocatedStart: string;
  allocatedEnd: string;
  source: 'MANUAL' | 'AUTOMATED';
  locked: boolean;
  status: string;
}

interface ProposalSummary {
  added: number;
  moved: number;
  removed: number;
  lockedPreserved: number;
}

interface ProposalMetrics {
  scheduledTaskCount: number;
  unscheduledTaskCount: number;
  weightedPriorityValue: number;
  deadlineSuccessRate: number;
  totalScheduledDurationSeconds: number;
  stationUtilizationPercent: number;
  averageSlackSecondsAtAllocation: number;
}

interface ScoreBreakdown {
  taskId: string;
  taskName?: string;
  priority?: number;
  windowId: string;
  stationId?: string;
  compositeScore: number;
  normPriority: number;
  normUrgency: number;
  normElevation: number;
}

export type SchedulerPolicyType = 'HYBRID' | 'PRIORITY' | 'FCFS';

export const GanttTimeline = () => {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [windows, setWindows] = useState<ContactWindow[]>([]);
  const [groundStations, setGroundStations] = useState<GroundStation[]>([]);
  const [satellitesList, setSatellitesList] = useState<any[]>([]);
  
  const [selectedPolicy, setSelectedPolicy] = useState<SchedulerPolicyType>('HYBRID');
  const [previewReservations, setPreviewReservations] = useState<Reservation[] | null>(null);
  const [previewPolicy, setPreviewPolicy] = useState<string | null>(null);
  const [previewMetrics, setPreviewMetrics] = useState<ProposalMetrics | null>(null);
  const [scoreBreakdowns, setScoreBreakdowns] = useState<ScoreBreakdown[]>([]);
  const [showScoreDrawer, setShowScoreDrawer] = useState<boolean>(false);

  const [proposalSummary, setProposalSummary] = useState<ProposalSummary | null>(null);
  const [scheduleVersion, setScheduleVersion] = useState<number>(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [isCommiting, setIsCommiting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Zoom/Pan State
  const [isGsCollapsed, setIsGsCollapsed] = useState(false);
  const [viewportStart, setViewportStart] = useState<number>(Date.now());
  const [viewportDuration, setViewportDuration] = useState<number>(24 * 3600 * 1000); // 24h default

  const fetchData = async () => {
    setLoading(true);
    setPreviewError(null);
    setCommitError(null);
    try {
      const [resData, winData, verData, gsData, satData] = await Promise.all([
        api.get('/reservations'),
        api.get('/contact-windows'),
        api.get('/scheduler/version').catch(() => ({ scheduleVersion: 0 })),
        api.get('/ground-stations').catch(() => []),
        api.get('/satellites').catch(() => []),
      ]);

      setReservations(resData || []);
      setWindows(winData || []);
      setScheduleVersion(verData?.scheduleVersion || 0);
      setGroundStations(gsData || []);
      setSatellitesList(satData || []);
      
      let e = Infinity;
      (winData || []).forEach((w: any) => {
        const s = new Date(w.aos).getTime();
        if (s < e) e = s;
      });
      if (e === Infinity) {
        e = Date.now();
      } else {
        e -= 5 * 60 * 1000;
      }
      setViewportStart(e);

    } catch (err) {
      console.error(err);
      setPreviewError('Unable to load timeline data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handlePreview = async () => {
    setIsPreviewing(true);
    setPreviewError(null);
    setCommitError(null);
    try {
      const res = await api.post('/scheduler/preview', {
        scheduleVersion,
        policy: selectedPolicy,
      });

      const proposed = res.proposedReservations || [];
      setPreviewReservations(proposed);
      setScheduleVersion(res.scheduleVersion);
      setPreviewPolicy(res.policy || selectedPolicy);
      setPreviewMetrics(res.metrics || null);
      setScoreBreakdowns(res.scoreBreakdowns || []);
      
      // Calculate true diff
      const currentTaskIds = new Set(reservations.map(r => r.missionTaskId));
      const proposedTaskIds = new Set(proposed.map((r: any) => r.missionTaskId));

      let addedCount = 0;
      proposedTaskIds.forEach(id => {
        if (!currentTaskIds.has(id)) addedCount++;
      });

      let removedCount = 0;
      currentTaskIds.forEach(id => {
        if (!proposedTaskIds.has(id)) removedCount++;
      });

      setProposalSummary({
        added: addedCount,
        moved: 0,
        removed: removedCount,
        lockedPreserved: reservations.filter(r => r.locked).length,
      });
      
    } catch (err: any) {
      console.error(err);
      if (err.status === 409 || err.code === 'SCHEDULE_VERSION_CONFLICT') {
        setPreviewError("Schedule changed since last load. Please refresh and try again.");
      } else {
        setPreviewError(err.message || "Failed to generate preview");
      }
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleCommit = async () => {
    if (!previewReservations) return;
    setIsCommiting(true);
    setCommitError(null);
    try {
      const res = await api.post('/scheduler/commit', {
        scheduleVersion,
        proposedReservations: previewReservations,
        policy: previewPolicy || selectedPolicy,
      });
      
      setPreviewReservations(null);
      setProposalSummary(null);
      setPreviewMetrics(null);
      setPreviewPolicy(null);
      setScoreBreakdowns([]);
      setShowScoreDrawer(false);

      await fetchData();
      setScheduleVersion(res.newVersion || scheduleVersion + 1);

    } catch (err: any) {
      console.error(err);
      if (err.status === 409 || err.code === 'SCHEDULE_VERSION_CONFLICT') {
        setCommitError("Schedule changed since this preview. Review the current schedule and generate a new preview.");
      } else {
        setCommitError(err.message || "Failed to commit schedule");
      }
    } finally {
      setIsCommiting(false);
    }
  };

  const handleDiscard = () => {
    setPreviewReservations(null);
    setProposalSummary(null);
    setPreviewMetrics(null);
    setPreviewPolicy(null);
    setScoreBreakdowns([]);
    setShowScoreDrawer(false);
    setCommitError(null);
  };

  if (loading) return <div className="p-6">Loading timeline...</div>;

  // Group by Satellite
  const satelliteNames = new Set<string>();
  const bySatWin: Record<string, ContactWindow[]> = {};
  windows.forEach((w) => {
    const st = w.satelliteId.slice(0, 8);
    satelliteNames.add(st);
    if (!bySatWin[st]) bySatWin[st] = [];
    bySatWin[st].push(w);
  });

  const bySatRes: Record<string, Reservation[]> = {};
  reservations.forEach((r) => {
    const st = r.satelliteId.slice(0, 8);
    satelliteNames.add(st);
    if (!bySatRes[st]) bySatRes[st] = [];
    bySatRes[st].push(r);
  });
  
  const bySatPreview: Record<string, Reservation[]> = {};
  if (previewReservations) {
    previewReservations.forEach((r) => {
      const st = r.satelliteId.slice(0, 8);
      satelliteNames.add(st);
      if (!bySatPreview[st]) bySatPreview[st] = [];
      bySatPreview[st].push(r);
    });
  }

  // Group by Ground Station
  const gsNames = new Set<string>();
  groundStations.forEach((g) => gsNames.add(g.id.slice(0, 8)));
  reservations.forEach((r) => gsNames.add(r.groundStationId.slice(0, 8)));
  windows.forEach((w) => gsNames.add(w.groundStationId.slice(0, 8)));

  const byGsRes: Record<string, Reservation[]> = {};
  reservations.forEach((r) => {
    const gs = r.groundStationId.slice(0, 8);
    if (!byGsRes[gs]) byGsRes[gs] = [];
    byGsRes[gs].push(r);
  });

  const byGsPreview: Record<string, Reservation[]> = {};
  if (previewReservations) {
    previewReservations.forEach((r) => {
      const gs = r.groundStationId.slice(0, 8);
      if (!byGsPreview[gs]) byGsPreview[gs] = [];
      byGsPreview[gs].push(r);
    });
  }

  const renderBar = (startISO: string, endISO: string, color: string, style: React.CSSProperties = {}, key: string, label: string = "", isLocked: boolean = false) => {
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    const viewportEnd = viewportStart + viewportDuration;
    
    // Completely out of view
    if (e <= viewportStart || s >= viewportEnd) return null;

    // Clamped start and end to avoid visual stretching
    const effectiveStart = Math.max(s, viewportStart);
    const effectiveEnd = Math.min(e, viewportEnd);

    const leftPx = ((effectiveStart - viewportStart) / viewportDuration) * 100;
    const widthPx = Math.max(0.4, ((effectiveEnd - effectiveStart) / viewportDuration) * 100);

    return (
      <div 
        key={key}
        title={`${label} (${new Date(startISO).toISOString().slice(11, 19)} - ${new Date(endISO).toISOString().slice(11, 19)} UTC)`}
        style={{
          position: 'absolute',
          left: `${leftPx}%`,
          width: `${widthPx}%`,
          top: '4px',
          bottom: '4px',
          backgroundColor: color,
          borderRadius: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.75rem',
          color: '#fff',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          ...style
        }}
      >
        {isLocked && <Lock size={12} style={{marginRight: '4px'}} />}
        {widthPx > 4 && <span>{label}</span>}
      </div>
    );
  };

  return (
    <div className="fade-in">
      <div className="glass-panel" style={{ padding: '2rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Calendar size={24} color="var(--primary)" />
              Interactive Gantt Timeline
            </h2>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              Network-aware multi-station allocation, capability tracking, and deterministic policy control.
            </p>
          </div>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Policy Switcher */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(255,255,255,0.04)', padding: '0.35rem 0.6rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, marginRight: '0.2rem' }}>Policy:</span>
              {(['HYBRID', 'PRIORITY', 'FCFS'] as const).map((pol) => (
                <button
                  key={pol}
                  className={`btn ${selectedPolicy === pol ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '0.25rem 0.65rem', fontSize: '0.75rem', height: 'auto', fontWeight: selectedPolicy === pol ? 700 : 500 }}
                  onClick={() => setSelectedPolicy(pol)}
                  disabled={isPreviewing || isCommiting}
                >
                  {pol}
                </button>
              ))}
            </div>

            {/* Zoom / Pan Controls */}
            <div style={{ display: 'flex', gap: '0.25rem', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', padding: '0 0.75rem' }}>
              <button className="btn btn-outline" onClick={() => setViewportStart(v => v - 3600000)} title="Pan Left (1h)">
                ←
              </button>
              <button className="btn btn-outline" onClick={() => setViewportStart(v => v + 3600000)} title="Pan Right (1h)">
                →
              </button>
              <button className="btn btn-outline" onClick={() => setViewportDuration(v => Math.max(3600000, v / 2))} title="Zoom In">
                +
              </button>
              <button className="btn btn-outline" onClick={() => setViewportDuration(v => Math.min(7 * 24 * 3600000, v * 2))} title="Zoom Out">
                -
              </button>
            </div>

            {!previewReservations ? (
              <button 
                className="btn btn-primary" 
                onClick={handlePreview}
                disabled={isPreviewing}
              >
                {isPreviewing ? 'Generating Preview...' : 'Run Scheduler Preview'}
              </button>
            ) : (
              <>
                <button className="btn btn-outline" onClick={handleDiscard}>
                  Discard Draft
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={handleCommit}
                  disabled={isCommiting}
                >
                  {isCommiting ? 'Committing...' : 'Commit Schedule'}
                </button>
              </>
            )}
            <button className="btn btn-outline" onClick={fetchData} title="Refresh Data">
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {commitError && (
          <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', borderRadius: '8px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertTriangle size={18} />
            {commitError}
          </div>
        )}
        
        {previewError && (
          <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', borderRadius: '8px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <XCircle size={18} />
            {previewError}
          </div>
        )}

        {/* Live Proposal Metrics Banner */}
        {previewMetrics && (
          <div style={{ marginTop: '1.25rem', padding: '1.25rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <BarChart2 size={18} color="var(--primary)" />
                  Live Proposal Metrics
                </span>
                <span style={{ padding: '0.2rem 0.55rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 700, background: 'var(--primary)', color: '#fff' }}>
                  {previewPolicy || selectedPolicy} POLICY
                </span>
              </div>

              {scoreBreakdowns.length > 0 && (
                <button
                  className="btn btn-outline"
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                  onClick={() => setShowScoreDrawer(!showScoreDrawer)}
                >
                  {showScoreDrawer ? 'Hide Score Breakdown' : `Inspect Scores (${scoreBreakdowns.length})`}
                </button>
              )}
            </div>

            {/* Metric Comparison Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
              <div className="card" style={{ padding: '0.75rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Scheduled Tasks</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--success)' }}>
                  {previewMetrics.scheduledTaskCount} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>/ {previewMetrics.scheduledTaskCount + previewMetrics.unscheduledTaskCount}</span>
                </div>
              </div>
              <div className="card" style={{ padding: '0.75rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Success Rate</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--primary)' }}>
                  {previewMetrics.deadlineSuccessRate.toFixed(1)}%
                </div>
              </div>
              <div className="card" style={{ padding: '0.75rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Weighted Value</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#fbbf24' }}>
                  {previewMetrics.weightedPriorityValue}
                </div>
              </div>
              <div className="card" style={{ padding: '0.75rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Station Util.</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#a78bfa' }}>
                  {previewMetrics.stationUtilizationPercent.toFixed(1)}%
                </div>
              </div>
              <div className="card" style={{ padding: '0.75rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Avg Slack</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                  {Math.round(previewMetrics.averageSlackSecondsAtAllocation)}s
                </div>
              </div>
            </div>

            {/* Expandable Score Breakdown Table */}
            {showScoreDrawer && (
              <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
                  Candidate Hybrid Scoring Breakdown:
                </div>
                <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '0.75rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                        <th style={{ padding: '4px' }}>Task ID</th>
                        <th style={{ padding: '4px' }}>Priority Score</th>
                        <th style={{ padding: '4px' }}>Urgency Score</th>
                        <th style={{ padding: '4px' }}>Quality (Elev)</th>
                        <th style={{ padding: '4px' }}>Composite Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scoreBreakdowns.map((sb, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '4px', fontFamily: 'monospace' }}>{sb.taskId.slice(0, 8)}</td>
                          <td style={{ padding: '4px' }}>{sb.normPriority.toFixed(2)}</td>
                          <td style={{ padding: '4px' }}>{sb.normUrgency.toFixed(2)}</td>
                          <td style={{ padding: '4px' }}>{sb.normElevation.toFixed(2)}</td>
                          <td style={{ padding: '4px', fontWeight: 'bold', color: 'var(--primary)' }}>{sb.compositeScore.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {proposalSummary && !previewMetrics && (
          <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid var(--primary)', borderRadius: '8px', display: 'flex', gap: '2rem' }}>
            <div style={{ fontWeight: 'bold' }}>Preview Summary</div>
            <div style={{ color: 'var(--success)' }}>+ {proposalSummary.added} added</div>
            <div style={{ color: 'var(--warning)' }}>~ {proposalSummary.moved} moved</div>
            <div style={{ color: 'var(--danger)' }}>- {proposalSummary.removed} removed</div>
            <div style={{ color: 'var(--text-secondary)' }}>🔒 {proposalSummary.lockedPreserved} locked preserved</div>
          </div>
        )}
      </div>

      <div className="glass-panel" style={{ padding: '2rem', overflowX: 'auto' }}>
        <div style={{ minWidth: '850px' }}>
          {/* Timeline Header (Time Scale) */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', marginLeft: '220px', position: 'relative', height: '20px' }}>
            {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
              const d = new Date(viewportStart + viewportDuration * pct);
              return (
                <div key={pct} style={{ position: 'absolute', left: `${pct * 100}%`, transform: 'translateX(-50%)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {format(d, 'HH:mm')}
                </div>
              );
            })}
          </div>

          {/* Rows by Satellite */}
          {Array.from(satelliteNames).map(sat => {
            const satWindows = bySatWin[sat] || [];
            const satRes = bySatRes[sat] || [];
            const satPreview = bySatPreview[sat] || [];

            const matchedSat = satellitesList.find(s => s.id === sat || s.id.startsWith(sat));
            const satNameFromWin = satWindows.find(w => (w as any).satelliteName)?.satelliteName;
            const satNameFromRes = satRes.find(r => (r as any).satelliteName)?.satelliteName;
            const satDisplayName = matchedSat?.name || satNameFromWin || satNameFromRes || `SAT-${sat}`;

            return (
              <div key={sat} style={{ display: 'flex', marginBottom: '1rem', alignItems: 'stretch' }}>
                <div style={{ width: '220px', paddingRight: '1rem', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                    {satDisplayName}
                  </div>
                  {matchedSat?.noradId && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      NORAD {matchedSat.noradId}
                    </div>
                  )}
                </div>
                
                <div style={{ flex: 1, position: 'relative', minHeight: '60px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  {/* Background: Contact Windows */}
                  {satWindows.map(w => 
                    renderBar(w.aos, w.los, 'rgba(255, 255, 255, 0.05)', { border: '1px dashed rgba(255,255,255,0.1)' }, `win-${w.id}`, 'Contact Window')
                  )}

                  {/* Current Reservations */}
                  {satRes.map(r => {
                    const isLocked = r.locked;
                    const isManual = r.source === 'MANUAL';
                    
                    let color = 'var(--success)';
                    if (isLocked) color = 'var(--danger)';
                    else if (isManual) color = 'var(--primary)';

                    const style = previewReservations ? { opacity: 0.3 } : {};
                    return renderBar(r.allocatedStart, r.allocatedEnd, color, style, `res-${r.id}`, r.status, isLocked);
                  })}

                  {/* Preview Proposals */}
                  {previewReservations && satPreview.map(r => {
                    const isLocked = r.locked;
                    const isManual = r.source === 'MANUAL';
                    
                    let color = 'var(--success)';
                    if (isLocked) color = 'var(--danger)';
                    else if (isManual) color = 'var(--primary)';

                    const style = { 
                      background: `repeating-linear-gradient(45deg, ${color}, ${color} 10px, transparent 10px, transparent 20px)`,
                      border: `1px solid ${color}`,
                      opacity: 0.9
                    };
                    
                    return renderBar(r.allocatedStart, r.allocatedEnd, 'transparent', style, `prop-${r.id}`, `Prop: ${r.status}`, isLocked);
                  })}
                </div>
              </div>
            );
          })}

          {/* Collapsible Ground Station utilization section with Capability Badges */}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <button 
              className="btn btn-outline" 
              style={{ marginBottom: '1rem', width: '100%', justifyContent: 'space-between' }}
              onClick={() => setIsGsCollapsed(!isGsCollapsed)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                <Shield size={16} color="var(--primary)" />
                Ground Station Capabilities & Utilization
              </span>
              <span>{isGsCollapsed ? '▼ Expand' : '▲ Collapse'}</span>
            </button>

            {!isGsCollapsed && Array.from(gsNames).map(gs => {
              const gsRes = byGsRes[gs] || [];
              const gsPreview = byGsPreview[gs] || [];
              const gsInfo = groundStations.find(g => g.id === gs || g.id.startsWith(gs));

              return (
                <div key={gs} style={{ display: 'flex', marginBottom: '0.75rem', alignItems: 'stretch' }}>
                  {/* Station Label & Hardware Badges */}
                  <div style={{ width: '220px', paddingRight: '1rem', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                      {gsInfo?.name || `GS-${gs}`}
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      {(gsInfo?.supportedFrequencyBands && gsInfo.supportedFrequencyBands.length > 0
                        ? gsInfo.supportedFrequencyBands
                        : ['S_BAND']
                      ).map((band: string) => (
                        <span
                          key={band}
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '1px 4px',
                            borderRadius: '3px',
                            background: 'rgba(59, 130, 246, 0.15)',
                            border: '1px solid rgba(59, 130, 246, 0.4)',
                            color: '#93c5fd',
                          }}
                        >
                          {band.replace('_BAND', '')}
                        </span>
                      ))}
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          padding: '1px 4px',
                          borderRadius: '3px',
                          background: 'rgba(16, 185, 129, 0.15)',
                          border: '1px solid rgba(16, 185, 129, 0.4)',
                          color: '#6ee7b7',
                        }}
                      >
                        {gsInfo?.maxConcurrentContacts || 1} ch
                      </span>
                      {gsInfo?.maxDataRateMbps && (
                        <span
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '1px 4px',
                            borderRadius: '3px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            border: '1px solid rgba(245, 158, 11, 0.4)',
                            color: '#fcd34d',
                          }}
                        >
                          {gsInfo.maxDataRateMbps}M
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div style={{ flex: 1, position: 'relative', minHeight: '34px', background: 'rgba(255,255,255,0.01)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                    {/* Current Reservations */}
                    {gsRes.map(r => {
                      const style = previewReservations ? { opacity: 0.3 } : {};
                      return renderBar(r.allocatedStart, r.allocatedEnd, 'var(--border)', style, `gs-res-${r.id}`);
                    })}

                    {/* Preview Proposals */}
                    {previewReservations && gsPreview.map(r => {
                      const style = { 
                        background: `repeating-linear-gradient(45deg, var(--border), var(--border) 5px, transparent 5px, transparent 10px)`,
                        border: `1px solid var(--border)`,
                        opacity: 0.9
                      };
                      return renderBar(r.allocatedStart, r.allocatedEnd, 'transparent', style, `gs-prop-${r.id}`);
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        
        {/* Legend */}
        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.875rem', marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', border: '1px dashed rgba(255,255,255,0.2)', borderRadius: '4px' }} />
            <span>Contact Window</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', background: 'var(--success)', borderRadius: '4px' }} />
            <span>Automated</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', background: 'var(--primary)', borderRadius: '4px' }} />
            <span>Manual Unlocked</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', background: 'var(--danger)', borderRadius: '4px' }} />
            <span>Manual Locked</span>
          </div>
          {previewReservations && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: '16px', height: '16px', border: '1px solid var(--success)', background: 'repeating-linear-gradient(45deg, var(--success), var(--success) 5px, transparent 5px, transparent 10px)', borderRadius: '4px' }} />
              <span>Draft Proposal</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
