const express = require('express');
const router = express.Router();
const { register } = require('../controllers/authController');
const { registerValidationRules, validate } = require('../utils/validators');

// Rate limiting middleware (optional but recommended)
const rateLimit = require('express-rate-limit');

const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 registration requests per windowMs
    message: {
        success: false,
        message: 'Too many registration attempts, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// @route   POST /api/auth/register
router.post(
    '/register',
    registerLimiter,
    registerValidationRules(),
    validate,
    register
);

module.exports = router;