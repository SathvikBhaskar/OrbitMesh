import React, { useEffect } from 'react';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Viewer, ImageryLayer, useCesium } from 'resium';
import {
  Ion,
  UrlTemplateImageryProvider,
  Credit,
  Color,
  Cartesian3,
  Matrix4,
  ScreenSpaceEventType,
  HeadingPitchRange,
  Math as CesiumMath,
  BoundingSphere,
} from 'cesium';

// Disable Ion completely — no token required
Ion.defaultAccessToken = '';

/**
 * Photorealistic True-Color Earth Imagery Provider (ESRI World Imagery)
 * ─────────────────────────────────────────────────────────────────────
 * Full-color real satellite photography of Earth from space with vivid
 * oceans, continental vegetation, deserts, and polar ice caps.
 */
const SATELLITE_IMAGERY_PROVIDER = new UrlTemplateImageryProvider({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  credit: new Credit('Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'),
  maximumLevel: 19,
});

export interface CesiumViewerActions {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  exitPivot: () => void;
}

export interface CesiumViewerProps {
  children?: React.ReactNode;
  flyToTarget?: {
    latitude: number;
    longitude: number;
    altitudeKm?: number;
    zoomClose?: boolean;
    isPivot?: boolean;
    name?: string;
  } | null;
  resetViewTrigger?: number;
  enableLighting?: boolean;
  onViewerReady?: (actions: CesiumViewerActions) => void;
}

const MIN_ZOOM_METERS = 150_000;    // 150 km above ground (stops terrain clipping)
const MAX_ZOOM_METERS = 35_000_000; // 35,000 km (Earth system cleanly framed, geostationary orbits visible, stops infinite zoom-out)

