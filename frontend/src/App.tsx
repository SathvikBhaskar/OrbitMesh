import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, ListTodo, Satellite, Clock, Activity, Settings, 
  Zap, Beaker, RotateCcw, Globe, Radio, LogOut, User, Menu, X, 
  Shield, Server, RefreshCw, CheckCircle2 
} from 'lucide-react';
import { api, setAccessToken } from './api/client';

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
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; role: string } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [isPinging, setIsPinging] = useState(false);

  const [activeTab, setActiveTab] = useState('map');
  const [isScheduling, setIsScheduling] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [lastRunSummary, setLastRunSummary] = useState<any>(null);

  const fetchCurrentUser = async () => {
    try {
      const user = await api.get('/auth/me');
      setCurrentUser(user);
      setIsAuthenticated(true);
    } catch {
      setIsAuthenticated(false);
      setCurrentUser(null);
    } finally {
      setIsInitializing(false);
    }
  };

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
    fetchCurrentUser();
  }, []);

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout', {});
    } catch (err) {
      console.warn('Logout failed', err);
    } finally {
      setAccessToken(null);
      setIsAuthenticated(false);
      setCurrentUser(null);
    }
  };

  const handlePingHealth = async () => {
    setIsPinging(true);
    try {
      const start = Date.now();
      const res = await api.get('/health');
      const latency = Date.now() - start;
      setHealthStatus(`ONLINE (${latency}ms) - Database: ${res.database || 'CONNECTED'}`);
    } catch (e: any) {
      setHealthStatus(`ERROR: ${e.message}`);
    } finally {
      setIsPinging(false);
    }
  };

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
    return <Login onLogin={() => { setIsAuthenticated(true); fetchCurrentUser(); }} />;
  }

  return (
    <div className="app-container">
      {/* Mobile Drawer Backdrop */}
      <div 
        className={`sidebar-backdrop ${isMobileMenuOpen ? 'open' : ''}`} 
        onClick={() => setIsMobileMenuOpen(false)} 
      />

      {/* Sidebar Navigation */}
      <aside className={`sidebar ${isMobileMenuOpen ? 'open' : ''}`} style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '1.5rem', padding: '0 0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
              <Zap className="text-gradient" size={24} />
              <span className="text-gradient">OrbitMesh</span>
            </h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Adaptive Scheduler
            </p>
          </div>
          <button 
            className="mobile-header-toggle" 
            onClick={() => setIsMobileMenuOpen(false)}
            style={{ padding: '0.3rem' }}
          >
            <X size={18} />
          </button>
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div className={`nav-item ${activeTab === 'map' ? 'active' : ''}`} onClick={() => { setActiveTab('map'); setIsMobileMenuOpen(false); }}>
            <Globe size={18} /> Orbital Map
          </div>
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => { setActiveTab('dashboard'); setIsMobileMenuOpen(false); }}>
            <LayoutDashboard size={18} /> Dashboard
          </div>
          <div className={`nav-item ${activeTab === 'control-plane' ? 'active' : ''}`} onClick={() => { setActiveTab('control-plane'); setIsMobileMenuOpen(false); }}>
            <Zap size={18} /> Control Plane
          </div>
          <div className={`nav-item ${activeTab === 'tasks' ? 'active' : ''}`} onClick={() => { setActiveTab('tasks'); setIsMobileMenuOpen(false); }}>
            <ListTodo size={18} /> Mission Tasks
          </div>
          <div className={`nav-item ${activeTab === 'windows' ? 'active' : ''}`} onClick={() => { setActiveTab('windows'); setIsMobileMenuOpen(false); }}>
            <Radio size={18} /> Contact Windows
          </div>
          <div className={`nav-item ${activeTab === 'satellites' ? 'active' : ''}`} onClick={() => { setActiveTab('satellites'); setIsMobileMenuOpen(false); }}>
            <Satellite size={18} /> Satellite Catalog
          </div>
          <div className={`nav-item ${activeTab === 'timeline' ? 'active' : ''}`} onClick={() => { setActiveTab('timeline'); setIsMobileMenuOpen(false); }}>
            <Clock size={18} /> Reservation Timeline
          </div>
          <div className={`nav-item ${activeTab === 'inspector' ? 'active' : ''}`} onClick={() => { setActiveTab('inspector'); setIsMobileMenuOpen(false); }}>
            <Activity size={18} /> Scheduler Logs
          </div>
          <div style={{ height: '1px', background: 'var(--border-color)', margin: '0.75rem 0' }} />
          <div className={`nav-item ${activeTab === 'experiments' ? 'active' : ''}`} onClick={() => { setActiveTab('experiments'); setIsMobileMenuOpen(false); }}>
            <Beaker size={18} /> Experiments
          </div>
        </nav>

        {/* Global Action & User Session */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingTop: '1rem' }}>
          
          {lastRunSummary && (
            <div className="glass-panel" style={{ padding: '0.75rem', fontSize: '0.825rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.35rem', color: 'var(--text-primary)' }}>Scheduler completed</div>
              <div style={{ color: 'var(--success)' }}>{lastRunSummary.scheduled} tasks scheduled</div>
              {lastRunSummary.unscheduled > 0 && (
                <div style={{ color: 'var(--warning)', marginTop: '0.2rem' }}>
                  {lastRunSummary.unscheduled} could not be scheduled
                  <div style={{ marginTop: '0.35rem', opacity: 0.8, fontSize: '0.75rem' }}>
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
            style={{ width: '100%', padding: '0.65rem', opacity: pendingCount === 0 && !isScheduling ? 0.5 : 1 }}
            onClick={handleRunScheduler}
            disabled={isScheduling || pendingCount === 0}
          >
            <Zap size={16} fill="currentColor" />
            {isScheduling ? '⟳ Running...' : pendingCount === 0 ? '✓ No pending tasks' : 'Run Meta-Scheduler'}
          </button>
          
          <button 
            className="btn btn-outline"
            style={{ width: '100%', padding: '0.65rem', color: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={handleResetDemo}
            disabled={isResetting || isScheduling}
          >
            <RotateCcw size={16} />
            {isResetting ? 'Resetting...' : 'Reset Demo'}
          </button>

          {/* User Session Profile & Logout */}
          {currentUser && (
            <div style={{
              marginTop: '0.5rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <div style={{
                  width: '30px',
                  height: '30px',
                  borderRadius: '50%',
                  background: 'rgba(99, 102, 241, 0.2)',
                  border: '1px solid var(--accent-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--accent-secondary)',
                  flexShrink: 0
                }}>
                  <User size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {currentUser.email}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--accent-secondary)', fontWeight: 500, letterSpacing: '0.04em' }}>
                    ROLE: {currentUser.role}
                  </div>
                </div>
              </div>

              <button
                className="btn btn-outline"
                style={{ width: '100%', padding: '0.45rem', fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                onClick={handleLogout}
              >
                <LogOut size={13} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexShrink: 0, gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="mobile-header-toggle" onClick={() => setIsMobileMenuOpen(true)}>
              <Menu size={20} />
            </button>
            <h1 style={{ margin: 0, fontSize: '1.5rem' }}>
              {activeTab === 'dashboard' && 'Platform Overview'}
              {activeTab === 'control-plane' && 'Event Control Plane & Replanning'}
              {activeTab === 'tasks' && 'Mission Tasks'}
              {activeTab === 'windows' && 'Contact Windows'}
              {activeTab === 'timeline' && 'Schedule Timeline'}
              {activeTab === 'inspector' && 'Scheduler Inspection'}
              {activeTab === 'satellites' && 'Satellite Catalog'}
              {activeTab === 'map' && 'Orbital Network Map (Cesium)'}
              {activeTab === 'experiments' && 'Experiments'}
            </h1>
          </div>
          
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <span className="badge badge-success">System Online</span>
            <button 
              className="btn btn-outline" 
              style={{ padding: '0.45rem', borderRadius: '6px' }}
              onClick={() => setIsSettingsOpen(true)}
              title="System Diagnostics & Settings"
            >
              <Settings size={18} />
            </button>
          </div>
        </header>

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', position: 'relative', zIndex: 10 }}>
          {/* Dynamic component rendering */}
          {activeTab === 'dashboard' && <Dashboard />}
          {activeTab === 'control-plane' && <ControlPlanePanel />}
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

      {/* System Diagnostics & Settings Modal */}
      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <Settings size={20} className="text-gradient" />
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>System Diagnostics & Configuration</h3>
              </div>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.25rem' }}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                  Platform Diagnostics
                </h4>
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Core Build</span>
                    <span className="mono">OrbitMesh v2.4.0 (Phase 5 Certified)</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>API Server</span>
                    <span className="mono">http://localhost:4000/api</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Database</span>
                    <span className="mono">PostgreSQL 16 · Drizzle ORM Pool Active</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Scheduler Engine</span>
                    <span className="mono">Hybrid Scoring Meta-Scheduler</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>User Session</span>
                    <span className="mono">{currentUser ? `${currentUser.email} (${currentUser.role})` : 'Anonymous'}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                  Live Health Check
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  <button 
                    className="btn btn-outline" 
                    onClick={handlePingHealth}
                    disabled={isPinging}
                    style={{ fontSize: '0.8rem', padding: '0.45rem 0.85rem' }}
                  >
                    <RefreshCw size={14} className={isPinging ? 'btn-running' : ''} />
                    {isPinging ? 'Pinging /health...' : 'Ping /health Endpoint'}
                  </button>
                  {healthStatus && (
                    <span style={{ fontSize: '0.825rem', color: healthStatus.startsWith('ONLINE') ? 'var(--success)' : 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
                      {healthStatus}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                  Operational Shortcuts
                </h4>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button 
                    className="btn btn-outline"
                    style={{ fontSize: '0.8rem', padding: '0.45rem 0.85rem', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                    onClick={() => { setIsSettingsOpen(false); handleResetDemo(); }}
                  >
                    <RotateCcw size={14} /> Full Demo Reset
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button 
                className="btn btn-primary" 
                onClick={() => setIsSettingsOpen(false)}
                style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}
              >
                Close Diagnostics
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
