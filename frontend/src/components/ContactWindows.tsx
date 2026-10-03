import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const ContactWindows = () => {
  const [windows, setWindows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchWindows = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/contact-windows');
      setWindows(data);
    } catch (err) {
      console.error(err);
      setError('Unable to load contact windows.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWindows();
  }, []);

  const filteredWindows = windows.filter((w: any) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const sat = (w.satelliteName || w.satelliteId).toLowerCase();
    const gs = (w.groundStationName || w.groundStationId).toLowerCase();
    return sat.includes(term) || gs.includes(term);
  });

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Available satellite-ground-station contact windows with line-of-sight geometry.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <input
            type="text"
            placeholder="Filter by satellite or station..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: '0.4rem 0.75rem',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-secondary)',
              color: 'white',
              fontSize: '0.85rem',
              width: '240px'
            }}
          />
          <span className="badge" style={{ background: 'rgba(255,255,255,0.06)' }}>
            {filteredWindows.length} windows
          </span>
        </div>
      </div>
      
      {error ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</p>
          <button className="btn btn-outline" onClick={fetchWindows}>Retry</button>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Satellite</th>
                <th>Ground Station</th>
                <th>AOS (Acquisition UTC)</th>
                <th>LOS (Loss UTC)</th>
                <th>Duration</th>
                <th>Max Elev</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>Loading contact windows...</td></tr>
              ) : filteredWindows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No contact windows found matching filter.
                  </td>
                </tr>
              ) : (
                filteredWindows.map((win: any) => (
                  <tr key={win.id}>
                    <td className="mono" style={{ fontSize: '0.875rem' }}>{win.id.slice(0, 8)}</td>
                    <td style={{ fontWeight: 500 }}>{win.satelliteName || win.satelliteId.slice(0,8)}</td>
                    <td style={{ color: 'var(--accent-secondary)' }}>{win.groundStationName || win.groundStationId.slice(0,8)}</td>
                    <td className="mono" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {format(new Date(win.aos), 'yyyy-MM-dd HH:mm:ss')} UTC
                    </td>
                    <td className="mono" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {format(new Date(win.los), 'yyyy-MM-dd HH:mm:ss')} UTC
                    </td>
                    <td className="mono">{win.durationSeconds}s</td>
                    <td>{Number(win.maxElevationDeg).toFixed(1)}°</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

