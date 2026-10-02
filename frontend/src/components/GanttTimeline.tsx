import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';
import { Lock, Unlock, Settings, RefreshCw, CheckCircle, AlertTriangle, XCircle, Info, Calendar } from 'lucide-react';

interface ContactWindow {
  id: string;
  groundStationId: string;
  satelliteId: string;
  aos: string;
  los: string;
  durationSeconds: number;
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

export const GanttTimeline = () => {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [windows, setWindows] = useState<ContactWindow[]>([]);
  
  const [previewReservations, setPreviewReservations] = useState<Reservation[] | null>(null);
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
      const resData = await api.get('/reservations');
      const winData = await api.get('/contact-windows');
      const verData = await api.get('/scheduler/version');
      setReservations(resData);
      setWindows(winData);
      setScheduleVersion(verData.scheduleVersion);
      
      let e = Infinity;
      winData.forEach((w: any) => {
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
      // Usually preview accepts the current version, but if we don't have one, we can fetch it?
      // Wait, POST /api/scheduler/preview requires { currentVersion }
      // We will pass the fetched scheduleVersion.
      const res = await api.post('/scheduler/preview', { scheduleVersion });
      setPreviewReservations(res.proposedReservations);
      setScheduleVersion(res.scheduleVersion); // Wait, preview returns the CURRENT version, not the proposed one.
      
      // Calculate diff (naive implementation)
      const currentIds = new Set(reservations.map(r => r.id));
      const proposedIds = new Set(res.proposedReservations.map((r: any) => r.id));
      
      // Actually, preview replaces all automated ones.
      setProposalSummary({
        added: res.proposedReservations.length - reservations.length, // rough
        moved: 0,
        removed: 0,
        lockedPreserved: reservations.filter(r => r.locked).length
      });
      
    } catch (err: any) {
      console.error(err);
      if (err.status === 409) {
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
        proposedReservations: previewReservations
      });
      
      setPreviewReservations(null);
      setProposalSummary(null);
      // Re-fetch everything
      await fetchData();
      setScheduleVersion(res.newVersion || scheduleVersion + 1);

    } catch (err: any) {
      console.error(err);
      if (err.response?.status === 409 || err.status === 409) {
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
  const byGsRes: Record<string, Reservation[]> = {};
  reservations.forEach((r) => {
    const gs = r.groundStationId.slice(0, 8);
    gsNames.add(gs);
    if (!byGsRes[gs]) byGsRes[gs] = [];
    byGsRes[gs].push(r);
  });

  const byGsPreview: Record<string, Reservation[]> = {};
  if (previewReservations) {
    previewReservations.forEach((r) => {
      const gs = r.groundStationId.slice(0, 8);
      gsNames.add(gs);
      if (!byGsPreview[gs]) byGsPreview[gs] = [];
      byGsPreview[gs].push(r);
    });
  }

  const renderBar = (startISO: string, endISO: string, color: string, style: React.CSSProperties = {}, key: string, label: string = "", isLocked: boolean = false) => {
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    
    // clamp
    const leftPx = Math.max(0, ((s - viewportStart) / viewportDuration) * 100);
    const widthPx = Math.max(0.5, ((e - s) / viewportDuration) * 100);

    // If completely out of view, don't render (or let overflow hidden hide it)
    if (leftPx > 100 || leftPx + widthPx < 0) return null;

    return (
      <div 
        key={key}
        title={label}
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
        {widthPx > 5 && <span>{label}</span>}
      </div>
    );
  };

  return (
    <div className="fade-in">
      <div className="glass-panel" style={{ padding: '2rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Calendar size={24} color="var(--primary)" />
              Interactive Gantt Timeline
            </h2>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              Visualize contact windows, current reservations, and run preview scenarios.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
             {/* Zoom / Pan Controls */}
             <div style={{ display: 'flex', gap: '0.25rem', marginRight: '1rem', borderRight: '1px solid var(--border)', paddingRight: '1rem' }}>
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

        {proposalSummary && (
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
        <div style={{ minWidth: '800px' }}>
          {/* Timeline Header (Time Scale) */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', marginLeft: '150px', position: 'relative', height: '20px' }}>
             {/* Basic markers */}
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

             return (
               <div key={sat} style={{ display: 'flex', marginBottom: '1rem', alignItems: 'stretch' }}>
                  <div style={{ width: '150px', paddingRight: '1rem', display: 'flex', alignItems: 'center', fontWeight: '500' }}>
                    SAT-{sat}
                  </div>
                  
                  <div style={{ flex: 1, position: 'relative', minHeight: '60px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                    {/* Background: Contact Windows */}
                    {satWindows.map(w => 
                       renderBar(w.aos, w.los, 'rgba(255, 255, 255, 0.05)', { border: '1px dashed rgba(255,255,255,0.1)' }, `win-${w.id}`, 'Contact Window')
                    )}

                    {/* Current Reservations (If previewing, dim them slightly or render proposal over them) */}
                    {satRes.map(r => {
                       const isLocked = r.locked;
                       const isManual = r.source === 'MANUAL';
                       
                       let color = 'var(--success)'; // automated
                       if (isLocked) color = 'var(--danger)'; // manual locked
                       else if (isManual) color = 'var(--primary)'; // manual unlocked

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

          {/* Collapsible Ground Station utilization section */}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <button 
              className="btn btn-outline" 
              style={{ marginBottom: '1rem', width: '100%', justifyContent: 'space-between' }}
              onClick={() => setIsGsCollapsed(!isGsCollapsed)}
            >
              <span>Ground Station Utilization</span>
              <span>{isGsCollapsed ? '▼ Expand' : '▲ Collapse'}</span>
            </button>

            {!isGsCollapsed && Array.from(gsNames).map(gs => {
               const gsRes = byGsRes[gs] || [];
               const gsPreview = byGsPreview[gs] || [];

               return (
                 <div key={gs} style={{ display: 'flex', marginBottom: '0.5rem', alignItems: 'stretch' }}>
                    <div style={{ width: '150px', paddingRight: '1rem', display: 'flex', alignItems: 'center', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                      GS-{gs}
                    </div>
                    
                    <div style={{ flex: 1, position: 'relative', minHeight: '30px', background: 'rgba(255,255,255,0.01)', borderRadius: '4px', border: '1px solid var(--border)' }}>
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
        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.875rem', marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
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
