import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';
import { Activity, RefreshCw, AlertTriangle, CheckCircle, Clock, Zap, ArrowRight, Layers, Radio } from 'lucide-react';

interface LedgerItem {
  id: string;
  idempotencyKey: string;
  eventType: string;
  urgency: string;
  payload: any;
  status: string;
  batchId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BatchItem {
  id: string;
  status: string;
  scheduleVersionBefore: number;
  scheduleVersionAfter: number;
  eventCount: number;
  eventIds: string[];
  summary: any;
  createdAt: string;
  completedAt: string | null;
}

export const ControlPlanePanel: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'ledger' | 'batches' | 'contracts'>('batches');
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<any | null>(null);
  const [selectedContract, setSelectedContract] = useState<any | null>(null);
  const [loadingContract, setLoadingContract] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ledgerRes, batchesRes, resData] = await Promise.all([
        api.get('/scheduler/control-plane/ledger?limit=100'),
        api.get('/scheduler/control-plane/batches?limit=50'),
        api.get('/reservations'),
      ]);
      setLedger(ledgerRes.ledger || []);
      setBatches(batchesRes.batches || []);
      setContracts(resData || []);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Unable to load control plane telemetry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleInspectBatch = async (batchId: string) => {
    try {
      const data = await api.get(`/scheduler/control-plane/batches/${batchId}`);
      setSelectedBatch(data);
    } catch (err: any) {
      alert(`Failed to load batch ${batchId}: ${err.message}`);
    }
  };

  const handleRetryBatch = async (batchId: string) => {
    setRetryingId(batchId);
    try {
      const receipt = await api.post('/scheduler/control-plane/retry', { batchId });
      alert(`Batch recovered successfully! Version: ${receipt.scheduleVersionBefore} -> ${receipt.scheduleVersionAfter}`);
      await fetchData();
      if (selectedBatch && selectedBatch.batch.id === batchId) {
        await handleInspectBatch(batchId);
      }
    } catch (err: any) {
      alert(`Batch recovery failed: ${err.message}`);
    } finally {
      setRetryingId(null);
    }
  };

  const handleInspectContract = async (reservationId: string) => {
    setLoadingContract(true);
    try {
      const data = await api.get(`/execution/reservations/${reservationId}`);
      setSelectedContract(data);
    } catch (err: any) {
      alert(`Failed to load execution contract audit: ${err.message}`);
    } finally {
      setLoadingContract(false);
    }
  };

  const formatBytes = (bytes?: number | null) => {
    if (bytes === undefined || bytes === null) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const getExecutionBadge = (state?: string) => {
    switch (state) {
      case 'COMPLETED':
        return <span className="badge badge-success">COMPLETED</span>;
      case 'IN_PROGRESS':
        return <span className="badge" style={{ backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#4ade80' }}>● IN PROGRESS</span>;
      case 'DISPATCHED':
        return <span className="badge" style={{ backgroundColor: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa' }}>DISPATCHED</span>;
      case 'EXECUTION_READY':
        return <span className="badge" style={{ backgroundColor: 'rgba(168, 85, 247, 0.2)', color: '#c084fc' }}>EXECUTION READY</span>;
      case 'PARTIAL':
        return <span className="badge" style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', color: '#facc15' }}>PARTIAL</span>;
      case 'FAILED':
        return <span className="badge badge-danger">FAILED</span>;
      case 'SCHEDULED':
      default:
        return <span className="badge" style={{ backgroundColor: 'rgba(148, 163, 184, 0.2)', color: '#94a3b8' }}>SCHEDULED</span>;
    }
  };

  const filteredLedger = statusFilter === 'ALL'
    ? ledger
    : ledger.filter((item) => item.status === statusFilter);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><CheckCircle size={12} /> COMPLETED</span>;
      case 'PROCESSING':
        return <span className="badge" style={{ backgroundColor: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><RefreshCw size={12} className="spin" /> PROCESSING</span>;
      case 'RECEIVED':
        return <span className="badge" style={{ backgroundColor: 'rgba(156, 163, 175, 0.2)', color: '#9ca3af', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={12} /> RECEIVED</span>;
      case 'COALESCED':
        return <span className="badge" style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', color: '#facc15', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><Layers size={12} /> COALESCED</span>;
      case 'SUPERSEDED':
        return <span className="badge" style={{ backgroundColor: 'rgba(107, 114, 128, 0.2)', color: '#9ca3af', textDecoration: 'line-through' }}>SUPERSEDED</span>;
      case 'FAILED':
        return <span className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><AlertTriangle size={12} /> FAILED</span>;
      default:
        return <span className="badge">{status}</span>;
    }
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Zap className="text-gradient" size={24} />
            <span>Operational Control Plane</span>
          </h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0 0', fontSize: '0.875rem' }}>
            Authoritative Event Ledger, Subsumption &amp; Serialized Batch Orchestration
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-outline" onClick={fetchData} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
        <button
          className={`btn ${activeSubTab === 'batches' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setActiveSubTab('batches')}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Layers size={16} />
          Operational Batches ({batches.length})
        </button>
        <button
          className={`btn ${activeSubTab === 'ledger' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setActiveSubTab('ledger')}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Activity size={16} />
          Event Ledger ({ledger.length})
        </button>
        <button
          className={`btn ${activeSubTab === 'contracts' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setActiveSubTab('contracts')}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Radio size={16} />
          Execution Contracts ({contracts.length})
        </button>
      </div>

      {error && (
        <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {/* Batches View */}
      {activeSubTab === 'batches' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {batches.length === 0 ? (
            <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              No operational batches recorded. Events ingested into the control plane will appear here.
            </div>
          ) : (
            <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '0.75rem 1rem' }}>Batch ID</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Version Transition</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Constituent Events</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Created At</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace' }}>
                        {b.id.slice(0, 8)}...
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {getStatusBadge(b.status)}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontFamily: 'monospace' }}>
                          v{b.scheduleVersionBefore}
                          <ArrowRight size={12} color="var(--text-muted)" />
                          <strong style={{ color: b.scheduleVersionAfter > b.scheduleVersionBefore ? 'var(--accent-secondary)' : 'inherit' }}>
                            v{b.scheduleVersionAfter}
                          </strong>
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span className="badge" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
                          {b.eventCount} event{b.eventCount !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {format(new Date(b.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                      </td>
                      <td style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.5rem' }}>
                        <button
                          className="btn btn-outline"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          onClick={() => handleInspectBatch(b.id)}
                        >
                          Inspect
                        </button>
                        {b.status === 'FAILED' && (
                          <button
                            className="btn btn-primary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', backgroundColor: 'var(--danger)' }}
                            onClick={() => handleRetryBatch(b.id)}
                            disabled={retryingId === b.id}
                          >
                            {retryingId === b.id ? 'Retrying...' : 'Retry'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Ledger View */}
      {activeSubTab === 'ledger' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Status Filter */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Filter by Status:</span>
            {['ALL', 'COMPLETED', 'RECEIVED', 'COALESCED', 'SUPERSEDED', 'FAILED'].map((st) => (
              <button
                key={st}
                className={`btn ${statusFilter === st ? 'btn-primary' : 'btn-outline'}`}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => setStatusFilter(st)}
              >
                {st}
              </button>
            ))}
          </div>

          <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '0.75rem 1rem' }}>Idempotency Key</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Type</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Urgency</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Batch</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {filteredLedger.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No events match filter.
                    </td>
                  </tr>
                ) : (
                  filteredLedger.map((item) => (
                    <tr key={item.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.idempotencyKey}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span className="badge" style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}>
                          {item.eventType}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span style={{ fontSize: '0.75rem', color: item.urgency === 'IMMEDIATE' ? '#f87171' : 'var(--text-muted)' }}>
                          {item.urgency}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {getStatusBadge(item.status)}
                      </td>
                      <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {item.batchId ? item.batchId.slice(0, 8) + '...' : '—'}
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {format(new Date(item.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Execution Contracts View */}
      {activeSubTab === 'contracts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {contracts.length === 0 ? (
            <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              No execution contracts scheduled. Scheduled reservations will appear here with execution state.
            </div>
          ) : (
            <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '0.75rem 1rem' }}>Reservation ID</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Satellite / Station</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Execution State</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Dispatch ID</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Pass Actuals</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Window AOS/LOS</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                      <td style={{ padding: '0.75rem 1rem' }} className="mono">
                        {c.id.slice(0, 8)}...
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <div style={{ fontWeight: 500 }}>{c.satelliteName || c.satelliteId?.slice(0, 8)}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{c.groundStationName || c.groundStationId?.slice(0, 8)}</div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {getExecutionBadge(c.executionState)}
                        {c.failureReason && (
                          <div style={{ fontSize: '0.7rem', color: '#f87171', marginTop: '0.2rem' }}>
                            {c.failureReason}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }} className="mono" style={{ fontSize: '0.75rem' }}>
                        {c.activeDispatchId ? (
                          <span style={{ color: '#60a5fa' }}>{c.activeDispatchId}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <div className="mono" style={{ fontSize: '0.8rem', color: '#4ade80' }}>
                          {formatBytes(c.bytesTransferred)}
                        </div>
                        {c.taskTargetBytes && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            of {formatBytes(c.taskTargetBytes)} target
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem 1rem', fontSize: '0.75rem' }} className="mono">
                        <div>AOS: {format(new Date(c.allocatedStart), 'HH:mm:ss')}</div>
                        <div style={{ color: 'var(--text-muted)' }}>LOS: {format(new Date(c.allocatedEnd), 'HH:mm:ss')}</div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <button
                          className="btn btn-outline"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          onClick={() => handleInspectContract(c.id)}
                          disabled={loadingContract}
                        >
                          Inspect Audit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Batch Inspection Modal / Detail Drawer */}
      {selectedBatch && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '2rem',
          }}
          onClick={() => setSelectedBatch(null)}
        >
          <div
            className="glass-panel"
            style={{
              maxWidth: '800px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '2rem',
              backgroundColor: '#0f172a',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ margin: 0 }}>Batch Details</h3>
                <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{selectedBatch.batch.id}</span>
              </div>
              <button className="btn btn-outline" onClick={() => setSelectedBatch(null)}>Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
              <div className="glass-panel" style={{ padding: '1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Status</span>
                <div style={{ marginTop: '0.25rem' }}>{getStatusBadge(selectedBatch.batch.status)}</div>
              </div>
              <div className="glass-panel" style={{ padding: '1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Version Transition</span>
                <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                  v{selectedBatch.batch.scheduleVersionBefore} &rarr; v{selectedBatch.batch.scheduleVersionAfter}
                </div>
              </div>
              <div className="glass-panel" style={{ padding: '1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Constituent Events</span>
                <div style={{ marginTop: '0.25rem', fontWeight: 600 }}>{selectedBatch.events?.length || 0}</div>
              </div>
            </div>

            <h4 style={{ marginBottom: '0.5rem' }}>Constituent Events</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {selectedBatch.events?.map((e: LedgerItem) => (
                <div key={e.id} className="glass-panel" style={{ padding: '0.75rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span className="badge" style={{ marginRight: '0.5rem' }}>{e.eventType}</span>
                    <span className="mono" style={{ fontSize: '0.75rem' }}>{e.idempotencyKey}</span>
                  </div>
                  <div>{getStatusBadge(e.status)}</div>
                </div>
              ))}
            </div>

            {selectedBatch.batch.status === 'FAILED' && (
              <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
                <button
                  className="btn btn-primary"
                  style={{ backgroundColor: 'var(--danger)' }}
                  onClick={() => handleRetryBatch(selectedBatch.batch.id)}
                  disabled={retryingId === selectedBatch.batch.id}
                >
                  {retryingId === selectedBatch.batch.id ? 'Retrying...' : 'Retry Batch Now'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Contract Telemetry Audit Ledger Modal */}
      {selectedContract && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '2rem',
          }}
          onClick={() => setSelectedContract(null)}
        >
          <div
            className="glass-panel"
            style={{
              maxWidth: '850px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '2rem',
              backgroundColor: '#0f172a',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Radio size={20} className="text-gradient" />
                  <span>Execution Contract &amp; Telemetry Provenance</span>
                </h3>
                <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Reservation {selectedContract.reservation.id}
                </span>
              </div>
              <button className="btn btn-outline" onClick={() => setSelectedContract(null)}>Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
              <div className="glass-panel" style={{ padding: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Execution State</span>
                <div style={{ marginTop: '0.25rem' }}>{getExecutionBadge(selectedContract.reservation.executionState)}</div>
              </div>
              <div className="glass-panel" style={{ padding: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Active Dispatch ID</span>
                <div className="mono" style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: '#60a5fa' }}>
                  {selectedContract.reservation.activeDispatchId || 'None'}
                </div>
              </div>
              <div className="glass-panel" style={{ padding: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Transferred Actuals</span>
                <div className="mono" style={{ marginTop: '0.25rem', fontSize: '0.9rem', color: '#4ade80' }}>
                  {formatBytes(selectedContract.reservation.bytesTransferred)}
                </div>
              </div>
              <div className="glass-panel" style={{ padding: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Task Quota Remaining</span>
                <div className="mono" style={{ marginTop: '0.25rem', fontSize: '0.9rem' }}>
                  {formatBytes(selectedContract.missionTask?.remainingBytes)}
                </div>
              </div>
            </div>

            <h4 style={{ marginBottom: '0.75rem' }}>Authoritative Telemetry Ledger ({selectedContract.events?.length || 0} events)</h4>
            {selectedContract.events?.length === 0 ? (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                No physical telemetry events ingested yet for this contract.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '0.5rem' }}>Seq #</th>
                      <th style={{ padding: '0.5rem' }}>Event Type</th>
                      <th style={{ padding: '0.5rem' }}>Dispatch ID</th>
                      <th style={{ padding: '0.5rem' }}>Source Timestamp</th>
                      <th style={{ padding: '0.5rem' }}>Idempotency Key</th>
                      <th style={{ padding: '0.5rem' }}>Transferred</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedContract.events.map((evt: any) => (
                      <tr key={evt.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                        <td style={{ padding: '0.5rem' }} className="mono">#{evt.sequenceNumber}</td>
                        <td style={{ padding: '0.5rem' }}>
                          <span className="badge" style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}>{evt.eventType}</span>
                        </td>
                        <td style={{ padding: '0.5rem' }} className="mono" style={{ color: '#60a5fa' }}>{evt.dispatchId}</td>
                        <td style={{ padding: '0.5rem' }} className="mono" style={{ color: 'var(--text-muted)' }}>
                          {format(new Date(evt.sourceTimestamp), 'HH:mm:ss.SSS')}
                        </td>
                        <td style={{ padding: '0.5rem' }} className="mono" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {evt.idempotencyKey.slice(0, 16)}...
                        </td>
                        <td style={{ padding: '0.5rem' }} className="mono" style={{ color: '#4ade80' }}>
                          {formatBytes(evt.payload?.bytesTransferred || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
