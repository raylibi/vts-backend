// src/routes/manifest.js
const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/manifestController');
const { authenticate, authorize } = require('../middleware/auth');
const { validateRequest } = require('../middleware/errorHandler');

router.get('/', authenticate, authorize('admin'), ctrl.getAllManifests);
router.get('/:id', authenticate, ctrl.getManifestById);
router.post('/',
  authenticate,
  authorize('admin'),
  [
    body('kode_manifest').notEmpty().withMessage('Kode manifest wajib diisi'),
    body('packages').isArray({ min: 1 }).withMessage('Packages harus berupa array minimal 1 item'),
  ],
  validateRequest,
  ctrl.createManifest
);
router.patch('/:id/status', authenticate, authorize('admin'), ctrl.updateManifestStatus);

module.exports = router;
