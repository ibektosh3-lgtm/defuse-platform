import { useState, useEffect } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import api from '../api';
import { useLang } from '../i18n/LanguageContext';

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 6 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600 }}>
          {p.name}: {typeof p.value === 'number' && p.name.includes('so\'m') ? Number(p.value).toLocaleString() + ' so\'m' : p.value}
        </div>
      ))}
    </div>
  );
};

const KpiCard = ({ icon, value, label, color, sub }) => (
  <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, position: 'relative', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', top: -10, right: -10, width: 80, height: 80, borderRadius: '50%', background: color, filter: 'blur(30px)', opacity: 0.35 }} />
    <div style={{ fontSize: 26, marginBottom: 10 }}>{icon}</div>
    <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 22, fontWeight: 700, color, marginBottom: 4 }}>{value}</div>
    <div style={{ fontSize: 12, color: 'var(--text2)' }}>{label}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{sub}</div>}
  </div>
);

function fmtDay(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export default function Dashboard() {
  const { t, lang } = useLang();
  const [stats, setStats]         = useState(null);
  const [chartData, setChartData] = useState([]);
  const [topPCs, setTopPCs]       = useState([]);
  const [days, setDays]           = useState(7);
  const [loading, setLoading]     = useState(true);
  const [labs, setLabs]           = useState([]);
  const [reviews, setReviews]     = useState([]);
  const [reviewStats, setReviewStats] = useState(null);
  const [labId, setLabId]         = useState(() => {
    const saved = localStorage.getItem('dashboard_lab_id');
    return saved ? parseInt(saved) : null;
  });

  const owner = JSON.parse(localStorage.getItem('owner') || '{}');

  // Filiallar ro'yxatini bir marta olamiz
  useEffect(() => {
    api.get('/owner/labs').then(r => {
      setLabs(r.data);
      if (!r.data.length) return;
      const validIds = r.data.map(l => l.id);
      // Agar saqlangan lab_id ro'yxatda bo'lmasa (yoki hali tanlanmagan bo'lsa)
      // birinchisini avtomatik tanlaymiz
      if (!labId || !validIds.includes(labId)) {
        const first = r.data[0].id;
        setLabId(first);
        localStorage.setItem('dashboard_lab_id', String(first));
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filial o'zgarganda saqlaymiz
  useEffect(() => {
    if (labId) localStorage.setItem('dashboard_lab_id', String(labId));
  }, [labId]);

  useEffect(() => {
    if (!labId) return;
    setLoading(true);
    const q = `?lab_id=${labId}`;
    Promise.all([
      api.get(`/owner/dashboard${q}`).then(r => r.data),
      api.get(`/owner/stats/chart?days=${days}&lab_id=${labId}`).then(r => r.data),
      api.get(`/owner/stats/computers${q}`).then(r => r.data),
      api.get(`/reviews/lab/${labId}?limit=3`).then(r => r.data).catch(() => ({ reviews: [], stats: null })),
    ]).then(([s, c, pc, rv]) => {
      setStats(s);
      setChartData(c.map(row => ({
        date: fmtDay(row.date),
        [t('todayIncome')]: Number(row.revenue),
        [t('sessions_')]: Number(row.sessions),
      })));
      setTopPCs(pc.slice(0, 8));
      setReviews(rv.reviews || []);
      setReviewStats(rv.stats || null);
      setLoading(false);
    }).catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, labId, lang]);

  const selectedLab = labs.find(l => l.id === labId);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ fontFamily: 'Orbitron, sans-serif', color: 'var(--cyan)', fontSize: 18 }}>{t('loading')}</div>
    </div>
  );

  const occupancyPct = stats?.total_computers
    ? Math.round((stats.active_sessions / stats.total_computers) * 100)
    : 0;

  return (
    <div>
      {/* SARLAVHA + FILIAL TANLASH */}
      <div style={{ marginBottom: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
            {t('greeting')}, {owner.name || 'Admin'} 👋
          </h1>
          <div style={{ color: 'var(--text2)', fontSize: 14 }}>{t('todayStatus')}</div>
        </div>

        {/* FILIAL TANLASH */}
        {labs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--card2)', border: '1px solid var(--cyan)', borderRadius: 10, padding: '8px 14px' }}>
            <span style={{ fontSize: 16 }}>🏢</span>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: 1, textTransform: 'uppercase' }}>Filial</div>
              <select
                value={labId || ''}
                onChange={e => setLabId(parseInt(e.target.value))}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--cyan)',
                  fontFamily: 'Orbitron, sans-serif', fontSize: 15, fontWeight: 700,
                  cursor: 'pointer', outline: 'none', padding: 0,
                }}
              >
                {labs.map(l => (
                  <option key={l.id} value={l.id} style={{ background: 'var(--card)', color: 'var(--text)' }}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* KPI KARTALAR — barcha filiallar bo'yicha jamlangan */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
        <KpiCard icon="🖥️"
          value={`${stats?.active_sessions || 0}/${stats?.total_computers || 0}`}
          label={t('activeSessions')} color="var(--purple)"
          sub={`${occupancyPct}% bandlik`} />
        <KpiCard icon="🟢" value={stats?.available_computers || 0}
          label={t('available')} color="var(--orange)" />
        <KpiCard icon="💰"
          value={`${Number(stats?.today_income || 0).toLocaleString()} so'm`}
          label="Bugungi real daromad" color="var(--green)"
          sub="Balans to'ldirish + Bar" />
        <KpiCard icon="🍔"
          value={`${Number(stats?.snack_income || 0).toLocaleString()} so'm`}
          label={`Bar / Snack (${stats?.snack_orders_count || 0} ta)`} color="var(--yellow)" />
      </div>

      {/* MIJOZ REYTINGI — o'rtacha baho + oxirgi 3 sharh */}
      {reviewStats && Number(reviewStats.total) > 0 && (
        <div style={{
          background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14,
          padding: 20, marginBottom: 16,
          display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'center',
        }}>
          <div style={{ textAlign: 'center', borderRight: '1px solid var(--border)', paddingRight: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
              ⭐ Mijoz reytingi
            </div>
            <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 36, fontWeight: 700, color: 'var(--yellow)', lineHeight: 1 }}>
              {Number(reviewStats.avg_rating || 0).toFixed(1)}
            </div>
            <div style={{ fontSize: 16, color: 'var(--yellow)', marginTop: 4 }}>
              {'★'.repeat(Math.round(Number(reviewStats.avg_rating || 0)))}
              <span style={{ color: 'var(--border)' }}>
                {'★'.repeat(5 - Math.round(Number(reviewStats.avg_rating || 0)))}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
              {reviewStats.total} ta sharh
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, fontWeight: 600 }}>Oxirgi sharhlar</div>
            {reviews.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Hali sharh yo'q</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {reviews.map(r => (
                  <div key={r.id} style={{
                    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8,
                    padding: '8px 12px', fontSize: 12,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>
                        {r.is_anonymous ? 'Anonim' : (r.user_name || 'Mijoz')}
                      </span>
                      <span style={{ color: 'var(--yellow)' }}>
                        {'★'.repeat(r.rating)}<span style={{ color: 'var(--border)' }}>{'★'.repeat(5 - r.rating)}</span>
                      </span>
                    </div>
                    {r.comment && (
                      <div style={{ color: 'var(--text2)', fontSize: 11, lineHeight: 1.4 }}>
                        {r.comment.length > 120 ? r.comment.slice(0, 120) + '…' : r.comment}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* BALANS TO'LDIRISH — Online vs Naqd (haqiqiy daromad) */}
      <div style={{
        background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 20, marginBottom: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>
              💳 Bugungi tushum (balans to'ldirish)
            </div>
            <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 24, fontWeight: 700, color: 'var(--green)' }}>
              {Number(stats?.topup_income || 0).toLocaleString()} so'm
            </div>
            {Number(stats?.refund_total || 0) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--red)' }}>
                  ↩ Vazvrat: <b>−{Number(stats.refund_total).toLocaleString()} so'm</b>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cyan)' }}>
                  Sof: <b>{Number(stats.today_income - (stats.snack_income || 0)).toLocaleString()} so'm</b>
                </div>
              </div>
            )}
          </div>
        </div>

        {(() => {
          const src = stats?.topup_sources || { online: 0, cash: 0 };
          const items = [
            { key: 'online', label: '🌐 Online (Click / Payme)', val: src.online, color: 'var(--cyan)' },
            { key: 'cash',   label: '💵 Naqd (admin panel)',      val: src.cash,   color: 'var(--orange)' },
          ];
          const total = items.reduce((s, i) => s + i.val, 0) || 1;
          return (
            <div>
              {/* stacked progress bar */}
              <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 14, background: 'var(--border)' }}>
                {items.map(i => i.val > 0 && (
                  <div key={i.key} title={`${i.label}: ${i.val.toLocaleString()} so'm`}
                    style={{ width: `${(i.val / total) * 100}%`, background: i.color }} />
                ))}
              </div>
              {/* har tolov turi */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
                {items.map(i => {
                  const pct = total > 0 ? Math.round((i.val / total) * 100) : 0;
                  return (
                    <div key={i.key} style={{ borderLeft: `4px solid ${i.color}`, paddingLeft: 14 }}>
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>{i.label}</div>
                      <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 18, fontWeight: 700, color: i.color }}>
                        {i.val.toLocaleString()} so'm
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{pct}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* SESSIYA (PC balans sarfi + Bilyard/PS naqd daromad) va SNACK */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 32 }}>
        <KpiCard icon="🖱"
          value={`${Number((stats?.session_income || 0) - (stats?.timed_income || 0)).toLocaleString()} so'm`}
          label="PC sessiya (bugun)" color="var(--cyan)"
          sub="Balans sarfi — daromad emas" />
        <KpiCard icon="🎱"
          value={`${Number(stats?.timed_income || 0).toLocaleString()} so'm`}
          label="Bilyard / PS (bugun)" color="var(--orange)"
          sub="Naqd/karta daromad" />
        <KpiCard icon="🍔"
          value={`${Number(stats?.snack_income || 0).toLocaleString()} so'm`}
          label={`Bar / Snack (bugun)`} color="var(--yellow)"
          sub={`${stats?.snack_orders_count || 0} ta buyurtma`} />
      </div>

      {/* GRAFIK */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, marginBottom: 24 }}>

        {/* DAROMAD GRAFIGI */}
        <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('revenueChart')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[7, 14, 30].map(d => (
                <button key={d} onClick={() => setDays(d)} style={{
                  background: days === d ? 'rgba(0,212,255,0.1)' : 'transparent',
                  border: `1px solid ${days === d ? 'var(--cyan)' : 'var(--border)'}`,
                  color: days === d ? 'var(--cyan)' : 'var(--text2)',
                  padding: '4px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 11,
                }}>
                  {d} kun
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00d4ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text2)', fontSize: 11 }} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }}
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey={t('todayIncome')}
                stroke="#00d4ff" fill="url(#colorRev)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* SESSIYALAR BAR CHART */}
        <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 20 }}>{t('sessions_')} (kunlik)</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey={t('sessions_')} fill="#7c3aed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* TOP PClar */}
      <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text2)', letterSpacing: 2, textTransform: 'uppercase' }}>
          {t('topComputers')}
        </div>
        {topPCs.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{t('noData')}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {topPCs.map((pc, i) => {
              const maxRev = topPCs[0]?.total_revenue || 1;
              const pct = Math.round((pc.total_revenue / maxRev) * 100);
              const typeIcon  = { pc: '🖥', billiard: '🎱', playstation: '🎮' };
              const typeLabel = { pc: 'PC', billiard: 'Bilyard', playstation: 'PS' };
              const icon = typeIcon[pc.type] || '🖥';
              const label = typeLabel[pc.type] || 'PC';
              return (
                <div key={pc.id} style={{
                  padding: '16px 18px', borderRight: i % 4 !== 3 ? '1px solid var(--border)' : 'none',
                  borderBottom: i < topPCs.length - 4 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontFamily: 'Orbitron, sans-serif', color: 'var(--cyan)', fontSize: 13, fontWeight: 700 }}>
                      {icon} {label} #{pc.number}
                    </span>
                    <span style={{
                      background: pc.status === 'busy' ? 'rgba(255,59,92,0.15)' : 'rgba(0,255,136,0.15)',
                      color: pc.status === 'busy' ? 'var(--red)' : 'var(--green)',
                      padding: '2px 8px', borderRadius: 20, fontSize: 10,
                    }}>{pc.status === 'busy' ? 'Band' : 'Bo\'sh'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>{pc.lab_name}</div>
                  <div style={{ background: 'var(--border)', borderRadius: 4, height: 4, marginBottom: 8 }}>
                    <div style={{ background: 'var(--purple)', borderRadius: 4, height: '100%', width: `${pct}%` }} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
                    {Number(pc.total_revenue).toLocaleString()} so'm
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>{pc.total_sessions} sessiya</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* TIZIM HOLATI */}
      <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text2)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 14 }}>Tizim holati</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'Backend API', ok: true },
            { label: 'Database', ok: true },
            { label: 'To\'lov tizimi', ok: false },
            { label: 'Desktop Agent', ok: false },
          ].map(item => (
            <div key={item.label} style={{
              background: item.ok ? 'rgba(0,255,136,0.08)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${item.ok ? 'var(--green)' : 'var(--border)'}`,
              borderRadius: 8, padding: '7px 14px', fontSize: 12,
              color: item.ok ? 'var(--green)' : 'var(--text3)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>{item.ok ? '●' : '○'}</span> {item.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
