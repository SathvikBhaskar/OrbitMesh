import React, { useState } from 'react';
import { SatellitePosition, GroundStation, ContactWindow } from './map-types';
import { Globe, X, RotateCw, Radio, Sun, Moon } from 'lucide-react';

/**
 * Calculates whether a satellite is in Earth's shadow cone (Umbra)
 * given its geodetic position and current UTC solar vector.
 */
export function isSatelliteInEclipse(latDeg: number, lonDeg: number, altKm: number, date: Date = new Date()): boolean {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  const decRad = (-23.44 * Math.PI / 180) * Math.cos((2 * Math.PI / 365.25) * (dayOfYear + 10));
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subsolarLonDeg = (12 - utcHours) * 15;
  const subsolarLonRad = (subsolarLonDeg * Math.PI) / 180;

  const Sx = Math.cos(decRad) * Math.cos(subsolarLonRad);
  const Sy = Math.cos(decRad) * Math.sin(subsolarLonRad);
  const Sz = Math.sin(decRad);

  const RE = 6371; // km
  const r = RE + altKm;
  const latRad = (latDeg * Math.PI) / 180;
  const lonRad = (lonDeg * Math.PI) / 180;

  const Px = r * Math.cos(latRad) * Math.cos(lonRad);
  const Py = r * Math.cos(latRad) * Math.sin(lonRad);
  const Pz = r * Math.sin(latRad);

  const dot = Px * Sx + Py * Sy + Pz * Sz;
  const distSq = (r * r) - (dot * dot);

  return dot < 0 && distSq < (RE * RE);
}

interface SatelliteDetailPanelProps {
  selected: SatellitePosition | GroundStation | null;
  windows?: ContactWindow[];
  stations?: GroundStation[];
  isPivotMode?: boolean;
  onTogglePivot?: () => void;
  onClose: () => void;
}

