import React from 'react';

interface SkyTrackPoint {
  azimuthDeg: number;
  elevationDeg: number;
  label?: string;
}

interface PolarSkyPlotProps {
  stationCode: string;
  minElevationDeg: number;
  currentAzimuth?: number;
  currentElevation?: number;
  trackPoints?: SkyTrackPoint[];
  targetName?: string;
  width?: number;
  height?: number;
}

export const PolarSkyPlot: React.FC<PolarSkyPlotProps> = ({
  stationCode,
  minElevationDeg = 10,
  currentAzimuth = 45,
  currentElevation = 38,
  trackPoints = [],
  targetName,
  width = 240,
  height = 200,
}) => {
  const cx = width / 2;
  const cy = height / 2 + 6;
  const maxRadius = Math.min(cx, cy) - 24;

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

  // Current blip position
  const currentPos = toXY(currentAzimuth, currentElevation);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
        <span>ZENITH SKY TRACK (AZ/EL)</span>
        <span style={{ color: '#facc15' }}>MASK: {minElevationDeg}°</span>
      </div>

      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        {/* Background dark circle */}
        <circle cx={cx} cy={cy} r={maxRadius} fill="rgba(10, 15, 29, 0.9)" stroke="rgba(255, 255, 255, 0.15)" strokeWidth={1} />

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

        {/* Active Track Path */}
        {trackPoints.length > 1 && (
          <path
            d={trackPoints.map((pt, i) => {
              const { x, y } = toXY(pt.azimuthDeg, pt.elevationDeg);
              return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
            }).join(' ')}
            fill="none"
            stroke="#facc15"
            strokeWidth={2}
            strokeDasharray="4,2"
          />
        )}

        {/* Current Target Satellite Blip */}
        <circle cx={currentPos.x} cy={currentPos.y} r={7} fill="rgba(56, 189, 248, 0.25)" />
        <circle cx={currentPos.x} cy={currentPos.y} r={4} fill="#38bdf8" stroke="#fff" strokeWidth={1.5} />

        {/* Current Blip Az/El label */}
        <text
          x={currentPos.x + 8}
          y={currentPos.y - 6}
          fill="#fff"
          fontSize={9}
          fontWeight="bold"
          fontFamily="var(--font-mono)"
        >
          {targetName ? `${targetName.substring(0, 10)}: ` : ''}{currentElevation.toFixed(0)}° EL
        </text>
      </svg>

      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: '#fff', marginTop: '0.3rem', padding: '0.2rem 0.4rem', background: 'rgba(255,255,255,0.04)', borderRadius: '4px' }}>
        <span>AZ: <span style={{ color: '#38bdf8' }}>{currentAzimuth.toFixed(1)}°</span></span>
        <span>EL: <span style={{ color: '#38bdf8' }}>{currentElevation.toFixed(1)}°</span></span>
        <span style={{ color: currentElevation >= minElevationDeg ? '#4ade80' : '#f87171' }}>
          {currentElevation >= minElevationDeg ? '● IN-BEAM' : '○ BELOW MASK'}
        </span>
      </div>
    </div>
  );
};
