import React, { useMemo } from 'react';
import { Entity, PolylineGraphics, LabelGraphics } from 'resium';
import { Cartesian3, Color, PolylineGlowMaterialProperty, PolylineDashMaterialProperty, Cartesian2, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { ContactWindow, SatellitePosition, GroundStation } from './map-types';

interface ContactWindowLayerProps {
  windows: ContactWindow[];
  satellites: SatellitePosition[];
  stations: GroundStation[];
  selectedSatelliteId?: string;
  simTime?: Date;
}

export const ContactWindowLayer: React.FC<ContactWindowLayerProps> = ({
  windows,
  satellites,
  stations,
  selectedSatelliteId,
  simTime
}) => {
  const currentTimestamp = (simTime || new Date()).getTime();

  // Active windows occurring right now (strictly in-pass relative to simulated time)
  const activeWindows = windows.filter((w) => {
    const aos = new Date(w.aos).getTime();
    const los = new Date(w.los).getTime();
    return currentTimestamp >= aos && currentTimestamp <= los;
  });

  // Upcoming windows within 45 minutes
  const upcomingWindows = windows.filter((w) => {
    const aos = new Date(w.aos).getTime();
    return aos > currentTimestamp && aos <= currentTimestamp + 45 * 60 * 1000;
  });

  // If a satellite is focused/selected, prioritize its beams; otherwise show active passes + top 3 upcoming
  const relevantWindows = selectedSatelliteId
    ? windows.filter(w => {
        const los = new Date(w.los).getTime();
        const aos = new Date(w.aos).getTime();
        return w.satelliteId === selectedSatelliteId && los >= currentTimestamp && aos <= currentTimestamp + 90 * 60 * 1000;
      })
    : [...activeWindows, ...upcomingWindows.slice(0, 3)];

  const displayWindows = relevantWindows.slice(0, 6);

  return (
    <>
      {displayWindows.map((w) => {
        const sat = satellites.find((s) => s.satelliteId === w.satelliteId);
        const gs = stations.find((s) => s.id === w.groundStationId);

        if (!sat || !gs) return null;

        const aosTime = new Date(w.aos).getTime();
        const losTime = new Date(w.los).getTime();
        const isActive = currentTimestamp >= aosTime && currentTimestamp <= losTime;

        const gsPos = Cartesian3.fromDegrees(gs.longitude, gs.latitude, gs.altitudeM);
        const satPos = Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitudeKm * 1000);

        const positions = [gsPos, satPos];
        const midPoint = Cartesian3.midpoint(gsPos, satPos, new Cartesian3());

        // Dynamic RF link throughput calculation based on altitude
        const bitrateMbps = sat.altitudeKm > 30000 ? 50 : 450;
        const snrDb = isActive ? (12.4 + (Math.sin(currentTimestamp / 10000) * 2.1)).toFixed(1) : '0.0';

        return (
          <React.Fragment key={w.id}>
            <Entity name={`Link ${sat.name} ↔ ${gs.code}`}>
              <PolylineGraphics
                positions={positions}
                width={isActive ? 4 : 2}
                material={
                  isActive
                    ? new PolylineGlowMaterialProperty({
                        glowPower: 0.35,
                        taperPower: 0.8,
                        color: Color.fromCssColorString('#facc15'),
                      })
                    : new PolylineDashMaterialProperty({
                        color: Color.fromCssColorString('#38bdf8').withAlpha(0.6),
                        gapColor: Color.TRANSPARENT,
                        dashLength: 16.0,
                      })
                }
              />
            </Entity>

            {/* Active Link Data Stream HUD Badge */}
            {isActive && (
              <Entity position={midPoint}>
                <LabelGraphics
                  text={`⚡ ${bitrateMbps} Mbps X-Band · SNR ${snrDb} dB`}
                  font="bold 11px sans-serif"
                  fillColor={Color.WHITE}
                  showBackground={true}
                  backgroundColor={new Color(0.08, 0.12, 0.22, 0.9)}
                  outlineColor={Color.fromCssColorString('#facc15')}
                  outlineWidth={1}
                  pixelOffset={new Cartesian2(0, -12)}
                  horizontalOrigin={HorizontalOrigin.CENTER}
                  verticalOrigin={VerticalOrigin.BOTTOM}
                />
              </Entity>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};
