import React from 'react';
import { SatellitePosition, GroundStation } from './map-types';

interface SatelliteDetailPanelProps {
  selected: SatellitePosition | GroundStation | null;
  onClose: () => void;
}

export const SatelliteDetailPanel: React.FC<SatelliteDetailPanelProps> = ({ selected, onClose }) => {
  if (!selected) {
    return (
      <div className="glass-panel" style={{ padding: '1.25rem', height: '100%' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
          Click an entity on the globe to view details
        </div>
      </div>
    );
  }

  const isSatellite = 'noradId' in selected;

  return (
    <div className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', lineHeight: 1.3 }}>{selected.name}</div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
        >×</button>
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
            <DetailRow label="Code" value={(selected as GroundStation).code} />
            <DetailRow label="Latitude" value={`${selected.latitude.toFixed(4)}°`} />
            <DetailRow label="Longitude" value={`${selected.longitude.toFixed(4)}°`} />
            <DetailRow label="Elevation" value={`${(selected as GroundStation).altitudeM} m`} />
            <DetailRow label="Min Elev" value={`${(selected as GroundStation).minimumElevationDeg}°`} />
            <DetailRow label="Status" value={(selected as GroundStation).status} />
          </>
        )}
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
