const jwt = require('jsonwebtoken');

// Verifikasi JWT dan attach user ke req.user
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, role, nama }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token tidak valid atau kadaluarsa' });
  }
}

// Batasi akses berdasarkan role
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Akses ditolak. Diperlukan role: ${roles.join(' atau ')}`,
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
