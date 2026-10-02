import React, { useState, useCallback, useEffect } from 'react';
import { CesiumViewer } from './CesiumViewer';
import { SatelliteLayer } from './SatelliteLayer';
import { GroundStationLayer } from './GroundStationLayer';
import { OrbitTrackLayer } from './OrbitTrackLayer';
import { ContactWindowLayer } from './ContactWindowLayer';
import { TaskLayer } from './TaskLayer';
import { SatelliteDetailPanel } from './SatelliteDetailPanel';
import { SatellitePosition, GroundStation, ContactWindow, MissionTask } from './map-types';
import { api } from '../../api/client';

export const OrbitalMap: React.FC = () => {
  const [satellites, setSatellites] = useState<SatellitePosition[]>([]);
  const [stations, setStations] = useState<GroundStation[]>([]);
  const [windows, setWindows] = useState<ContactWindow[]>([]);
  const [tasks, setTasks] = useState<MissionTask[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<SatellitePosition | GroundStation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [referenceTime, setReferenceTime] = useState<string>(new Date().toISOString());

  const fetchPositions = useCallback(async (time: string) => {
    try {
      setError(null);
      const encoded = encodeURIComponent(time);
      const [sats, gs, cw, ts] = await Promise.all([
        api.get(`/orbital-sync/positions?time=${encoded}`),
        api.get('/ground-stations'),
        api.get('/contact-windows'),
        api.get('/mission-tasks')
      ]);
      setSatellites(sats);
      setStations(gs);
      setWindows(cw);
      setTasks(ts);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPositions(referenceTime);
  }, []);

  const handleTimeRefresh = () => {
    const now = new Date().toISOString();
    setReferenceTime(now);
    setLoading(true);
    fetchPositions(now);
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}>
      {/* Header bar */}
      <div className="glass-panel" style={{ padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Orbital Network (Cesium)</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
            Interactive 3D Globe with orbit propagation
          </div>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.8rem' }}>
          <div style={{
            padding: '0.3rem 0.7rem',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)'
          }}>
            {satellites.length > 0 ? `${satellites.length} sats · ${stations.length} stations` : 'Loading...'}
          </div>
          <button
            className="btn btn-outline"
            style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem' }}
            onClick={handleTimeRefresh}
            disabled={loading}
          >
            {loading ? '⟳ Computing...' : '↻ Refresh Now'}
          </button>
        </div>
      </div>
      
      <div style={{ display: 'flex', flex: 1, gap: '1rem', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          {error && (
            <div style={{
              position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(239,68,68,0.9)', color: '#fff', padding: '0.5rem 1rem',
              borderRadius: '8px', fontSize: '0.85rem', zIndex: 1000
            }}>
              {error} — is the backend running?
            </div>
          )}
          <CesiumViewer>
            <OrbitTrackLayer 
              satellites={satellites} 
              selectedSatelliteId={selectedEntity && 'noradId' in selectedEntity ? selectedEntity.satelliteId : undefined} 
            />
            <SatelliteLayer satellites={satellites} onSelect={setSelectedEntity} />
            <GroundStationLayer stations={stations} onSelect={setSelectedEntity} />
            <ContactWindowLayer windows={windows} satellites={satellites} stations={stations} />
            <TaskLayer tasks={tasks} satellites={satellites} />
          </CesiumViewer>
        </div>
        <div style={{ width: '280px', flexShrink: 0 }}>
          <SatelliteDetailPanel selected={selectedEntity} onClose={() => setSelectedEntity(null)} />
        </div>
      </div>
    </div>
  );
};
