import React, { useState, useEffect } from 'react';
import { LayoutDashboard, ListTodo, Satellite, Clock, Activity, Settings, Zap, Beaker, RotateCcw } from 'lucide-react';
import { api } from './api/client';

import { Dashboard } from './components/Dashboard';
import { MissionTasks } from './components/MissionTasks';
import { ContactWindows } from './components/ContactWindows';
import { GanttTimeline } from './components/GanttTimeline';
import { SchedulerRun } from './components/SchedulerRun';
import { Experiments } from './components/Experiments';
import { Satellites } from './components/Satellites';
import { OrbitalMap } from './components/orbital-map/OrbitalMap';
import { ControlPlanePanel } from './components/ControlPlanePanel';
import { Login } from './components/Login';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [activeTab, setActiveTab] = useState('map');
  const [isScheduling, setIsScheduling] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [lastRunSummary, setLastRunSummary] = useState<any>(null);

  const fetchPendingCount = async () => {
    try {
      const tasks = await api.get('/mission-tasks');
      const pending = tasks.filter((t: any) => t.status === 'PENDING').length;
      setPendingCount(pending);
    } catch (err) {
      console.error('Failed to fetch tasks', err);
    }
  };

  useEffect(() => {
    // Check if we have a valid session
    api.get('/auth/me')
      .then(() => setIsAuthenticated(true))
      .catch(() => setIsAuthenticated(false))
      .finally(() => setIsInitializing(false));
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      fetchPendingCount();
    }
  }, [activeTab, isAuthenticated]); // Refresh when tabs change

  const handleRunScheduler = async () => {
    if (pendingCount === 0) return;
    
    setIsScheduling(true);
    setLastRunSummary(null);
    try {
      const result = await api.post('/scheduler/meta/run', {});
      
      const unscheduledReasons = result.results
        .filter((r: any) => r.status === 'UNSCHEDULED')
        .reduce((acc: any, curr: any) => {
          acc[curr.reason || 'UNKNOWN'] = (acc[curr.reason || 'UNKNOWN'] || 0) + 1;
          return acc;
        }, {});

      setLastRunSummary({
        scheduled: result.scheduled,
        unscheduled: result.unscheduled,
        reasons: unscheduledReasons
      });
      
      await fetchPendingCount();
      setActiveTab('inspector');
    } catch (err: any) {
      console.error('Failed to run scheduler:', err);
      alert('Failed to run scheduler: ' + (err.error || err.message));
    } finally {
      setIsScheduling(false);
    }
  };

  const handleResetDemo = async () => {
    if (!window.confirm("This will remove all current reservations and restore the deterministic 50-task demo workload. Continue?")) {
      return;
    }
    
    setIsResetting(true);
    setLastRunSummary(null);
    try {
      await api.post('/scheduler/meta/reset', {});
      await fetchPendingCount();
      setActiveTab('dashboard'); // take them back to home
    } catch (err: any) {
      console.error('Failed to reset demo:', err);
      alert('Failed to reset demo: ' + (err.error || err.message));
    } finally {
      setIsResetting(false);
    }
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard />;
      case 'tasks': return <MissionTasks />;
      case 'windows': return <ContactWindows />;
      case 'timeline': return <ReservationTimeline />;
      case 'inspector': return <SchedulerRun />;
      case 'control-plane': return <ControlPlanePanel />;
      case 'satellites': return <Satellites />;
      case 'map': return <OrbitalMap />;
      case 'experiments': return <Experiments />;
      default: return <Dashboard />;
    }
  };

  if (isInitializing) {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Initializing...</div>;
  }

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '2rem', padding: '0 0.5rem' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <Zap className="text-gradient" size={24} />
            <span className="text-gradient">OrbitMesh</span>
          </h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Adaptive Scheduler
          </p>
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div className={`nav-item ${activeTab === 'map' ? 'active' : ''}`} onClick={() => setActiveTab('map')}>
            <Satellite size={18} /> Orbital Map
          </div>
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            <LayoutDashboard size={18} /> Dashboard
          </div>
          <div className={`nav-item ${activeTab === 'control-plane' ? 'active' : ''}`} onClick={() => setActiveTab('control-plane')}>
            <Zap size={18} /> Control Plane
          </div>
          <div className={`nav-item ${activeTab === 'tasks' ? 'active' : ''}`} onClick={() => setActiveTab('tasks')}>
            <ListTodo size={18} /> Mission Tasks
          </div>
          <div className={`nav-item ${activeTab === 'windows' ? 'active' : ''}`} onClick={() => setActiveTab('windows')}>
            <Satellite size={18} /> Contact Windows
          </div>
          <div className={`nav-item ${activeTab === 'satellites' ? 'active' : ''}`} onClick={() => setActiveTab('satellites')}>
            <Satellite size={18} /> Satellite Catalog
          </div>
          <div className={`nav-item ${activeTab === 'timeline' ? 'active' : ''}`} onClick={() => setActiveTab('timeline')}>
            <Clock size={18} /> Reservation Timeline
          </div>
          <div className={`nav-item ${activeTab === 'inspector' ? 'active' : ''}`} onClick={() => setActiveTab('inspector')}>
            <Activity size={18} /> Scheduler Logs
          </div>
          <div style={{ height: '1px', background: 'var(--border-color)', margin: '1rem 0' }} />
          <div className={`nav-item ${activeTab === 'experiments' ? 'active' : ''}`} onClick={() => setActiveTab('experiments')}>
            <Beaker size={18} /> Experiments
          </div>
        </nav>

        {/* Global Action */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          
          {lastRunSummary && (
            <div className="glass-panel" style={{ padding: '1rem', fontSize: '0.875rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Scheduler completed</div>
              <div style={{ color: 'var(--success)' }}>{lastRunSummary.scheduled} tasks scheduled</div>
              {lastRunSummary.unscheduled > 0 && (
                <div style={{ color: 'var(--warning)', marginTop: '0.25rem' }}>
                  {lastRunSummary.unscheduled} could not be scheduled
                  <div style={{ marginTop: '0.5rem', opacity: 0.8 }}>
                    {Object.entries(lastRunSummary.reasons).map(([reason, count]) => (
                      <div key={reason}>• {count as number} {reason}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <button 
            className={`btn btn-primary ${isScheduling ? 'btn-running' : ''}`}
            style={{ width: '100%', padding: '0.75rem', opacity: pendingCount === 0 && !isScheduling ? 0.5 : 1 }}
            onClick={handleRunScheduler}
            disabled={isScheduling || pendingCount === 0}
          >
            <Zap size={16} fill="currentColor" />
            {isScheduling ? '⟳ Scheduler running...' : pendingCount === 0 ? '✓ No pending tasks' : 'Run Meta-Scheduler'}
          </button>
          
          <button 
            className="btn btn-outline"
            style={{ width: '100%', padding: '0.75rem', color: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={handleResetDemo}
            disabled={isResetting || isScheduling}
          >
            <RotateCcw size={16} />
            {isResetting ? 'Resetting...' : 'Reset Demo'}
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexShrink: 0 }}>
          <h1 style={{ margin: 0 }}>
            {activeTab === 'dashboard' && 'Platform Overview'}
            {activeTab === 'tasks' && 'Mission Tasks'}
            {activeTab === 'windows' && 'Contact Windows'}
            {activeTab === 'timeline' && 'Schedule Timeline'}
            {activeTab === 'inspector' && 'Scheduler Inspection'}
            {activeTab === 'satellites' && 'Satellite Catalog'}
            {activeTab === 'map' && 'Orbital Network Map (Cesium)'}
            {activeTab === 'experiments' && 'Experiments'}
          </h1>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span className="badge badge-success">System Online</span>
            <button className="btn btn-outline" style={{ padding: '0.4rem' }}>
              <Settings size={18} />
            </button>
          </div>
        </header>

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', position: 'relative', zIndex: 10 }}>
          {/* Dynamic component rendering */}
          {activeTab === 'dashboard' && <Dashboard />}
          {activeTab === 'tasks' && <MissionTasks />}
          {activeTab === 'windows' && <ContactWindows />}
          {activeTab === 'timeline' && <GanttTimeline />}
          {activeTab === 'inspector' && <SchedulerRun />}
          {activeTab === 'satellites' && <Satellites />}
          {/* OrbitalMap is always mounted (never conditionally destroyed) to preserve
              the Cesium WebGL context and imagery layers across tab switches.
              We use CSS visibility to show/hide it instead. */}
          <div style={{ display: activeTab === 'map' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <OrbitalMap />
          </div>
          {activeTab === 'experiments' && <Experiments />}
        </main>
      </main>
    </div>
  );
}

export default App;
