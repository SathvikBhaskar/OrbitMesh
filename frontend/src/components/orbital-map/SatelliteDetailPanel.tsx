import React from 'react';
import { SatellitePosition, GroundStation } from './map-types';
import { Globe, X, RotateCw } from 'lucide-react';

interface SatelliteDetailPanelProps {
  selected: SatellitePosition | GroundStation | null;
  isPivotMode?: boolean;
  onTogglePivot?: () => void;
  onClose: () => void;
}

export const SatelliteDetailPanel: React.FC<SatelliteDetailPanelProps> = ({
  selected,
  isPivotMode = false,
  onTogglePivot,
  onClose,
}) => {
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

  return (
    <div className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--accent-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {isSatellite ? 'Satellite In Orbit' : 'Ground Tracking Station'}
          </div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1.3, marginTop: '0.15rem' }}>{selected.name}</div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.2rem', display: 'flex', alignItems: 'center' }}
          title="Return to global view"
        >
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
        {isSatellite ? (
          <>
            <DetailRow label="NORAD ID" value={String((selected as SatellitePosition).noradId)} />
            <DetailRow label="Latitude" value={`${selected.latitude.toFixed(4)}°`} />
            <DetailRow label="Longitude" value={`${selected.longitude.toFixed(4)}°`} />
            <DetailRow label="Altitude" value={`${(selected as SatellitePosition).altitudeKm} km`} />
            <DetailRow label="Source" value={(selected as SatellitePosition).source} />
          </>
        ) : (
          <>
            <DetailRow label="Station Code" value={(selected as GroundStation).code} />
            <DetailRow label="Latitude" value={`${selected.latitude.toFixed(4)}°`} />
            <DetailRow label="Longitude" value={`${selected.longitude.toFixed(4)}°`} />
            <DetailRow label="Elevation" value={`${(selected as GroundStation).altitudeM} m`} />
            <DetailRow label="Min Horizon" value={`${(selected as GroundStation).minimumElevationDeg}°`} />
            <DetailRow label="Status" value={(selected as GroundStation).status} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: 'auto' }}>
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
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', textAlign: 'right', maxWidth: '140px', wordBreak: 'break-all' }}>
      {value}
    </span>
  </div>
);
