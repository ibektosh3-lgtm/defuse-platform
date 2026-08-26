import { useState, useEffect } from 'react';
import api from '../api';
import { useLang } from '../i18n/LanguageContext';

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(start, end) {
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  const mins = Math.round((e - s) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STATUS_COLORS = {
  active:    { bg: 'rgba(0,255,136,0.12)', color: 'var(--green)', border: 'var(--green)' },
  completed: { bg: 'rgba(255,255,255,0.04)', color: 'var(--text2)', border: 'var(--border)' },
  cancelled: { bg: 'rgba(255,59,92,0.12)', color: 'var(--red)', border: 'var(--red)' },
};

export default function Sessions() {
  const { t } = useLang();
  const [sessions, setSessions] = useState([]);
  const [filter, setFilter]     = useState('all');
  const [loading, setLoading]   = useState(true);

  const load = (silent = false) => {
    if (!silent) setLoading(true);
    const q = filter !== 'all' ? `?status=${filter}` : '';
    api.get(`/owner/sessions${q}`)
      .then(r => setSessions(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filter]); // eslint-disable-line

  // Har 30 soniyada avtomatik yangilash
  useEffect(() => {
    const interval = setInterval(() => load(true), 30000);
    return () => clearInterval(interval);
  }, [filter]); // eslint-disable-line

  const tabs = [
    { key: 'all', label: t('allSessions') },
    { key: 'active', label: t('active') },
    { key: 'completed', label: t('completed') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{t('sessions')}</h1>
          <div style={{ color: 'var(--text2)', fontSize: 13, marginTop: 4 }}>{t('allSessions')}</div>
        </div>
        <button onClick={load} style={{
          background: 'rgba(0,212,255,0.08)', border: '1px solid var(--cyan)',
          color: 'var(--cyan)', padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        }}>{t('refresh')}</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setFilter(tab.key)} style={{
            padding: '6px 16px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            background: filter === tab.key ? 'rgba(0,212,255,0.1)' : 'transparent',
            border: `1px solid ${filter === tab.key ? 'var(--cyan)' : 'var(--border)'}`,
            color: filter === tab.key ? 'var(--cyan)' : 'var(--text2)',
          }}>{tab.label}</button>
        ))}
      </div>

      <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr 100px 100px 100px',
          padding: '10px 20px', borderBottom: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text3)', letterSpacing: 1, textTransform: 'uppercase',
        }}>
          <span>#</span>
          <span>{t('user')}</span>
          <span>{t('computer')}</span>
          <span>{t('package')}</span>
          <span>{t('started')}</span>
          <span>{t('ends')}</span>
          <span>{t('paid')}</span>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            {t('loading')}
          </div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            {t('noData')}
          </div>
        ) : sessions.map((s, i) => {
          const isOverdue = s.status === 'active' && s.ends_at && new Date(s.ends_at) < new Date();
          const sc = isOverdue
            ? { bg: 'rgba(255,59,92,0.12)', color: '#f87171', border: 'rgba(255,59,92,0.4)' }
            : STATUS_COLORS[s.status] || STATUS_COLORS.completed;
          return (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr 100px 100px 100px',
              padding: '12px 20px', borderBottom: i < sessions.length - 1 ? '1px solid var(--border)' : 'none',
              alignItems: 'center', fontSize: 13,
            }}>
              <span style={{ color: 'var(--text3)', fontSize: 11 }}>#{s.id}</span>

              <div>
                <div style={{ fontWeight: 600 }}>{s.user_name || t('guest')}</div>
                {s.user_phone && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.user_phone}</div>}
              </div>

              <div>
                <span style={{ fontFamily: 'Orbitron, sans-serif', color: 'var(--cyan)', fontSize: 12 }}>
                  PC #{s.computer_number}
                </span>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.lab_name}</div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {s.package_name || '—'}
                {s.status === 'active' && (
                  <div style={{ fontSize: 11, color: 'var(--cyan)', marginTop: 2 }}>
                    {fmtDuration(s.started_at, null)}
                  </div>
                )}
              </div>

              <span style={{ fontSize: 11, color: 'var(--text2)' }}>{fmtTime(s.started_at)}</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>{fmtTime(s.ends_at)}</span>

              <div>
                <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
                  {Number(s.amount_paid || 0).toLocaleString()} {t('sum')}
                </div>
                <span style={{
                  display: 'inline-block', marginTop: 4,
                  background: sc.bg, border: `1px solid ${sc.border}`, color: sc.color,
                  padding: '1px 7px', borderRadius: 20, fontSize: 10,
                }}>{isOverdue ? "Vaqt tugadi" : (t(s.status) || s.status)}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text3)' }}>
        Jami: {sessions.length} ta sessiya
      </div>
    </div>
  );
}
