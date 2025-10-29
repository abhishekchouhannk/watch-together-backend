const express = require('express');
const router = express.Router();

// all auth controllers
const {
    forgotPassword,
    login,
    logout,
    register,
    refresh,
    resetPassword,
    verifyEmail
} = require('../controllers/auth/controller');

const { registerValidationRules, validate } = require('../utils/validators');

// // Rate limiting middleware (optional but recommended)
// const rateLimit = require('express-rate-limit');

// const registerLimiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 5, // Limit each IP to 5 registration requests per windowMs
//     message: {
//         success: false,
//         message: 'Too many registration attempts, please try again later.'
//     },
//     standardHeaders: true,
//     legacyHeaders: false,
// });

router.post('/register', registerValidationRules(), validate, register);


// @route   POST /api/auth/forgot-password
router.post('/forgot-password', forgotPassword);

// @route   POST /api/auth/login
router.post('/login', login);

// @route   POST /api/auth/logout
router.post('/logout', logout);


router.post('/refresh', refresh);
router.post('/reset-password/:token', resetPassword);
router.get('/verify-email/:token', verifyEmail);


module.exports = router;