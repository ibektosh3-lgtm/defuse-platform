const pool = require('../config/db');

module.exports = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Token yo\'q' });
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Ruxsat yo\'q' });
  try {
    const r = await pool.query(
      'SELECT is_super_admin FROM owners WHERE id=$1',
      [req.user.id]
    );
    if (!r.rows[0]?.is_super_admin) {
      return res.status(403).json({ error: 'Super admin huquqi kerak' });
    }
    req.isSuperAdmin = true;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};
