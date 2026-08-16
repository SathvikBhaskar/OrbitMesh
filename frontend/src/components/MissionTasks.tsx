import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const MissionTasks = () => {
  const [tasks, setTasks] = useState([]);
  const [satellites, setSatellites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasksData, satsData] = await Promise.all([
        api.get('/mission-tasks'),
        api.get('/satellites')
      ]);
      setTasks(tasksData);
      setSatellites(satsData);
    } catch (err: any) {
      console.error(err);
      setError('Unable to load mission tasks.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const getSatelliteName = (id: string) => {
    const sat: any = satellites.find((s: any) => s.id === id);
    return sat ? sat.name : id;
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Pending and scheduled communication tasks.</p>
      </div>
      
      {error ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</p>
          <button className="btn btn-outline" onClick={fetchData}>Retry</button>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Task ID</th>
                <th>Name</th>
                <th>Satellite</th>
                <th>Duration</th>
                <th>Deadline</th>
                <th>Priority</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>Loading mission tasks...</td></tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No mission tasks found. Reset the demo to generate tasks.
                  </td>
                </tr>
              ) : (
                tasks.map((task: any) => (
                  <tr key={task.id}>
                    <td className="mono" style={{ fontSize: '0.875rem' }}>{task.id.slice(0, 8)}</td>
                    <td style={{ fontWeight: 500 }}>{task.name}</td>
                    <td>{getSatelliteName(task.satelliteId)}</td>
                    <td className="mono">{task.durationSeconds}s</td>
                    <td className="mono">{format(new Date(task.deadline), 'HH:mm:ss')}</td>
                    <td>
                      <span className="badge badge-priority">P{task.priority}</span>
                    </td>
                    <td>
                      <span className={`badge ${task.status === 'SCHEDULED' ? 'badge-success' : 'badge-warning'}`}>
                        {task.status}
                      </span>
                    </td>
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