const CesiumGlobeInitializer: React.FC<{
  flyToTarget?: {
    latitude: number;
    longitude: number;
    altitudeKm?: number;
    zoomClose?: boolean;
    isPivot?: boolean;
    name?: string;
  } | null;
  resetViewTrigger?: number;
  enableLighting?: boolean;
  onViewerReady?: (actions: CesiumViewerActions) => void;
}> = ({ flyToTarget, resetViewTrigger, enableLighting, onViewerReady }) => {
  const { viewer } = useCesium();

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    (window as any).__cesiumViewer = viewer;

    // Atmospheric and globe aesthetics: natural space contrast & realistic Earth glow
    viewer.scene.globe.baseColor = Color.fromCssColorString('#020b14');
    viewer.scene.globe.enableLighting = Boolean(enableLighting);
    viewer.scene.globe.showGroundAtmosphere = true;

    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.brightnessShift = 0.05;
    viewer.scene.skyAtmosphere.saturationShift = 0.1;

    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.0001;
    viewer.scene.backgroundColor = Color.BLACK;

    // Camera Controller Optimization:
    // Tight inertia, collision detection, and bounded zoom distances
    const controller = viewer.scene.screenSpaceCameraController;
    controller.enableCollisionDetection = true;
    controller.minimumZoomDistance = 10_000; // Allow close inspection in 3D pivot mode
    controller.maximumZoomDistance = MAX_ZOOM_METERS;
    controller.inertiaZoom = 0.05; // Crisp, instant stopping on scroll
    controller.inertiaSpin = 0.08; // Responsive panning without floaty drift
    controller.inertiaTranslate = 0.08;
    controller.zoomFactor = 2.0;

    // PREVENT INVERTED/DOWNWARD MOUSE DRAG ISSUE:
    // Intercept Cesium's default double-click entity tracking behavior.
    // By default, Cesium's double click attaches a tracking frame to the satellite in orbit,
    // which tilts and inverts the camera axes.
    viewer.screenSpaceEventHandler.setInputAction(() => {
      viewer.trackedEntity = undefined;
      viewer.selectedEntity = undefined;
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // Initial camera view: standard Earth overview, North is strictly UP (heading 0), looking straight down (pitch -90°)
    viewer.trackedEntity = undefined;
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(0, 20, 25_000_000),
      orientation: {
        heading: 0.0,
        pitch: -Math.PI / 2,
        roll: 0.0,
      },
    });

    // HARD BOUNDS ENFORCEMENT:
    // Ensure camera can NEVER zoom out past MAX_ZOOM_METERS or clip under MIN_ZOOM_METERS
    const removePreRender = viewer.scene.preRender.addEventListener(() => {
      if (!viewer || viewer.isDestroyed()) return;
      // When in local 360° object pivot mode, transform is anchored to the target object.
      // Do not clamp cartographic height in local transform space.
      if (!viewer.camera.transform.equals(Matrix4.IDENTITY)) return;

      const carto = viewer.camera.positionCartographic;
      if (carto) {
        if (carto.height > MAX_ZOOM_METERS) {
          carto.height = MAX_ZOOM_METERS;
          viewer.camera.position = viewer.scene.globe.ellipsoid.cartographicToCartesian(carto);
        } else if (carto.height < MIN_ZOOM_METERS && controller.enableCollisionDetection) {
          carto.height = MIN_ZOOM_METERS;
          viewer.camera.position = viewer.scene.globe.ellipsoid.cartographicToCartesian(carto);
        }
      }
    });

    const executeResetView = () => {
      if (!viewer || viewer.isDestroyed()) return;
      // 1. Break entity tracking and reset transform frame to standard Earth-centered fixed
      viewer.trackedEntity = undefined;
      viewer.selectedEntity = undefined;
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);

      // 2. Fly back to standard overview with North UP (heading=0) and looking straight down (pitch=-90°)
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(0, 20, 25_000_000),
        orientation: {
          heading: 0.0,
          pitch: -Math.PI / 2,
          roll: 0.0,
        },
        duration: 1.2,
      });
    };

    if (onViewerReady) {
      onViewerReady({
        zoomIn: () => {
          if (!viewer || viewer.isDestroyed()) return;
          if (!viewer.camera.transform.equals(Matrix4.IDENTITY)) {
            const dist = Cartesian3.magnitude(viewer.camera.position);
            const step = Math.max(dist * 0.25, 10_000);
            viewer.camera.zoomIn(step);
            return;
          }
          const carto = viewer.camera.positionCartographic;
          if (!carto) return;
          if (carto.height <= MIN_ZOOM_METERS) return;
          const step = Math.min(Math.max(carto.height * 0.3, 50_000), carto.height - MIN_ZOOM_METERS);
          viewer.camera.zoomIn(step);
        },
        zoomOut: () => {
          if (!viewer || viewer.isDestroyed()) return;
          if (!viewer.camera.transform.equals(Matrix4.IDENTITY)) {
            const dist = Cartesian3.magnitude(viewer.camera.position);
            const step = Math.max(dist * 0.25, 20_000);
            viewer.camera.zoomOut(step);
            return;
          }
          const carto = viewer.camera.positionCartographic;
          if (!carto) return;
          if (carto.height >= MAX_ZOOM_METERS) return;
          const step = Math.min(Math.max(carto.height * 0.3, 100_000), MAX_ZOOM_METERS - carto.height);
          viewer.camera.zoomOut(step);
        },
        resetView: executeResetView,
        exitPivot: () => {
          if (!viewer || viewer.isDestroyed()) return;
          viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        },
      });
    }

    return () => {
      removePreRender();
    };
  }, [viewer]);

  useEffect(() => {
    if (!resetViewTrigger || !viewer || viewer.isDestroyed()) return;
    viewer.trackedEntity = undefined;
    viewer.selectedEntity = undefined;
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(0, 20, 25_000_000),
      orientation: {
        heading: 0.0,
        pitch: -Math.PI / 2,
        roll: 0.0,
      },
      duration: 1.2,
    });
  }, [resetViewTrigger, viewer]);

  useEffect(() => {
    if (!flyToTarget || !viewer || viewer.isDestroyed()) return;

    if (flyToTarget.isPivot) {
      // ─────────────────────────────────────────────────────────────
      // OPTION B: 360° OBJECT PIVOT INSPECTION MODE
      // ─────────────────────────────────────────────────────────────
      // Anchor the camera directly to the satellite or ground station
      // allowing full 360-degree rotation around the object with mouse
      // dragging, revealing Earth, orbits, and deep space from all angles.
      viewer.trackedEntity = undefined;
      viewer.selectedEntity = undefined;
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);

      const targetPos = Cartesian3.fromDegrees(
        flyToTarget.longitude,
        flyToTarget.latitude,
        (flyToTarget.altitudeKm ?? 0) * 1000
      );

      const baseAlt = flyToTarget.altitudeKm ?? 700;
      const range = baseAlt > 30000
        ? 1_200_000
        : baseAlt > 100
          ? 350_000
          : 60_000;

      const offset = new HeadingPitchRange(
        0.0,
        CesiumMath.toRadians(-25), // -25° pitch reveals Earth horizon backdrop
        range
      );

      const boundingSphere = new BoundingSphere(targetPos, 500);

      viewer.camera.flyToBoundingSphere(boundingSphere, {
        offset,
        duration: 1.0,
        complete: () => {
          if (!viewer || viewer.isDestroyed()) return;
          viewer.camera.lookAt(targetPos, offset);
        },
      });
    } else {
      // ─────────────────────────────────────────────────────────────
      // STANDARD PLANETARY OVERVIEW MODE (SINGLE CLICK / SELECTOR)
      // ─────────────────────────────────────────────────────────────
      // Unlock any prior pivot, ensuring mouse drag pans globe naturally
      viewer.trackedEntity = undefined;
      viewer.selectedEntity = undefined;
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);

      const baseAlt = flyToTarget.altitudeKm ?? 700;
      const alt = (baseAlt * 1000) + 3_500_000;

      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(flyToTarget.longitude, flyToTarget.latitude, alt),
        orientation: {
          heading: 0.0,
          pitch: -Math.PI / 2,
          roll: 0.0,
        },
        duration: 1.0,
      });
    }
  }, [flyToTarget, viewer]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    viewer.scene.globe.enableLighting = Boolean(enableLighting);
  }, [enableLighting, viewer]);

  return null;
};

export const CesiumViewer: React.FC<CesiumViewerProps> = ({
  children,
  flyToTarget,
  resetViewTrigger,
  enableLighting,
  onViewerReady
}) => {
  return (
    <Viewer
      full
      animation={false}
      timeline={false}
      baseLayerPicker={false}
      baseLayer={false}
      selectionIndicator={false}
      geocoder={false}
      homeButton={false}
      infoBox={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      style={{ width: '100%', height: '100%' }}
    >
      <ImageryLayer imageryProvider={SATELLITE_IMAGERY_PROVIDER} />
      <CesiumGlobeInitializer
        flyToTarget={flyToTarget}
        resetViewTrigger={resetViewTrigger}
        enableLighting={enableLighting}
        onViewerReady={onViewerReady}
      />
      {children}
    </Viewer>
  );
};
