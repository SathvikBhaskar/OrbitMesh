import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, FastForward, Rewind, Radio, ChevronUp, ChevronDown } from 'lucide-react';

interface TimelineScrubberProps {
  currentSimTime: Date;
  isLive: boolean;
  isPlaying: boolean;
  playbackSpeed: number;
  onTogglePlay: () => void;
  onSetSpeed: (speed: number) => void;
  onSeekOffsetMinutes: (minutes: number) => void;
  onReturnToLive: () => void;
  onStepMinutes: (deltaMinutes: number) => void;
}

const SPEED_OPTIONS = [1, 5, 30, 120, 600];

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentSimTime,
  isLive,
  isPlaying,
  playbackSpeed,
  onTogglePlay,
  onSetSpeed,
  onSeekOffsetMinutes,
  onReturnToLive,
  onStepMinutes,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [nowAnchor, setNowAnchor] = useState<Date>(new Date());

  // Keep nowAnchor updated every 5 seconds so slider reference stays fresh
  useEffect(() => {
    const timer = setInterval(() => {
      setNowAnchor(new Date());
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Compute offset in minutes relative to nowAnchor
  const offsetMinutes = Math.round((currentSimTime.getTime() - nowAnchor.getTime()) / 60000);
  const clampedOffset = Math.max(-360, Math.min(360, offsetMinutes));

  const formatUtc = (date: Date) => {
    return date.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  };

  const formatOffsetLabel = (mins: number) => {
    if (Math.abs(mins) < 1) return 'NOW';
    const sign = mins > 0 ? '+' : '-';
    const abs = Math.abs(mins);
    const hrs = Math.floor(abs / 60);
    const remMins = abs % 60;
    if (hrs === 0) return `${sign}${remMins}m`;
    return `${sign}${hrs}h ${remMins > 0 ? `${remMins}m` : ''}`;
  };

  if (isCollapsed) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: '12px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 200,
        }}
      >
        <button
          onClick={() => setIsCollapsed(false)}
          className="glass-panel"
          style={{
            padding: '0.4rem 0.85rem',
            borderRadius: '20px',
            border: isLive ? '1px solid rgba(74, 222, 128, 0.4)' : '1px solid rgba(250, 204, 21, 0.4)',
            background: 'rgba(15, 23, 42, 0.85)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.75rem',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
          }}
          title="Expand 4D Orbit Playback Deck"
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: isLive ? '#4ade80' : '#facc15',
              boxShadow: isLive ? '0 0 8px #4ade80' : '0 0 8px #facc15',
            }}
          />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{formatUtc(currentSimTime)}</span>
          <span style={{ color: isLive ? '#4ade80' : '#facc15', fontWeight: 600 }}>
            {isLive ? 'LIVE' : formatOffsetLabel(offsetMinutes)}
          </span>
          <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="glass-panel"
      style={{
        position: 'absolute',
        bottom: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        width: 'calc(100% - 280px)',
        maxWidth: '820px',
        minWidth: '460px',
        padding: '0.55rem 0.9rem',
        borderRadius: '12px',
        background: 'rgba(15, 23, 42, 0.88)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        backdropFilter: 'blur(16px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.65)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      {/* Top row: Status, Timestamp, Collapse */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          {/* Live / Sim Pill */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.15rem 0.5rem',
              borderRadius: '12px',
              background: isLive ? 'rgba(34, 197, 94, 0.15)' : 'rgba(250, 204, 21, 0.15)',
              border: isLive ? '1px solid rgba(34, 197, 94, 0.35)' : '1px solid rgba(250, 204, 21, 0.35)',
              fontSize: '0.68rem',
              fontWeight: 600,
              color: isLive ? '#4ade80' : '#facc15',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: isLive ? '#4ade80' : '#facc15',
                animation: isLive ? 'pulse 2s infinite' : 'none',
              }}
            />
            {isLive ? 'LIVE FEED (1x)' : `SIMULATION (${formatOffsetLabel(offsetMinutes)})`}
          </div>

          {/* Current Sim UTC Clock */}
          <div style={{ fontFamily: 'var(--font-mono)', color: '#fff', fontWeight: 600, fontSize: '0.8rem' }}>
            {formatUtc(currentSimTime)}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {/* Return to Live button if in simulation mode */}
          {!isLive && (
            <button
              onClick={onReturnToLive}
              style={{
                background: 'rgba(34, 197, 94, 0.2)',
                border: '1px solid rgba(34, 197, 94, 0.4)',
                color: '#4ade80',
                borderRadius: '5px',
                padding: '0.2rem 0.5rem',
                fontSize: '0.7rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}
              title="Snap back to current real-world UTC"
            >
              <Radio size={12} />
              Return to LIVE
            </button>
          )}

          {/* Collapse button */}
          <button
            onClick={() => setIsCollapsed(true)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '0.2rem',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Minimize timeline scrubber"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      {/* Middle row: Interactive Timeline Slider (-6h to +6h) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>-6h</span>
        <input
          type="range"
          min={-360}
          max={360}
          step={1}
          value={clampedOffset}
          onChange={(e) => onSeekOffsetMinutes(Number(e.target.value))}
          style={{
            flex: 1,
            accentColor: isLive ? '#4ade80' : '#38bdf8',
            cursor: 'pointer',
            height: '4px',
          }}
          title="Drag slider to scrub forward/backward in time across orbital orbits"
        />
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>+6h</span>
      </div>

      {/* Bottom row: Play/Pause, Step Controls, Speed Multiplier */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.1rem' }}>
        {/* Playback & Step Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <button
            onClick={() => onStepMinutes(-15)}
            className="btn btn-outline"
            style={{ padding: '0.25rem 0.45rem', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.2rem', color: 'var(--text-secondary)' }}
            title="Step backward 15 minutes"
          >
            <Rewind size={12} /> -15m
          </button>

          <button
            onClick={onTogglePlay}
            style={{
              background: isPlaying ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255,255,255,0.08)',
              border: isPlaying ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.2)',
              color: isPlaying ? '#38bdf8' : '#fff',
              borderRadius: '6px',
              padding: '0.25rem 0.65rem',
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
            title={isPlaying ? 'Pause time propagation' : 'Play time propagation'}
          >
            {isPlaying ? <Pause size={12} /> : <Play size={12} />}
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>

          <button
            onClick={() => onStepMinutes(15)}
            className="btn btn-outline"
            style={{ padding: '0.25rem 0.45rem', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.2rem', color: 'var(--text-secondary)' }}
            title="Step forward 15 minutes"
          >
            +15m <FastForward size={12} />
          </button>
        </div>

        {/* Speed Multiplier Pill Group */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(0,0,0,0.3)', padding: '0.15rem', borderRadius: '6px' }}>
          {SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              onClick={() => onSetSpeed(speed)}
              style={{
                padding: '0.18rem 0.4rem',
                fontSize: '0.68rem',
                borderRadius: '4px',
                border: 'none',
                background: playbackSpeed === speed ? 'rgba(56, 189, 248, 0.3)' : 'transparent',
                color: playbackSpeed === speed ? '#38bdf8' : 'var(--text-muted)',
                fontWeight: playbackSpeed === speed ? 600 : 400,
                cursor: 'pointer',
              }}
              title={`Simulate time at ${speed}x speed`}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
