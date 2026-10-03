import React, { useState, useCallback, useEffect, useRef } from 'react';
import { CesiumViewer, CesiumViewerActions } from './CesiumViewer';
import { SatelliteLayer } from './SatelliteLayer';
import { GroundStationLayer } from './GroundStationLayer';
import { OrbitTrackLayer } from './OrbitTrackLayer';
import { ContactWindowLayer } from './ContactWindowLayer';
import { TaskLayer } from './TaskLayer';
import { SatelliteDetailPanel } from './SatelliteDetailPanel';
import { SatellitePosition, GroundStation, ContactWindow, MissionTask } from './map-types';
import { api } from '../../api/client';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw, Globe, Layers, Sun } from 'lucide-react';

export const OrbitalMap: React.FC = () => {
  const [satellites, setSatellites] = useState<SatellitePosition[]>([]);
  const [stations, setStations] = useState<GroundStation[]>([]);
  const [windows, setWindows] = useState<ContactWindow[]>([]);
  const [tasks, setTasks] = useState<MissionTask[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<SatellitePosition | GroundStation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [referenceTime, setReferenceTime] = useState<string>(new Date().toISOString());
  const [flyTarget, setFlyTarget] = useState<{
    latitude: number;
    longitude: number;
    altitudeKm?: number;
    zoomClose?: boolean;
    isPivot?: boolean;
    name?: string;
  } | null>(null);
  const [isPivotMode, setIsPivotMode] = useState<boolean>(false);
  const [resetViewTrigger, setResetViewTrigger] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Layer & Constellation Filter State
  const [orbitFilter, setOrbitFilter] = useState<'ALL' | 'LEO' | 'MEO' | 'GEO'>('ALL');
  const [showOrbitTracks, setShowOrbitTracks] = useState<boolean>(true);
  const [showStations, setShowStations] = useState<boolean>(true);
  const [showContactLinks, setShowContactLinks] = useState<boolean>(true);
  const [showAllStationCones, setShowAllStationCones] = useState<boolean>(false);
  const [enableDayNight, setEnableDayNight] = useState<boolean>(false);
  const [isLayersOpen, setIsLayersOpen] = useState<boolean>(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const viewerActionsRef = useRef<CesiumViewerActions | null>(null);

  // Sync fullscreen state with HTML5 fullscreen change events
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      mapContainerRef.current?.requestFullscreen?.().catch((err) => {
        console.warn('Fullscreen request failed:', err);
      });
    } else {
      document.exitFullscreen?.().catch((err) => {
        console.warn('Exit fullscreen failed:', err);
      });
    }
  };

  const handleViewerReady = useCallback((actions: CesiumViewerActions) => {
    viewerActionsRef.current = actions;
  }, []);

  // Return to normal default Earth view
  const handleResetView = useCallback(() => {
    setSelectedEntity(null);
    setFlyTarget(null);
    setIsPivotMode(false);
    setResetViewTrigger(prev => prev + 1);
    viewerActionsRef.current?.resetView();
  }, []);

  // Exit 360° pivot mode while keeping entity selected at overview distance
  const handleExitPivot = useCallback(() => {
    setIsPivotMode(false);
    viewerActionsRef.current?.exitPivot();
    if (selectedEntity) {
      setFlyTarget({
        latitude: selectedEntity.latitude,
        longitude: selectedEntity.longitude,
        altitudeKm: 'altitudeKm' in selectedEntity ? selectedEntity.altitudeKm : 50,
        zoomClose: false,
        isPivot: false,
        name: selectedEntity.name,
      });
    }
  }, [selectedEntity]);

  // Toggle 360° pivot mode on/off for selected entity
  const handleTogglePivot = useCallback(() => {
    if (!selectedEntity) return;
    if (isPivotMode) {
      handleExitPivot();
    } else {
      setIsPivotMode(true);
      setFlyTarget({
        latitude: selectedEntity.latitude,
        longitude: selectedEntity.longitude,
        altitudeKm: 'altitudeKm' in selectedEntity ? selectedEntity.altitudeKm : 50,
        zoomClose: true,
        isPivot: true,
        name: selectedEntity.name,
      });
    }
  }, [selectedEntity, isPivotMode, handleExitPivot]);

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

  const handleSatelliteSelectChange = (satId: string) => {
    if (!satId) {
      handleResetView();
      return;
    }
    const found = satellites.find(s => s.satelliteId === satId);
    if (found) {
      setSelectedEntity(found);
      setIsPivotMode(false);
      setFlyTarget({
        latitude: found.latitude,
        longitude: found.longitude,
        altitudeKm: found.altitudeKm,
        zoomClose: false,
        isPivot: false,
        name: found.name,
      });
    }
  };

  // Single Click: Select entity, open telemetry detail panel, center camera smoothly at standard overview distance
  const handleEntitySelect = (entity: SatellitePosition | GroundStation | null) => {
    setSelectedEntity(entity);
    setIsPivotMode(false);
    if (entity) {
      setFlyTarget({
        latitude: entity.latitude,
        longitude: entity.longitude,
        altitudeKm: 'altitudeKm' in entity ? entity.altitudeKm : 50,
        zoomClose: false,
        isPivot: false,
        name: entity.name,
      });
    } else {
      handleResetView();
    }
  };

  // Double Click: Enter Option B 360° Object Pivot Mode, locking the entity as the 3D center turntable
  const handleEntityDoubleClick = (entity: SatellitePosition | GroundStation) => {
    setSelectedEntity(entity);
    setIsPivotMode(true);
    setFlyTarget({
      latitude: entity.latitude,
      longitude: entity.longitude,
      altitudeKm: 'altitudeKm' in entity ? entity.altitudeKm : 50,
      zoomClose: true,
      isPivot: true,
      name: entity.name,
    });
  };

  const filteredSatellites = React.useMemo(() => {
    if (orbitFilter === 'LEO') return satellites.filter(s => s.altitudeKm < 2000);
    if (orbitFilter === 'MEO') return satellites.filter(s => s.altitudeKm >= 2000 && s.altitudeKm < 30000);
    if (orbitFilter === 'GEO') return satellites.filter(s => s.altitudeKm >= 30000);
    return satellites;
  }, [satellites, orbitFilter]);

  return (
    <div
      ref={mapContainerRef}
      className="orbital-map-container fade-in"
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}
    >
      {/* Header bar */}
      <div
        className="glass-panel"
        style={{
          padding: '0.85rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
          flexShrink: 0,
          position: 'relative',
          zIndex: 200,
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Orbital Network (Cesium)</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
            Interactive 3D Globe with real-time orbit propagation
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
          {/* Quick Satellite Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Focus Satellite:</span>
            <select
              className="glass-panel"
              style={{
                padding: '0.35rem 0.6rem',
                fontSize: '0.8rem',
                color: 'var(--text-primary)',
                background: 'rgba(20, 20, 30, 0.85)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
              value={selectedEntity && 'satelliteId' in selectedEntity ? (selectedEntity as SatellitePosition).satelliteId : ''}
              onChange={(e) => handleSatelliteSelectChange(e.target.value)}
            >
              <option value="">-- Choose Satellite --</option>
              {filteredSatellites.map((s) => (
                <option key={s.satelliteId} value={s.satelliteId}>
                  {s.name} (NORAD {s.noradId})
                </option>
              ))}
            </select>
          </div>

          <div style={{
            padding: '0.3rem 0.7rem',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)'
          }}>
            {filteredSatellites.length > 0 ? `${filteredSatellites.length} sats · ${stations.length} stations` : 'Loading...'}
          </div>

          {/* Layers & Filters Popover Trigger */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-outline"
              style={{
                padding: '0.35rem 0.8rem',
                fontSize: '0.78rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                borderColor: isLayersOpen || orbitFilter !== 'ALL' || enableDayNight ? '#38bdf8' : 'var(--border-color)',
                background: isLayersOpen ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                color: isLayersOpen || orbitFilter !== 'ALL' || enableDayNight ? '#38bdf8' : 'var(--text-secondary)',
              }}
              onClick={() => setIsLayersOpen(prev => !prev)}
              title="Configure map layers, daytime lighting, and orbit filters"
            >
              <Layers size={14} /> Layers {orbitFilter !== 'ALL' ? `(${orbitFilter})` : ''}
            </button>

            {isLayersOpen && (
              <div
                className="glass-panel"
                style={{
                  position: 'absolute',
                  top: '120%',
                  right: 0,
                  width: '240px',
                  zIndex: 300,
                  padding: '0.85rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  boxShadow: '0 12px 36px rgba(0,0,0,0.85)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  background: 'rgba(15, 23, 42, 0.95)',
                  backdropFilter: 'blur(16px)',
                  borderRadius: '10px',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.7rem', color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem', fontWeight: 600 }}>
                    Orbit Regime Filter
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
                    {(['ALL', 'LEO', 'MEO', 'GEO'] as const).map(regime => (
                      <button
                        key={regime}
                        onClick={() => setOrbitFilter(regime)}
                        style={{
                          padding: '0.3rem 0.4rem',
                          fontSize: '0.72rem',
                          borderRadius: '5px',
                          border: orbitFilter === regime ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.1)',
                          background: orbitFilter === regime ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255,255,255,0.04)',
                          color: orbitFilter === regime ? '#fff' : 'var(--text-muted)',
                          cursor: 'pointer',
                          fontWeight: orbitFilter === regime ? 600 : 400,
                        }}
                      >
                        {regime === 'ALL' ? `All (${satellites.length})` : regime}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)' }} />

                <div>
                  <div style={{ fontSize: '0.7rem', color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem', fontWeight: 600 }}>
                    Map Layers
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', fontSize: '0.78rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={showOrbitTracks}
                        onChange={e => setShowOrbitTracks(e.target.checked)}
                      />
                      Orbit Tracks
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={showStations}
                        onChange={e => setShowStations(e.target.checked)}
                      />
                      Ground Stations
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={showContactLinks}
                        onChange={e => setShowContactLinks(e.target.checked)}
                      />
                      Contact Links
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={showAllStationCones}
                        onChange={e => setShowAllStationCones(e.target.checked)}
                      />
                      All Station Cones
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#fff' }}>
                      <input
                        type="checkbox"
                        checked={enableDayNight}
                        onChange={e => setEnableDayNight(e.target.checked)}
                      />
                      Day / Night Sun Light
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Return to default view button */}
          <button
            className="btn btn-outline"
            style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            onClick={handleResetView}
            title="Return to default global Earth view"
          >
            <Globe size={14} /> Default View
          </button>

          {/* Fullscreen toggle button */}
          <button
            className="btn btn-outline"
            style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          </button>

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

          {/* Active 360° Orbit Pivot Pill HUD */}
          {isPivotMode && selectedEntity && (
            <div
              style={{
                position: 'absolute',
                top: '1rem',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100,
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                background: 'rgba(15, 23, 42, 0.92)',
                backdropFilter: 'blur(10px)',
                padding: '0.45rem 1rem',
                borderRadius: '24px',
                border: '1px solid rgba(56, 189, 248, 0.5)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.6), 0 0 16px rgba(56, 189, 248, 0.25)',
                fontSize: '0.82rem',
                color: '#fff',
                whiteSpace: 'nowrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: '#38bdf8',
                    boxShadow: '0 0 8px #38bdf8',
                  }}
                />
                <span style={{ fontWeight: 600 }}>360° Pivot:</span>
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>{selectedEntity.name}</span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                · Drag mouse to rotate 360° around object
              </span>
              <button
                onClick={handleExitPivot}
                style={{
                  background: 'rgba(255, 255, 255, 0.12)',
                  border: '1px solid rgba(255, 255, 255, 0.25)',
                  borderRadius: '12px',
                  padding: '0.2rem 0.65rem',
                  color: '#fff',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
                title="Exit 360° pivot mode"
              >
                Exit Pivot
              </button>
            </div>
          )}

          {/* Floating On-Globe HUD Controls */}
          <div
            style={{
              position: 'absolute',
              top: '1rem',
              right: '1rem',
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              background: 'rgba(15, 23, 42, 0.8)',
              backdropFilter: 'blur(8px)',
              padding: '0.35rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
            }}
          >
            <button
              className="btn-hud"
              onClick={() => viewerActionsRef.current?.zoomIn()}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
                borderRadius: '6px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title="Zoom In (+)"
            >
              <ZoomIn size={16} />
            </button>
            <button
              className="btn-hud"
              onClick={() => viewerActionsRef.current?.zoomOut()}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
                borderRadius: '6px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title="Zoom Out (−)"
            >
              <ZoomOut size={16} />
            </button>
            <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '0.1rem 0' }} />
            <button
              className="btn-hud"
              onClick={handleResetView}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
                borderRadius: '6px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title="Reset to Default Global Earth View"
            >
              <RotateCcw size={16} />
            </button>
            <button
              className="btn-hud"
              onClick={handleToggleFullscreen}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-primary)',
                borderRadius: '6px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Map'}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>

          <CesiumViewer
            flyToTarget={flyTarget}
            resetViewTrigger={resetViewTrigger}
            enableLighting={enableDayNight}
            onViewerReady={handleViewerReady}
          >
            {showOrbitTracks && (
              <OrbitTrackLayer 
                satellites={filteredSatellites} 
                selectedSatelliteId={selectedEntity && 'noradId' in selectedEntity ? selectedEntity.satelliteId : undefined} 
              />
            )}
            <SatelliteLayer 
              satellites={filteredSatellites} 
              selectedSatelliteId={selectedEntity && 'noradId' in selectedEntity ? selectedEntity.satelliteId : undefined}
              onSelect={handleEntitySelect}
              onDoubleClick={handleEntityDoubleClick}
            />
            {showStations && (
              <GroundStationLayer 
                stations={stations} 
                selectedStationId={selectedEntity && !('noradId' in selectedEntity) ? selectedEntity.id : undefined}
                showAllFootprints={showAllStationCones}
                onSelect={handleEntitySelect}
                onDoubleClick={handleEntityDoubleClick}
              />
            )}
            {showContactLinks && (
              <ContactWindowLayer 
                windows={windows} 
                satellites={filteredSatellites} 
                stations={stations} 
                selectedSatelliteId={selectedEntity && 'noradId' in selectedEntity ? selectedEntity.satelliteId : undefined}
              />
            )}
            <TaskLayer tasks={tasks} satellites={filteredSatellites} />
          </CesiumViewer>
        </div>
        <div style={{ width: '280px', flexShrink: 0 }}>
          <SatelliteDetailPanel
            selected={selectedEntity}
            windows={windows}
            stations={stations}
            isPivotMode={isPivotMode}
            onTogglePivot={handleTogglePivot}
            onClose={handleResetView}
          />
        </div>
      </div>
    </div>
  );
};
