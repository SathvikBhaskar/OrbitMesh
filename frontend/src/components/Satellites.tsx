import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Satellite } from 'lucide-react';

interface SatelliteRow {
  id: string;
  noradId: number;
  name: string;
  status: string;
  tleEpoch: string | null;
  source: string | null;
}

const formatEpoch = (iso: string | null) => {
  if (!iso) return <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No orbital data</span>;
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
};

const SOURCE_COLORS: Record<string, string> = {
  CELESTRAK: 'var(--accent-primary)',
  DEMO: 'var(--text-muted)',
};

export const Satellites: React.FC = () => {
  const [rows, setRows] = useState<SatelliteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.get('/satellites')
      .then(data => { setRows(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  const filtered = rows.filter(r =>
    r.name.toLowerCase().includes(filter.toLowerCase()) ||
    String(r.noradId).includes(filter)
  );

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Header row */}
      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Satellite size={20} style={{ color: 'var(--accent-primary)' }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>Satellite Catalog</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Database-backed orbital state — sourced via CelesTrak GP catalog
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <input
            type="text"
            placeholder="Filter by name or NORAD ID…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '0.4rem 0.75rem',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
              width: '220px',
              outline: 'none'
            }}
          />
          <span className="badge" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
            {filtered.length.toLocaleString()} satellites
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>Loading satellite catalog…</div>
        ) : error ? (
          <div style={{ padding: '2rem', color: 'var(--danger)', textAlign: 'center' }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            No satellites in database. Use <strong>Orbital Data Synchronization → Sync Now</strong> to ingest real satellite data.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', maxHeight: '65vh' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{
                  background: 'rgba(255,255,255,0.04)',
                  position: 'sticky', top: 0
                }}>
                  {['Satellite', 'NORAD ID', 'Status', 'TLE Epoch', 'Source'].map(col => (
                    <th key={col} style={{
                      padding: '0.75rem 1.25rem',
                      textAlign: 'left',
                      fontWeight: 600,
                      fontSize: '0.72rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border-color)',
                      whiteSpace: 'nowrap'
                    }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((sat, i) => (
                  <tr
                    key={sat.id}
                    style={{
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                      borderBottom: '1px solid rgba(255,255,255,0.04)'
                    }}
                  >
                    <td style={{ padding: '0.65rem 1.25rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                      {sat.name}
                    </td>
                    <td style={{ padding: '0.65rem 1.25rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                      {sat.noradId}
                    </td>
                    <td style={{ padding: '0.65rem 1.25rem' }}>
                      <span style={{
                        padding: '0.15rem 0.5rem',
                        borderRadius: '4px',
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        background: sat.status === 'ACTIVE' ? 'rgba(99,235,128,0.12)' : 'rgba(255,255,255,0.06)',
                        color: sat.status === 'ACTIVE' ? 'var(--success)' : 'var(--text-muted)'
                      }}>
                        {sat.status}
                      </span>
                    </td>
                    <td style={{ padding: '0.65rem 1.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatEpoch(sat.tleEpoch)}
                    </td>
                    <td style={{ padding: '0.65rem 1.25rem' }}>
                      {sat.source ? (
                        <span style={{
                          padding: '0.15rem 0.5rem',
                          borderRadius: '4px',
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          background: 'rgba(99,163,255,0.1)',
                          color: SOURCE_COLORS[sat.source] ?? 'var(--text-secondary)'
                        }}>
                          {sat.source}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.78rem' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
