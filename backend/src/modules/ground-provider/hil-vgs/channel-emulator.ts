/**
 * Phase 5.8: Workstream 5.8.4 — Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)
 * Space-to-Ground Physical Channel Propagation & SDR RF Emulator
 */

import { logger } from "../../../config/logger";

export interface GroundLocation {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly altitudeM: number;
}

export interface SatelliteOrbitParams {
  readonly semiMajorAxisKm: number; // e.g. 6900 km for 520 km LEO
  readonly inclinationDeg: number;   // e.g. 97.5 deg
  readonly carrierFrequencyHz: number; // e.g. 2.245e9 (S-band) or 8.25e9 (X-band)
  readonly txPowerDbm: number;       // e.g. +40 dBm (10W EIRP)
}

export interface ChannelMetricsSnapshot {
  readonly timestamp: Date;
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly slantRangeKm: number;
  readonly radialVelocityKmS: number;
  readonly dopplerShiftHz: number;
  readonly dopplerRateHzS: number;
  readonly fsplDb: number;
  readonly atmosphericLossDb: number;
  readonly transmitterPowerDbm: number;
  readonly receivedPowerDbm: number;
  readonly snrDb: number;
  readonly carrierLocked: boolean;
  readonly frequencyTrackingErrorHz: number;
  readonly linkStatus: "BELOW_HORIZON" | "CARRIER_LOCKED" | "SIGNAL_FADED" | "TRANSMITTER_SILENCED";
}

export interface ChannelEmulatorOptions {
  readonly groundStationLocation?: GroundLocation;
  readonly orbitParams?: SatelliteOrbitParams;
  readonly receiverGtDbK?: number; // Ground antenna G/T (e.g. 22 dB/K for S-band dish)
  readonly receiverBandwidthHz?: number; // e.g. 10e6 (10 MHz)
  readonly minElevationDeg?: number; // e.g. 5 deg
  readonly carrierLockThresholdSnrDb?: number; // e.g. 6.0 dB
  readonly pllTrackingBandwidthHz?: number; // e.g. 500 Hz
}

export class ChannelEmulator {
  public static readonly SPEED_OF_LIGHT_KM_S = 299792.458;
  public static readonly EARTH_RADIUS_KM = 6378.137;
  public static readonly BOLTZMANN_DBW_K_HZ = -228.6; // dBW / (K * Hz)

  private readonly station: GroundLocation;
  private readonly orbit: SatelliteOrbitParams;
  private readonly receiverGtDbK: number;
  private readonly receiverBandwidthHz: number;
  private readonly minElevationDeg: number;
  private readonly lockThresholdSnrDb: number;
  private readonly pllBandwidthHz: number;

  // Real-time impairment injections
  private transmitterActive = true;
  private transmitterPowerDbm: number;
  private injectedAtmosphericFadeDb = 0;
  private injectedFrequencyOffsetHz = 0;
  private lastDopplerShiftHz = 0;
  private lastEvaluationTimeMs = 0;

  constructor(options: ChannelEmulatorOptions = {}) {
    this.station = options.groundStationLocation ?? {
      latitudeDeg: 39.96,
      longitudeDeg: -83.0,
      altitudeM: 200,
    };
    this.orbit = options.orbitParams ?? {
      semiMajorAxisKm: 6928, // ~550 km LEO altitude
      inclinationDeg: 97.5,
      carrierFrequencyHz: 2.245e9, // S-band default
      txPowerDbm: 40.0, // 10 W
    };
    this.receiverGtDbK = options.receiverGtDbK ?? 22.0;
    this.receiverBandwidthHz = options.receiverBandwidthHz ?? 10e6; // 10 MHz
    this.minElevationDeg = options.minElevationDeg ?? 5.0;
    this.lockThresholdSnrDb = options.carrierLockThresholdSnrDb ?? 6.0;
    this.pllBandwidthHz = options.pllTrackingBandwidthHz ?? 1000.0;
    this.transmitterPowerDbm = this.orbit.txPowerDbm;
  }

  /**
   * Set transmitter active state (physical carrier silencing switch)
   */
  public setTransmitterState(active: boolean, powerDbm?: number): void {
    this.transmitterActive = active;
    if (powerDbm !== undefined) {
      this.transmitterPowerDbm = powerDbm;
    } else if (!active) {
      this.transmitterPowerDbm = -110.0; // Thermal noise floor
    } else {
      this.transmitterPowerDbm = this.orbit.txPowerDbm;
    }
    logger.info(
      { active, powerDbm: this.transmitterPowerDbm },
      "[CHANNEL_EMULATOR] Transmitter RF state updated"
    );
  }

