import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { format } from 'date-fns';

export const MissionTasks = () => {
  const [tasks, setTasks] = useState<any[]>([]);
  const [satellites, setSatellites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtering
  const [filter, setFilter] = useState('PENDING');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [formData, setFormData] = useState({
    satelliteId: '',
    name: '',
    description: '',
    priority: 3,
    durationSeconds: 300,
    deadline: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);

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

  const filteredTasks = tasks.filter((t) => {
    if (filter === 'ALL') return true;
    return t.status === filter;
  });

  const handleOpenModal = (task?: any) => {
    if (task) {
      setEditingTask(task);
      setFormData({
        satelliteId: task.satelliteId,
        name: task.name,
        description: task.description || '',
        priority: task.priority,
        durationSeconds: task.durationSeconds,
        deadline: new Date(task.deadline).toISOString().slice(0, 16), // datetime-local format
      });
    } else {
      setEditingTask(null);
      setFormData({
        satelliteId: satellites[0]?.id || '',
        name: '',
        description: '',
        priority: 3,
        durationSeconds: 300,
        deadline: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
      });
    }
    setIsModalOpen(true);
    setActionMenuOpen(null);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingTask(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        ...formData,
        deadline: new Date(formData.deadline).toISOString(),
      };
      
      if (editingTask) {
        await api.patch(`/mission-tasks/${editingTask.id}`, payload);
      } else {
        await api.post('/mission-tasks', payload);
      }
      handleCloseModal();
      await fetchData();
    } catch (err: any) {
      alert(`Error saving task: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelTask = async (id: string) => {
    if (!window.confirm("Are you sure you want to cancel this task?")) return;
    try {
      await api.patch(`/mission-tasks/${id}`, { status: 'CANCELLED' });
      await fetchData();
    } catch (err: any) {
      alert(`Error cancelling task: ${err.message}`);
    }
    setActionMenuOpen(null);
  };

  const isEditable = (status: string) => status === 'PENDING';

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Pending and scheduled communication tasks.</p>
        <button className="btn btn-primary" onClick={() => handleOpenModal()}>
          + Create Task
        </button>
      </div>

      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
        {['ALL', 'PENDING', 'SCHEDULED', 'COMPLETED', 'CANCELLED'].map(f => (
          <span 
            key={f}
            onClick={() => setFilter(f)}
            style={{ 
              cursor: 'pointer', 
              color: filter === f ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: filter === f ? 600 : 400,
              borderBottom: filter === f ? '2px solid var(--accent-primary)' : 'none',
              paddingBottom: '0.5rem',
              marginBottom: '-0.6rem'
            }}
          >
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
          </span>
        ))}
      </div>
      
      {error ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</p>
          <button className="btn btn-outline" onClick={fetchData}>Retry</button>
        </div>
      ) : (
        <div className="table-container" style={{ minHeight: '400px' }}>
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
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>Loading mission tasks...</td></tr>
              ) : filteredTasks.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No mission tasks found.
                  </td>
                </tr>
              ) : (
                filteredTasks.map((task: any) => {
                  const cancelled = task.status === 'CANCELLED';
                  const rowStyle = cancelled ? { opacity: 0.5, textDecoration: 'line-through' } : {};
                  return (
                    <tr key={task.id} style={rowStyle}>
                      <td className="mono" style={{ fontSize: '0.875rem' }}>{task.id.slice(0, 8)}</td>
                      <td style={{ fontWeight: 500 }}>{task.name}</td>
                      <td>{getSatelliteName(task.satelliteId)}</td>
                      <td className="mono">{task.durationSeconds}s</td>
                      <td className="mono">{format(new Date(task.deadline), 'HH:mm:ss')}</td>
                      <td>
                        <span className="badge badge-priority">P{task.priority}</span>
                      </td>
                      <td>
                        <span className={`badge ${task.status === 'SCHEDULED' ? 'badge-success' : task.status === 'PENDING' ? 'badge-warning' : ''}`}>
                          {task.status}
                        </span>
                      </td>
                      <td style={{ position: 'relative' }}>
                        {isEditable(task.status) ? (
                          <>
                            <button 
                              className="btn btn-outline" 
                              style={{ padding: '0.25rem 0.5rem', border: 'none' }}
                              onClick={() => setActionMenuOpen(actionMenuOpen === task.id ? null : task.id)}
                            >
                              ⋮
                            </button>
                            {actionMenuOpen === task.id && (
                              <div className="glass-panel" style={{
                                position: 'absolute', right: '100%', top: '50%', transform: 'translateY(-50%)',
                                zIndex: 10, display: 'flex', flexDirection: 'column', padding: '0.5rem', gap: '0.5rem',
                                minWidth: '120px'
                              }}>
                                <button className="btn btn-outline" style={{ border: 'none', justifyContent: 'flex-start' }} onClick={() => handleOpenModal(task)}>Edit</button>
                                <button className="btn btn-outline" style={{ border: 'none', justifyContent: 'flex-start', color: 'var(--danger)' }} onClick={() => handleCancelTask(task.id)}>Cancel Task</button>
                              </div>
                            )}
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {isModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999
        }}>
          <div className="glass-panel" style={{ width: '500px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3>{editingTask ? 'Edit Mission Task' : 'Create Mission Task'}</h3>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label>Satellite</label>
                <select 
                  required 
                  value={formData.satelliteId} 
                  onChange={e => setFormData({...formData, satelliteId: e.target.value})}
                  disabled={!!editingTask} // Usually shouldn't change satellite after creation
                  style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                >
                  <option value="" disabled>Select a satellite</option>
                  {satellites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.noradId})</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label>Task Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label>Description (Optional)</label>
                <textarea value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }} />
              </div>

              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                  <label>Duration (Seconds)</label>
                  <input required type="number" min="1" value={formData.durationSeconds} onChange={e => setFormData({...formData, durationSeconds: parseInt(e.target.value) || 0})} style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                  <label>Priority (1-5)</label>
                  <input required type="number" min="1" max="5" value={formData.priority} onChange={e => setFormData({...formData, priority: parseInt(e.target.value) || 3})} style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }} />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label>Deadline</label>
                <input required type="datetime-local" value={formData.deadline} onChange={e => setFormData({...formData, deadline: e.target.value})} style={{ padding: '0.5rem', background: 'var(--bg-secondary)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '4px' }} />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" className="btn btn-outline" onClick={handleCloseModal} disabled={submitting}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : 'Save Task'}</button>
              </div>

            </form>
          </div>
        </div>
      )}
    </div>
  );
};

