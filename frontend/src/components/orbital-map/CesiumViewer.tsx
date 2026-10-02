import React, { useEffect, useRef } from 'react';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Viewer } from 'resium';
import {
  Ion,
  UrlTemplateImageryProvider,
  ImageryLayer,
  Credit,
  Color,
  Cartesian3,
} from 'cesium';

// Disable Ion completely — no token required
Ion.defaultAccessToken = '';

/**
 * Imagery Strategy — Synchronous CartoDB Voyager Provider
 * ─────────────────────────────────────────────────────────
 * We use UrlTemplateImageryProvider with CartoDB Voyager tiles.
 * In modern Cesium (v1.100+), the viewer option is `baseLayer` (an ImageryLayer),
 * NOT `imageryProvider`. Passing `baseLayer` ensures frame 0 is constructed
 * with the correct layer. We also enforce it explicitly in useEffect
 * and set `globe.baseColor` to deep navy (#0d1b2a) so the globe is never bright blue.
 */
const IMAGERY_PROVIDER = new UrlTemplateImageryProvider({
  url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  credit: new Credit('© OpenStreetMap contributors, © CARTO'),
  maximumLevel: 18,
});

export const CesiumViewer: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement;
    if (!viewer || viewer.isDestroyed()) return;

    // Explicitly configure imagery layer & fallback base color
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.add(new ImageryLayer(IMAGERY_PROVIDER));
    viewer.scene.globe.baseColor = Color.fromCssColorString('#0d1b2a');

    // ── Scene settings (applied once on mount) ─────────────────────────
    viewer.scene.globe.enableLighting = true;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.0002;
    viewer.scene.backgroundColor = Color.BLACK;

    // ── Camera: full Earth view ─────────────────────────────────────────
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 20, 25_000_000),
    });
  }, []); // runs once on mount only

  return (
    <Viewer
      ref={viewerRef}
      full
      animation={false}
      timeline={false}
      baseLayerPicker={false}
      baseLayer={new ImageryLayer(IMAGERY_PROVIDER)}
      geocoder={false}
      homeButton={false}
      infoBox={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      style={{ width: '100%', height: '100%' }}
    >
      {children}
    </Viewer>
  );
};
