import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const ContactWindows = () => {
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <p style={{ color: 'var(--text-secondary)' }}>
        Available synthetic satellite-ground-station contact windows generated from deterministic orbital/demo data.
      </p>
      
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
                <th>AOS (Acquisition)</th>
                <th>LOS (Loss)</th>
                <th>Duration</th>
                <th>Max Elev</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>Loading contact windows...</td></tr>
              ) : windows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No contact windows generated yet. Reset the demo to generate windows.
                  </td>
                </tr>
              ) : (
                windows.map((win: any) => (
                  <tr key={win.id}>
                    <td className="mono" style={{ fontSize: '0.875rem' }}>{win.id.slice(0, 8)}</td>
                    <td style={{ fontWeight: 500 }}>{win.satelliteName || win.satelliteId.slice(0,8)}</td>
                    <td style={{ color: 'var(--accent-secondary)' }}>{win.groundStationName || win.groundStationId.slice(0,8)}</td>
                    <td className="mono">{format(new Date(win.aos), 'HH:mm:ss')}</td>
                    <td className="mono">{format(new Date(win.los), 'HH:mm:ss')}</td>
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

