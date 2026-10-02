import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const ReservationTimeline = () => {
  const [reservations, setReservations] = useState([]);
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [selectedRes, setSelectedRes] = useState<any>(null);
  const [ledgerEvents, setLedgerEvents] = useState<any[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [resData, winData] = await Promise.all([
        api.get('/reservations'),
        api.get('/contact-windows')
      ]);
      setReservations(resData);
      setWindows(winData);
    } catch (err) {
      console.error(err);
      setError('Unable to load timeline data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <div className="p-6">Loading timeline...</div>;
  if (error) return (
    <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
      <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</p>
      <button className="btn btn-outline" onClick={fetchData}>Retry</button>
    </div>
  );

  // Group items by ground station
  const stationNames = new Set<string>();
  
  const byStationWin: any = {};
  windows.forEach((w: any) => {
    const st = w.groundStationName || w.groundStationId.slice(0,8);
    stationNames.add(st);
    if (!byStationWin[st]) byStationWin[st] = [];
    byStationWin[st].push(w);
  });

  const byStationRes: any = {};
  reservations.forEach((r: any) => {
    const st = r.groundStationName || r.groundStationId.slice(0,8);
    stationNames.add(st);
    if (!byStationRes[st]) byStationRes[st] = [];
    byStationRes[st].push(r);
  });

  let earliest = Infinity;
  let latest = -Infinity;

  windows.forEach((w: any) => {
    const s = new Date(w.aos).getTime();
    const e = new Date(w.los).getTime();
    if (s < earliest) earliest = s;
    if (e > latest) latest = e;
  });

  if (earliest === Infinity) {
    // Fallback if no windows
    earliest = Date.now();
    latest = earliest + 3600000;
  }

  earliest -= 5 * 60 * 1000;
  latest += 5 * 60 * 1000;
  const totalDuration = latest - earliest;

  const fetchLedger = async (resId: string) => {
    setLoadingLedger(true);
    try {
      const data = await api.get(`/execution/reservations/${resId}`);
      setLedgerEvents(data.events || []);
    } catch (err) {
      console.error('Failed to load execution audit ledger', err);
      setLedgerEvents([]);
    } finally {
      setLoadingLedger(false);
    }
  };

  const handleSelectRes = (res: any) => {
    setSelectedRes(res);
    setLedgerEvents([]);
    fetchLedger(res.id);
  };

  const formatBytes = (bytes?: number | null) => {
    if (bytes === undefined || bytes === null) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const getExecutionStateBadge = (state?: string) => {
    switch (state) {
      case 'COMPLETED':
        return <span className="badge badge-success">COMPLETED</span>;
      case 'IN_PROGRESS':
        return <span className="badge" style={{ backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#4ade80' }}>● IN PROGRESS</span>;
      case 'DISPATCHED':
        return <span className="badge" style={{ backgroundColor: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa' }}>DISPATCHED</span>;
      case 'EXECUTION_READY':
        return <span className="badge" style={{ backgroundColor: 'rgba(168, 85, 247, 0.2)', color: '#c084fc' }}>EXECUTION READY</span>;
      case 'PARTIAL':
        return <span className="badge" style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', color: '#facc15' }}>PARTIAL</span>;
      case 'FAILED':
        return <span className="badge" style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#f87171' }}>FAILED</span>;
      case 'SCHEDULED':
      default:
        return <span className="badge" style={{ backgroundColor: 'rgba(148, 163, 184, 0.2)', color: '#94a3b8' }}>SCHEDULED</span>;
    }
  };

  const getTimelineBlockColor = (res: any) => {
    switch (res.executionState) {
      case 'COMPLETED':
        return 'linear-gradient(135deg, #10b981, #047857)';
      case 'IN_PROGRESS':
        return 'linear-gradient(135deg, #22c55e, #15803d)';
      case 'DISPATCHED':
        return 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
      case 'EXECUTION_READY':
        return 'linear-gradient(135deg, #8b5cf6, #6d28d9)';
      case 'PARTIAL':
        return 'linear-gradient(135deg, #f59e0b, #b45309)';
      case 'FAILED':
        return 'linear-gradient(135deg, #ef4444, #b91c1c)';
      case 'SCHEDULED':
      default:
        return 'linear-gradient(135deg, var(--success), #2e7d32)';
    }
  };

  return (
    <div className="fade-in glass-panel" style={{ padding: '2rem', position: 'relative' }}>
      
      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Visual allocation of Scheduled Tasks across Ground Stations with real-time Execution State.
        </p>
        <div style={{ display: 'flex', gap: '1.25rem', fontSize: '0.8rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', border: '1px solid var(--warning)', borderRadius: '2px', background: 'transparent' }} />
            <span>Contact Window</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', background: '#3b82f6', borderRadius: '2px' }} />
            <span>Dispatched</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', background: '#22c55e', borderRadius: '2px' }} />
            <span>In Progress</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', background: '#10b981', borderRadius: '2px' }} />
            <span>Completed</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', background: '#f59e0b', borderRadius: '2px' }} />
            <span>Partial</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <div style={{ width: '12px', height: '12px', background: '#ef4444', borderRadius: '2px' }} />
            <span>Failed</span>
          </div>
        </div>
      </div>

      {windows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          No contact windows generated yet. Reset the demo to see windows.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {Array.from(stationNames).map(station => (
            <div key={station} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <div style={{ width: '120px', fontWeight: 600, fontSize: '0.875rem' }}>
                {station}
              </div>
              <div style={{ flex: 1 }}>
                <div className="timeline-track" style={{ height: '32px', position: 'relative', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                  
                  {/* Contact Windows */}
                  {(byStationWin[station] || []).map((win: any) => {
                    const start = new Date(win.aos).getTime();
                    const end = new Date(win.los).getTime();
                    const left = ((start - earliest) / totalDuration) * 100;
                    const width = ((end - start) / totalDuration) * 100;
                    return (
                      <div 
                        key={`win-${win.id}`} 
                        style={{ 
                          position: 'absolute', height: '100%',
                          left: `${left}%`, width: `${Math.max(width, 0.5)}%`,
                          border: '1px solid var(--warning)', opacity: 0.5, borderRadius: '4px'
                        }}
                        title={`Window (${format(new Date(start), 'HH:mm')} - ${format(new Date(end), 'HH:mm')})`}
                      />
                    );
                  })}

                  {/* Reservations */}
                  {(byStationRes[station] || []).map((res: any) => {
                    const start = new Date(res.allocatedStart).getTime();
                    const end = new Date(res.allocatedEnd).getTime();
                    const left = ((start - earliest) / totalDuration) * 100;
                    const width = ((end - start) / totalDuration) * 100;
                    return (
                      <div 
                        key={`res-${res.id}`} 
                        className="timeline-block"
                        onClick={() => handleSelectRes(res)}
                        style={{ 
                          left: `${left}%`, 
                          width: `${Math.max(width, 0.5)}%`,
                          background: getTimelineBlockColor(res),
                          cursor: 'pointer', zIndex: 10,
                          fontSize: '0.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          boxShadow: res.executionState === 'IN_PROGRESS' ? '0 0 10px rgba(34,197,94,0.6)' : undefined,
                          border: res.executionState === 'FAILED' ? '1px solid #f87171' : undefined
                        }}
                      >
                        {width > 2 && (res.taskName || 'Contact')}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
          
          <div style={{ display: 'flex', paddingLeft: '120px', marginLeft: '1rem', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
            <span>{format(new Date(earliest), 'HH:mm:ss')}</span>
            <span>{format(new Date(earliest + totalDuration/2), 'HH:mm:ss')}</span>
            <span>{format(new Date(latest), 'HH:mm:ss')}</span>
          </div>
        </div>
      )}

      {/* Popover */}
      {selectedRes && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setSelectedRes(null)}>
          <div className="glass-panel" style={{ padding: '2rem', width: '560px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto', background: '#0f172a' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ margin: 0, color: 'var(--accent-secondary)' }}>Execution Contract</h3>
                <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Reservation {selectedRes.id}</span>
              </div>
              <button className="btn btn-outline" style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }} onClick={() => setSelectedRes(null)}>✕ Close</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="metric-title">Execution State</span>
                <div>{getExecutionStateBadge(selectedRes.executionState)}</div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="metric-title">Scheduling Status</span>
                <span className="badge">{selectedRes.status}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Active Dispatch ID</span>
                <span className="mono" style={{ color: selectedRes.activeDispatchId ? '#60a5fa' : 'var(--text-muted)' }}>
                  {selectedRes.activeDispatchId || 'Not dispatched'}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Task Name</span>
                <span style={{ fontWeight: 600 }}>{selectedRes.taskName || '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Satellite</span>
                <span>{selectedRes.satelliteName || selectedRes.satelliteId?.slice(0,8)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Ground Station</span>
                <span>{selectedRes.groundStationName || selectedRes.groundStationId?.slice(0,8)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Priority</span>
                <span className="badge badge-priority">P{selectedRes.taskPriority || 'Unknown'}</span>
              </div>
              
              <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.5rem 0' }} />
              
              {/* Data Transfer & Quota */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Reservation Actuals:</span>
                  <span className="mono" style={{ fontWeight: 600, color: '#4ade80' }}>
                    {formatBytes(selectedRes.bytesTransferred)}
                  </span>
                </div>
                {selectedRes.taskTargetBytes !== undefined && selectedRes.taskTargetBytes !== null && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Task Quota Progress:</span>
                      <span className="mono">
                        {formatBytes(selectedRes.taskFulfilledBytes)} / {formatBytes(selectedRes.taskTargetBytes)} ({Math.min(100, Math.round(((selectedRes.taskFulfilledBytes || 0) / (selectedRes.taskTargetBytes || 1)) * 100))}%)
                      </span>
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(100, Math.round(((selectedRes.taskFulfilledBytes || 0) / (selectedRes.taskTargetBytes || 1)) * 100))}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #3b82f6, #10b981)'
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <span>Remaining Demand:</span>
                      <span className="mono">{formatBytes(selectedRes.taskRemainingBytes)}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Physical Actuals */}
              <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.5rem 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Allocated Window</span>
                <span className="mono" style={{ fontSize: '0.8rem' }}>
                  {format(new Date(selectedRes.allocatedStart), 'HH:mm:ss')} – {format(new Date(selectedRes.allocatedEnd), 'HH:mm:ss')}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Physical Carrier Lock (AOS)</span>
                <span className="mono" style={{ fontSize: '0.8rem', color: selectedRes.aosActual ? '#4ade80' : 'var(--text-muted)' }}>
                  {selectedRes.aosActual ? format(new Date(selectedRes.aosActual), 'HH:mm:ss.SSS') : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Physical Signal Loss (LOS)</span>
                <span className="mono" style={{ fontSize: '0.8rem', color: selectedRes.losActual ? '#4ade80' : 'var(--text-muted)' }}>
                  {selectedRes.losActual ? format(new Date(selectedRes.losActual), 'HH:mm:ss.SSS') : '—'}
                </span>
              </div>
              {selectedRes.failureReason && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f87171' }}>
                  <span className="metric-title" style={{ color: '#f87171' }}>Failure Reason</span>
                  <span className="mono" style={{ fontWeight: 600 }}>{selectedRes.failureReason}</span>
                </div>
              )}

              {/* Execution Telemetry Event Ledger */}
              <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.5rem 0' }} />
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span className="metric-title">Telemetry Ledger ({ledgerEvents.length} events)</span>
                  {loadingLedger && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading...</span>}
                </div>
                {ledgerEvents.length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                    {loadingLedger ? 'Fetching telemetry audit...' : 'No telemetry events ingested for this contract.'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '140px', overflowY: 'auto' }}>
                    {ledgerEvents.map((evt) => (
                      <div key={evt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.35rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                        <span className="mono" style={{ color: '#60a5fa' }}>#{evt.sequenceNumber} {evt.eventType}</span>
                        <span className="mono" style={{ color: 'var(--text-muted)' }}>
                          {format(new Date(evt.sourceTimestamp), 'HH:mm:ss')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

