import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useLang } from '../i18n/LanguageContext';

export default function Login() {
  const { t } = useLang();
  const [mode, setMode] = useState('owner'); // 'owner' | 'staff'
  const [form, setForm] = useState({ email: '', password: '', phone: '', pin: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'owner') {
        const res = await api.post('/auth/owner/login', { email: form.email, password: form.password });
        localStorage.setItem('token', res.data.token);
        localStorage.setItem('owner', JSON.stringify(res.data.owner));
      } else {
        const res = await api.post('/auth/staff/login', { phone: form.phone, pin: form.pin });
        localStorage.setItem('token', res.data.token);
        localStorage.setItem('staff', JSON.stringify(res.data.staff));
      }
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || t('loginError'));
    }
    setLoading(false);
  };

  const inp = {
    width: '100%', background: 'var(--card2)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '12px 16px', borderRadius: 10, fontSize: 14,
    outline: 'none', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at center, #0d0d28 0%, var(--bg) 100%)'
    }}>
      <div style={{
        width: 400, background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 20, padding: 40, boxShadow: '0 0 60px rgba(124,58,237,0.15)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: 28, fontWeight: 900,
            background: 'linear-gradient(135deg, var(--cyan), var(--purple))',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 8
          }}>⚡ Defuse</div>
          <div style={{ color: 'var(--text2)', fontSize: 13 }}>Admin Panel</div>
        </div>

        {/* Kirish turi */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, background: 'var(--bg2)', borderRadius: 10, padding: 4 }}>
          {[['owner', t('loginOwner')], ['staff', t('loginStaff2')]].map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); setError(''); }} style={{
              flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: mode === m ? 'var(--purple)' : 'transparent',
              color: mode === m ? '#fff' : 'var(--text2)', fontSize: 13, fontWeight: mode === m ? 700 : 400,
              transition: 'all 0.2s',
            }}>{label}</button>
          ))}
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          {mode === 'owner' ? (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 6 }}>Email</label>
                <input type="email" required value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="owner@example.com" autoComplete="off" style={inp} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 6 }}>{t('loginPassword')}</label>
                <input type="password" required value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  placeholder="••••••••" autoComplete="new-password" style={inp} />
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 6 }}>{t('loginPhone')}</label>
                <input type="tel" required value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  placeholder="+998901234567" autoComplete="off" style={inp} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 6 }}>{t('loginPin')}</label>
                <input type="password" required value={form.pin}
                  onChange={e => setForm({ ...form, pin: e.target.value })}
                  placeholder="••••" maxLength={8} autoComplete="new-password"
                  style={{ ...inp, fontSize: 24, letterSpacing: 8, textAlign: 'center' }} />
              </div>
            </>
          )}

          {error && (
            <div style={{
              background: 'rgba(255,59,92,0.1)', border: '1px solid var(--red)',
              color: 'var(--red)', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13
            }}>{error}</div>
          )}

          <button type="submit" disabled={loading} style={{
            width: '100%', background: 'linear-gradient(135deg, var(--purple), #5b21b6)',
            border: 'none', color: 'white', padding: '14px', borderRadius: 12,
            fontSize: 15, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 8px 32px rgba(124,58,237,0.4)', fontFamily: 'Inter, sans-serif'
          }}>
            {loading ? t('loginLoggingIn') : t('loginBtn')}
          </button>
        </form>
      </div>
    </div>
  );
}
