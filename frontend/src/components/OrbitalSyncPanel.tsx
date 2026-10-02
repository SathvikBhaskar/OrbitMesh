import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { RefreshCw, CheckCircle, XCircle, Clock, Database, Radio } from 'lucide-react';

interface SyncStatus {
  lastSync: {
    id: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    provider: string;
    fetchedCount: number | null;
    discoveredCount: number | null;
    updatedCount: number | null;
    ignoredCount: number | null;
    rejectedCount: number | null;
    regeneratedSatelliteCount: number | null;
    regeneratedWindowCount: number | null;
    errorMessage: string | null;
  } | null;
  satelliteCount: number;
  groundStationCount: number;
  contactWindowCount: number;
}

const formatTime = (iso: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false }) + ' UTC';
};

const formatDuration = (start: string, end: string | null) => {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
};

export const OrbitalSyncPanel: React.FC = () => {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get('/orbital-sync/status');
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch orbital sync status', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSyncNow = async () => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await api.post('/orbital-sync', {});
      await fetchStatus();
    } catch (err: any) {
      setSyncError(err.message || 'Sync failed');
      await fetchStatus();
    } finally {
      setIsSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading orbital sync status...</div>
      </div>
    );
  }

  const lastSync = status?.lastSync;
  const syncState: 'NEVER' | 'SUCCESS' | 'FAILED' =
    !lastSync ? 'NEVER' : lastSync.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';

  const stateColor = {
    NEVER: 'var(--text-muted)',
    SUCCESS: 'var(--success)',
    FAILED: 'var(--danger)',
  }[syncState];

  const stateIcon = {
    NEVER: <Clock size={14} />,
    SUCCESS: <CheckCircle size={14} />,
    FAILED: <XCircle size={14} />,
  }[syncState];

  return (
    <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Radio size={18} style={{ color: 'var(--accent-primary)' }} />
          <h3 style={{ margin: 0, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>
            Orbital Data Synchronization
          </h3>
        </div>
        <button
          className={`btn btn-primary ${isSyncing ? 'btn-running' : ''}`}
          style={{ padding: '0.4rem 0.85rem', fontSize: '0.8rem', gap: '0.4rem' }}
          onClick={handleSyncNow}
          disabled={isSyncing}
        >
          <RefreshCw size={13} style={{ animation: isSyncing ? 'spin 1s linear infinite' : 'none' }} />
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      {/* Data Source Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          padding: '0.3rem 0.75rem', borderRadius: '999px',
          background: status && status.satelliteCount > 0
            ? 'rgba(99,235,128,0.12)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${status && status.satelliteCount > 0 ? 'var(--success)' : 'var(--border-color)'}`,
          fontSize: '0.78rem', fontWeight: 600,
          color: status && status.satelliteCount > 0 ? 'var(--success)' : 'var(--text-muted)'
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: status && status.satelliteCount > 0 ? 'var(--success)' : 'var(--text-muted)',
            display: 'inline-block'
          }} />
          {status && status.satelliteCount > 0 ? 'CELESTRAK — Real Orbital Data' : 'NO DATA — NEVER SYNCED'}
        </div>
      </div>

      {/* Counts Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', textAlign: 'center' }}>
        {[
          { label: 'Satellites', value: status?.satelliteCount ?? 0, icon: <Database size={14} /> },
          { label: 'Ground Stations', value: status?.groundStationCount ?? 0, icon: <Database size={14} /> },
          { label: 'Contact Windows', value: status?.contactWindowCount ?? 0, icon: <Database size={14} /> },
        ].map(item => (
          <div key={item.label} style={{
            padding: '0.75rem',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)'
          }}>
            <div className="metric-title" style={{ fontSize: '0.7rem', marginBottom: '0.25rem' }}>{item.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {item.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Last Sync Details */}
      <div>
        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          Last Synchronization
        </div>

        {syncState === 'NEVER' ? (
          <div style={{
            padding: '1rem', background: 'rgba(255,255,255,0.03)',
            borderRadius: '8px', border: '1px solid var(--border-color)',
            color: 'var(--text-muted)', fontSize: '0.875rem', textAlign: 'center'
          }}>
            Never synchronized. Click <strong>Sync Now</strong> to fetch real orbital data from CelesTrak.
          </div>
        ) : (
          <div style={{
            padding: '1rem', background: syncState === 'FAILED' ? 'rgba(239,68,68,0.06)' : 'rgba(99,235,128,0.04)',
            borderRadius: '8px',
            border: `1px solid ${syncState === 'FAILED' ? 'rgba(239,68,68,0.3)' : 'rgba(99,235,128,0.2)'}`,
          }}>
            {/* Status line */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: stateColor, fontWeight: 600, marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              {stateIcon}
              {syncState === 'SUCCESS' ? 'SUCCESS' : 'FAILED'}
              <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                {formatTime(lastSync!.completedAt)} · {formatDuration(lastSync!.startedAt, lastSync!.completedAt)}
              </span>
            </div>

            {syncState === 'FAILED' ? (
              <>
                <div style={{ color: 'var(--danger)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                  {lastSync!.errorMessage || 'Provider request failed.'}
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                  Existing orbital data preserved. Previous contact windows remain valid.
                </div>
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem 1.5rem', fontSize: '0.8rem' }}>
                {[
                  { label: 'Satellites fetched', value: lastSync!.fetchedCount },
                  { label: 'New satellites', value: lastSync!.discoveredCount },
                  { label: 'Orbital updates', value: lastSync!.updatedCount },
                  { label: 'Unchanged', value: lastSync!.ignoredCount },
                  { label: 'Rejected (older epoch)', value: lastSync!.rejectedCount },
                  { label: 'Windows regenerated', value: lastSync!.regeneratedWindowCount },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{row.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                      {row.value ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {syncError && (
          <div style={{ marginTop: '0.5rem', color: 'var(--danger)', fontSize: '0.8rem' }}>
            ⚠ {syncError}
          </div>
        )}
      </div>
    </div>
  );
};
