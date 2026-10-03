import React from 'react';
import { SkyTarget, SkyTrackPoint } from './sky-coordinates';

interface PolarSkyPlotProps {
  stationCode: string;
  minElevationDeg: number;
  primaryTarget: SkyTarget | null;
  secondaryTargets?: SkyTarget[];
  trackPoints?: SkyTrackPoint[];
  width?: number;
  height?: number;
}

export const PolarSkyPlot: React.FC<PolarSkyPlotProps> = ({
  stationCode,
  minElevationDeg = 10,
  primaryTarget,
  secondaryTargets = [],
  trackPoints = [],
  width = 240,
  height = 195,
}) => {
  const cx = width / 2;
  const cy = height / 2 + 4;
  const maxRadius = Math.min(cx, cy) - 22;

  // Convert (azimuth, elevation) to 2D (x, y) coordinates
  const toXY = (azimuthDeg: number, elevationDeg: number) => {
    const clampedElev = Math.max(0, Math.min(90, elevationDeg));
    const r = maxRadius * ((90 - clampedElev) / 90);
    const azRad = (azimuthDeg * Math.PI) / 180;
    return {
      x: cx + r * Math.sin(azRad),
      y: cy - r * Math.cos(azRad),
    };
  };

  // Mask ring radius
  const maskRadius = maxRadius * ((90 - minElevationDeg) / 90);

  // Primary blip position
  const hasTarget = Boolean(primaryTarget);
  const isAboveHorizon = primaryTarget ? primaryTarget.elevation >= 0 : false;
  const primaryPos = primaryTarget ? toXY(primaryTarget.azimuth, primaryTarget.elevation) : { x: cx, y: cy };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
        <span>ZENITH SKY RADAR (AZ/EL)</span>
        <span style={{ color: '#facc15' }}>MASK: {minElevationDeg}°</span>
      </div>

      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        {/* Background dark circle */}
        <circle cx={cx} cy={cy} r={maxRadius} fill="rgba(10, 15, 29, 0.95)" stroke="rgba(255, 255, 255, 0.15)" strokeWidth={1} />

        {/* Concentric Elevation Rings: 30° and 60° */}
        <circle cx={cx} cy={cy} r={maxRadius * (60 / 90)} fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeDasharray="2,2" />
        <circle cx={cx} cy={cy} r={maxRadius * (30 / 90)} fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeDasharray="2,2" />

        {/* Minimum Horizon Mask ring */}
        <circle cx={cx} cy={cy} r={maskRadius} fill="none" stroke="rgba(250, 204, 21, 0.35)" strokeWidth={1.2} />

        {/* Crosshairs: N-S, E-W */}
        <line x1={cx} y1={cy - maxRadius} x2={cx} y2={cy + maxRadius} stroke="rgba(255, 255, 255, 0.1)" strokeWidth={1} />
        <line x1={cx - maxRadius} y1={cy} x2={cx + maxRadius} y2={cy} stroke="rgba(255, 255, 255, 0.1)" strokeWidth={1} />

        {/* Cardinal Direction Labels */}
        <text x={cx} y={cy - maxRadius - 6} fill="#38bdf8" fontSize={10} fontWeight="bold" textAnchor="middle">N</text>
        <text x={cx + maxRadius + 10} y={cy + 3} fill="var(--text-muted)" fontSize={9} textAnchor="start">E</text>
        <text x={cx} y={cy + maxRadius + 14} fill="var(--text-muted)" fontSize={9} textAnchor="middle">S</text>
        <text x={cx - maxRadius - 10} y={cy + 3} fill="var(--text-muted)" fontSize={9} textAnchor="end">W</text>

        {/* Elevation Ring Markers */}
        <text x={cx + 3} y={cy - maxRadius * (60 / 90) + 3} fill="rgba(255,255,255,0.3)" fontSize={8}>30°</text>
        <text x={cx + 3} y={cy - maxRadius * (30 / 90) + 3} fill="rgba(255,255,255,0.3)" fontSize={8}>60°</text>
        <text x={cx} y={cy} fill="rgba(255,255,255,0.5)" fontSize={10} textAnchor="middle" dominantBaseline="central">+</text>

        {/* Active Track Path across sky */}
        {trackPoints.length > 1 && (
          <path
            d={trackPoints.map((pt, i) => {
              const { x, y } = toXY(pt.azimuthDeg, pt.elevationDeg);
              return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
            }).join(' ')}
            fill="none"
            stroke={primaryTarget?.isActivePass ? '#facc15' : '#38bdf8'}
            strokeWidth={1.8}
            strokeDasharray="3,2"
            opacity={0.8}
          />
        )}

        {/* Secondary Satellites currently above horizon */}
        {secondaryTargets.map((sec) => {
          const pos = toXY(sec.azimuth, sec.elevation);
          return (
            <g key={sec.satellite.satelliteId}>
              <circle cx={pos.x} cy={pos.y} r={2.5} fill="rgba(148, 163, 184, 0.7)" />
              <text x={pos.x + 4} y={pos.y - 3} fill="rgba(148, 163, 184, 0.6)" fontSize={7}>
                {sec.satellite.name.substring(0, 6)}
              </text>
            </g>
          );
        })}

        {/* Primary Target Satellite Blip */}
        {primaryTarget && isAboveHorizon && (
          <g>
            <circle
              cx={primaryPos.x}
              cy={primaryPos.y}
              r={8}
              fill={primaryTarget.isActivePass ? 'rgba(250, 204, 21, 0.3)' : (primaryTarget.isInBeam ? 'rgba(56, 189, 248, 0.25)' : 'rgba(245, 158, 11, 0.15)')}
            />
            <circle
              cx={primaryPos.x}
              cy={primaryPos.y}
              r={4.5}
              fill={primaryTarget.isActivePass ? '#facc15' : (primaryTarget.isInBeam ? '#38bdf8' : '#f59e0b')}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={primaryPos.x + 7}
              y={primaryPos.y - 5}
              fill="#fff"
              fontSize={8.5}
              fontWeight="bold"
              fontFamily="var(--font-mono)"
            >
              {primaryTarget.satellite.name.substring(0, 10)} ({primaryTarget.elevation.toFixed(0)}°)
            </text>
          </g>
        )}
      </svg>

      {/* Real-Time Mathematical Telemetry Readout */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.2rem',
        width: '100%',
        fontSize: '0.72rem',
        fontFamily: 'var(--font-mono)',
        color: '#fff',
        marginTop: '0.35rem',
        padding: '0.35rem 0.5rem',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.08)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>TARGET:</span>
          <span style={{ fontWeight: 600, color: primaryTarget?.isActivePass ? '#facc15' : '#38bdf8', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {primaryTarget ? primaryTarget.satellite.name : 'NO SATS OVERHEAD'}
          </span>
        </div>

        {primaryTarget && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
              <span>AZ: <span style={{ color: '#38bdf8' }}>{primaryTarget.azimuth.toFixed(1)}° ({primaryTarget.compass})</span></span>
              <span>EL: <span style={{ color: primaryTarget.isInBeam ? '#4ade80' : '#facc15' }}>{primaryTarget.elevation.toFixed(1)}°</span></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
              <span>RANGE: {Math.round(primaryTarget.slantRangeKm).toLocaleString()} km</span>
              <span style={{ fontWeight: 600, color: primaryTarget.isActivePass ? '#facc15' : (primaryTarget.isInBeam ? '#4ade80' : '#f87171') }}>
                {primaryTarget.isActivePass ? '⚡ ACTIVE PASS' : (primaryTarget.isInBeam ? '● IN-BEAM' : (isAboveHorizon ? '○ BELOW MASK' : '○ BELOW HORIZON'))}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
