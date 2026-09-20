// src/routes/tracking.js
const router = require('express').Router();
const { trackPackage } = require('../controllers/trackingController');

// Endpoint publik - tidak perlu autentikasi
router.get('/:kode_paket', trackPackage);

module.exports = router;