  /**
   * Inject simulated atmospheric attenuation / rain fade
   */
  public setInjectedAtmosphericFade(fadeDb: number): void {
    this.injectedAtmosphericFadeDb = Math.max(0, fadeDb);
  }

  /**
   * Inject frequency offset error
   */
  public setInjectedFrequencyOffset(offsetHz: number): void {
    this.injectedFrequencyOffsetHz = offsetHz;
  }

  /**
   * Analytical pass geometry calculation:
   * Models circular LEO overflight pass geometry across normalized time progress [-1, +1]
   * where -1 is AOS, 0 is Peak Elevation (Zenith/CPA), and +1 is LOS.
   */
  public computeAnalyticalGeometry(
    normalizedProgress: number, // -1.0 (AOS) to +1.0 (LOS)
    maxElevationDeg = 65.0
  ): {
    elevationDeg: number;
    azimuthDeg: number;
    slantRangeKm: number;
    radialVelocityKmS: number;
  } {
    const prog = Math.max(-1.5, Math.min(1.5, normalizedProgress));
    const altitudeKm = this.orbit.semiMajorAxisKm - ChannelEmulator.EARTH_RADIUS_KM;

    // Elevation angle curve: sinusoidal profile peaking at maxElevationDeg
    const elevationRad = Math.sin(((1 - Math.abs(prog)) * Math.PI) / 2);
    const elevationDeg = this.minElevationDeg + (maxElevationDeg - this.minElevationDeg) * elevationRad;

    // Slant Range: Minimum at Peak Elevation (Zenith ~ altitudeKm), maximum at 5 deg horizon (~1850 km)
    const horizonRangeKm = 1850.0;
    const slantRangeKm =
      altitudeKm + (horizonRangeKm - altitudeKm) * Math.pow(Math.abs(prog), 1.4);

    // Azimuth: Linear progression across pass (e.g. South-to-North polar pass ~160 deg to ~340 deg)
    const azimuthDeg = 160.0 + (prog + 1) * 90.0;

    // Radial velocity: Orbital speed ~ 7.58 km/s
    // Approaching (v_r < 0) before Zenith, zero at Zenith, receding (v_r > 0) after Zenith
    const maxRadialVelocityKmS = 7.1; // km/s at low elevation
    const radialVelocityKmS = maxRadialVelocityKmS * prog;

    return {
      elevationDeg,
      azimuthDeg: azimuthDeg % 360,
      slantRangeKm,
      radialVelocityKmS,
    };
  }

  /**
   * Calculate physical Free Space Path Loss (FSPL) in dB:
   * FSPL = 20*log10(R) + 20*log10(f) + 20*log10(4*pi / c)
   */
  public calculateFsplDb(slantRangeKm: number, frequencyHz: number): number {
    const rangeM = slantRangeKm * 1000;
    const c = ChannelEmulator.SPEED_OF_LIGHT_KM_S * 1000;
    return 20 * Math.log10((4 * Math.PI * rangeM * frequencyHz) / c);
  }

  /**
   * Calculate elevation-dependent atmospheric absorption in dB
   */
  public calculateAtmosphericLossDb(elevationDeg: number): number {
    // Standard ITU-R tropospheric zenith attenuation ~0.05 dB at S-band, ~0.15 dB at X-band
    const zenithLossDb = this.orbit.carrierFrequencyHz > 5e9 ? 0.15 : 0.05;
    const safeEl = Math.max(2.0, elevationDeg);
    const cosecantEl = 1 / Math.sin((safeEl * Math.PI) / 180);
    return zenithLossDb * cosecantEl + this.injectedAtmosphericFadeDb;
  }

  /**
   * Calculate Doppler shift:
   * Delta_f = - f0 * (v_r / c)
   */
  public calculateDopplerShiftHz(radialVelocityKmS: number, frequencyHz: number): number {
    return -(radialVelocityKmS / ChannelEmulator.SPEED_OF_LIGHT_KM_S) * frequencyHz;
  }

