const { body, validationResult } = require('express-validator');

// Validation rules for registration
const registerValidationRules = () => {
    return [
        body('email')
            .trim()
            .isEmail()
            .withMessage('Please provide a valid email address')
            .normalizeEmail()
            .isLength({ max: 255 })
            .withMessage('Email must not exceed 255 characters'),
        
        body('username')
            .trim()
            .isLength({ min: 3, max: 30 })
            .withMessage('Username must be between 3 and 30 characters')
            .matches(/^[a-zA-Z0-9_-]+$/)
            .withMessage('Username can only contain letters, numbers, underscores, and hyphens')
            .custom(value => {
                if (value.toLowerCase() === 'admin' || value.toLowerCase() === 'root') {
                    throw new Error('This username is reserved');
                }
                return true;
            }),
        
        body('password')
            .isLength({ min: 8 })
            .withMessage('Password must be at least 8 characters long')
            .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
            .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
        
        // body('confirmPassword')
        //     .custom((value, { req }) => {
        //         if (value !== req.body.password) {
        //             throw new Error('Passwords do not match');
        //         }
        //         return true;
        //     })
    ];
};

// Middleware to check validation results
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            errors: errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }
        ))
        });
    }
    next();
};

module.exports = {
    registerValidationRules,
    validate
};