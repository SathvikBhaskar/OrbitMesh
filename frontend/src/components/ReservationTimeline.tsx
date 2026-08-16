import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const ReservationTimeline = () => {
  const [reservations, setReservations] = useState([]);
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [selectedRes, setSelectedRes] = useState<any>(null);

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

  return (
    <div className="fade-in glass-panel" style={{ padding: '2rem', position: 'relative' }}>
      
      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Visual allocation of Scheduled Tasks across Ground Stations.
        </p>
        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', border: '1px solid var(--warning)', borderRadius: '4px', background: 'transparent' }} />
            <span>Contact Window</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '16px', height: '16px', background: 'var(--success)', borderRadius: '4px' }} />
            <span>Scheduled Reservation</span>
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
                        onClick={() => setSelectedRes(res)}
                        style={{ 
                          left: `${left}%`, 
                          width: `${Math.max(width, 0.5)}%`,
                          background: 'linear-gradient(135deg, var(--success), #2e7d32)',
                          cursor: 'pointer', zIndex: 10,
                          fontSize: '0.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}
                      >
                        {width > 2 && res.taskName}
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
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setSelectedRes(null)}>
          <div className="glass-panel" style={{ padding: '2rem', minWidth: '400px', background: '#0f172a' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
              <h3 style={{ margin: 0, color: 'var(--accent-secondary)' }}>Reservation Details</h3>
              <button className="btn btn-outline" style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }} onClick={() => setSelectedRes(null)}>Close</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Task Name</span>
                <span style={{ fontWeight: 600 }}>{selectedRes.taskName}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Reservation ID</span>
                <span className="mono">{selectedRes.id.slice(0,8)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Satellite</span>
                <span>{selectedRes.satelliteName || selectedRes.satelliteId.slice(0,8)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Ground Station</span>
                <span>{selectedRes.groundStationName || selectedRes.groundStationId.slice(0,8)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Priority</span>
                <span className="badge badge-priority">P{selectedRes.taskPriority || 'Unknown'}</span>
              </div>
              
              <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.5rem 0' }} />
              
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Start</span>
                <span className="mono">{format(new Date(selectedRes.allocatedStart), 'yyyy-MM-dd HH:mm:ss')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">End</span>
                <span className="mono">{format(new Date(selectedRes.allocatedEnd), 'yyyy-MM-dd HH:mm:ss')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="metric-title">Duration</span>
                <span className="mono">{selectedRes.taskDurationSeconds} s</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