export const SatelliteDetailPanel: React.FC<SatelliteDetailPanelProps> = ({
  selected,
  windows = [],
  stations = [],
  isPivotMode = false,
  onTogglePivot,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'telemetry' | 'passes'>('telemetry');

  if (!selected) {
    return (
      <div className="glass-panel" style={{ padding: '1.25rem', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <Globe size={32} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Click any satellite or ground station on the globe to inspect telemetry
        </div>
      </div>
    );
  }

  const isSatellite = 'noradId' in selected;
  const inEclipse = isSatellite
    ? isSatelliteInEclipse(selected.latitude, selected.longitude, (selected as SatellitePosition).altitudeKm)
    : false;

  // Filter contact windows matching this entity
  const relevantWindows = windows.filter(w => {
    if (isSatellite) {
      return w.satelliteId === (selected as SatellitePosition).satelliteId;
    } else {
      return w.groundStationId === (selected as GroundStation).id;
    }
  });

  return (
    <div className="glass-panel" style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--accent-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            {isSatellite ? 'Satellite In Orbit' : 'Ground Tracking Station'}
          </div>
          <div style={{ fontWeight: 700, fontSize: '0.92rem', lineHeight: 1.3, marginTop: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selected.name}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.2rem', display: 'flex', alignItems: 'center' }}
          title="Return to global view"
        >
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.35rem', background: 'rgba(0,0,0,0.25)', padding: '0.2rem', borderRadius: '6px' }}>
        <button
          onClick={() => setActiveTab('telemetry')}
          style={{
            flex: 1,
            padding: '0.3rem',
            fontSize: '0.72rem',
            borderRadius: '4px',
            border: 'none',
            background: activeTab === 'telemetry' ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
            color: activeTab === 'telemetry' ? '#38bdf8' : 'var(--text-muted)',
            fontWeight: activeTab === 'telemetry' ? 600 : 400,
            cursor: 'pointer',
          }}
        >
          Telemetry
        </button>
        <button
          onClick={() => setActiveTab('passes')}
          style={{
            flex: 1,
            padding: '0.3rem',
            fontSize: '0.72rem',
            borderRadius: '4px',
            border: 'none',
            background: activeTab === 'passes' ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
            color: activeTab === 'passes' ? '#38bdf8' : 'var(--text-muted)',
            fontWeight: activeTab === 'passes' ? 600 : 400,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.3rem',
          }}
        >
          Passes ({relevantWindows.length})
        </button>
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', minHeight: 0 }}>
        {activeTab === 'telemetry' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {isSatellite ? (
              <>
                <DetailRow label="NORAD ID" value={String((selected as SatellitePosition).noradId)} />
                <DetailRow label="Regime" value={(selected as SatellitePosition).altitudeKm > 30000 ? 'GEO' : ((selected as SatellitePosition).altitudeKm >= 2000 ? 'MEO' : 'LEO')} />
                <DetailRow label="Latitude" value={`${selected.latitude.toFixed(4)}°`} />
                <DetailRow label="Longitude" value={`${selected.longitude.toFixed(4)}°`} />
                <DetailRow label="Altitude" value={`${(selected as SatellitePosition).altitudeKm} km`} />
                <DetailRow label="Source" value={(selected as SatellitePosition).source} />
                <div style={{
                  marginTop: '0.4rem',
                  padding: '0.45rem 0.65rem',
                  borderRadius: '6px',
                  background: inEclipse ? 'rgba(239, 68, 68, 0.12)' : 'rgba(56, 189, 248, 0.08)',
                  border: inEclipse ? '1px solid rgba(239, 68, 68, 0.35)' : '1px solid rgba(56, 189, 248, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  fontSize: '0.75rem',
                  color: inEclipse ? '#f87171' : '#38bdf8',
                }}>
                  {inEclipse ? <Moon size={14} /> : <Sun size={14} />}
                  <span>{inEclipse ? 'Power: In Eclipse (Battery Reserve)' : 'Power: Direct Sunlight (100% Solar)'}</span>
                </div>
              </>
            ) : (
              <>
                <DetailRow label="Station Code" value={(selected as GroundStation).code} />
                <DetailRow label="Latitude" value={`${selected.latitude.toFixed(4)}°`} />
                <DetailRow label="Longitude" value={`${selected.longitude.toFixed(4)}°`} />
                <DetailRow label="Elevation" value={`${(selected as GroundStation).altitudeM} m`} />
                <DetailRow label="Min Mask" value={`${(selected as GroundStation).minimumElevationDeg}°`} />
                <DetailRow label="Status" value={(selected as GroundStation).status} />
                <div style={{
                  marginTop: '0.4rem',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  background: 'rgba(250, 204, 21, 0.08)',
                  border: '1px solid rgba(250, 204, 21, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontSize: '0.75rem',
                  color: '#facc15',
                }}>
                  <Radio size={14} />
                  <span>Antenna Array: Operational Ready</span>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {relevantWindows.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', textAlign: 'center', padding: '1rem 0' }}>
                No active contact passes scheduled in reference window.
              </div>
            ) : (
              relevantWindows.slice(0, 5).map(w => {
                const targetLabel = isSatellite ? (w.groundStationName || w.groundStationId) : (w.satelliteName || w.satelliteId);
                const startTime = new Date(w.aos).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const endTime = new Date(w.los).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                return (
                  <div
                    key={w.id}
                    style={{
                      padding: '0.45rem 0.6rem',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.78rem', color: '#fff' }}>{targetLabel}</span>
                      <span style={{
                        fontSize: '0.65rem',
                        padding: '0.1rem 0.35rem',
                        borderRadius: '4px',
                        background: w.status === 'ACTIVE' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(56, 189, 248, 0.15)',
                        color: w.status === 'ACTIVE' ? '#4ade80' : '#38bdf8',
                        fontWeight: 600,
                      }}>
                        {w.status || 'SCHEDULED'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      AOS: {startTime} → LOS: {endTime}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: 'auto', paddingTop: '0.4rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {onTogglePivot && (
          <button
            className="btn btn-outline"
            onClick={onTogglePivot}
            style={{
              padding: '0.45rem',
              fontSize: '0.78rem',
              color: isPivotMode ? '#38bdf8' : 'var(--text-secondary)',
              borderColor: isPivotMode ? '#38bdf8' : 'var(--border-color)',
              background: isPivotMode ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title={isPivotMode ? "Exit 360° orbit pivot and unlock camera" : "Lock this object as center and rotate 360° around it"}
          >
            <RotateCw size={14} /> {isPivotMode ? 'Exit 360° Pivot Mode' : '360° Orbit Pivot View'}
          </button>
        )}

        <button 
          className="btn btn-outline"
          onClick={onClose}
          style={{ padding: '0.45rem', fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', borderRadius: '6px' }}
          title="Reset camera and return to global Earth view"
        >
          <Globe size={14} /> Reset to Global View
        </button>
      </div>
    </div>
  );
};

const DetailRow = ({ label, value }: { label: string, value: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', textAlign: 'right', maxWidth: '140px', wordBreak: 'break-all' }}>
      {value}
    </span>
  </div>
);