  /**
   * Calculate instantaneous RF channel state and carrier lock
   */
  public evaluateChannelAtProgress(
    normalizedProgress: number,
    currentTime: Date = new Date(),
    maxElevationDeg = 65.0
  ): ChannelMetricsSnapshot {
    const geo = this.computeAnalyticalGeometry(normalizedProgress, maxElevationDeg);

    // 1. Physical Propagation Loss
    const fsplDb = this.calculateFsplDb(geo.slantRangeKm, this.orbit.carrierFrequencyHz);
    const atmLossDb = this.calculateAtmosphericLossDb(geo.elevationDeg);
    const totalPathLossDb = fsplDb + atmLossDb;

    // 2. Doppler Frequency Shift
    const dopplerShiftHz = this.calculateDopplerShiftHz(
      geo.radialVelocityKmS,
      this.orbit.carrierFrequencyHz
    );

    // Calculate Doppler rate (Hz/s)
    const nowMs = currentTime.getTime();
    let dopplerRateHzS = 0;
    if (this.lastEvaluationTimeMs > 0 && nowMs > this.lastEvaluationTimeMs) {
      const dtSec = (nowMs - this.lastEvaluationTimeMs) / 1000;
      dopplerRateHzS = (dopplerShiftHz - this.lastDopplerShiftHz) / dtSec;
    }
    this.lastDopplerShiftHz = dopplerShiftHz;
    this.lastEvaluationTimeMs = nowMs;

    // 3. Received Signal Power and SNR
    // Received Power = Tx_EIRP - PathLoss
    const txEirpDbm = this.transmitterActive ? this.transmitterPowerDbm : -110.0;
    const receivedPowerDbm = txEirpDbm - totalPathLossDb;

    // Thermal noise power in receiver bandwidth:
    // P_noise_dBm = Boltzmann (dBW/K/Hz) + 30 (dBm) + 10*log10(T_sys) + 10*log10(B)
    // Here we compute C/N0 = EIRP - PathLoss + G/T - Boltzmann
    let snrDb = 0;
    if (this.transmitterActive && this.transmitterPowerDbm > -50.0) {
      const eirpDbw = this.transmitterPowerDbm - 30.0;
      const cN0 = eirpDbw - totalPathLossDb + this.receiverGtDbK - ChannelEmulator.BOLTZMANN_DBW_K_HZ;
      const bandwidthDb = 10 * Math.log10(this.receiverBandwidthHz);
      snrDb = Math.max(0, cN0 - bandwidthDb);
    }

    // 4. Frequency Tracking Error (Receiver PLL / AFC)
    const trackingErrorHz = Math.abs(this.injectedFrequencyOffsetHz);

    // 5. Invariant: Physical Carrier Lock Condition
    // Requires:
    // a) Transmitter active (not silenced)
    // b) Spacecraft above minimum elevation
    // c) SNR exceeds lock threshold
    // d) Frequency error within receiver PLL pull-in range
    const isAboveHorizon = geo.elevationDeg >= this.minElevationDeg;
    const hasAdequateSnr = snrDb >= this.lockThresholdSnrDb;
    const isWithinPllPullIn = trackingErrorHz <= this.pllBandwidthHz;

    const carrierLocked =
      this.transmitterActive && isAboveHorizon && hasAdequateSnr && isWithinPllPullIn;

    // Determine descriptive link status
    let linkStatus: ChannelMetricsSnapshot["linkStatus"] = "CARRIER_LOCKED";
    if (!this.transmitterActive) {
      linkStatus = "TRANSMITTER_SILENCED";
    } else if (!isAboveHorizon) {
      linkStatus = "BELOW_HORIZON";
    } else if (!hasAdequateSnr || !isWithinPllPullIn) {
      linkStatus = "SIGNAL_FADED";
    }

    return {
      timestamp: currentTime,
      elevationDeg: Number(geo.elevationDeg.toFixed(2)),
      azimuthDeg: Number(geo.azimuthDeg.toFixed(2)),
      slantRangeKm: Number(geo.slantRangeKm.toFixed(2)),
      radialVelocityKmS: Number(geo.radialVelocityKmS.toFixed(3)),
      dopplerShiftHz: Number(dopplerShiftHz.toFixed(1)),
      dopplerRateHzS: Number(dopplerRateHzS.toFixed(1)),
      fsplDb: Number(fsplDb.toFixed(2)),
      atmosphericLossDb: Number(atmLossDb.toFixed(2)),
      transmitterPowerDbm: Number(txEirpDbm.toFixed(2)),
      receivedPowerDbm: Number(receivedPowerDbm.toFixed(2)),
      snrDb: Number(snrDb.toFixed(2)),
      carrierLocked,
      frequencyTrackingErrorHz: trackingErrorHz,
      linkStatus,
    };
  }

  public getTransmitterPowerDbm(): number {
    return this.transmitterActive ? this.transmitterPowerDbm : -110.0;
  }
}
