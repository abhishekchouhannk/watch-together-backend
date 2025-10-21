const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { generateVerificationToken, sendVerificationEmail } = require('../utils/emailService');

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
    try {
        const { email, username, password } = req.body;

        // Check if user already exists with this email
        const existingEmail = await User.findOne({ email: email.toLowerCase() });
        if (existingEmail) {
            return res.status(409).json({
                success: false,
                message: 'An account with this email already exists'
            });
        }

        // Check if username is already taken
        const existingUsername = await User.findOne({ 
            username: { $regex: new RegExp(`^${username}$`, 'i') } 
        });
        if (existingUsername) {
            return res.status(409).json({
                success: false,
                message: 'This username is already taken'
            });
        }

        // Hash password
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Generate verification token
        const verificationToken = generateVerificationToken();
        const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // Create new user
        const newUser = new User({
            email: email.toLowerCase(),
            username: username,
            password: hashedPassword,
            verificationToken,
            verificationTokenExpires,
            isVerified: false,
            isActive: true
        });

        // Save user to database
        await newUser.save();

        // Send verification email
        const emailResult = await sendVerificationEmail(
            email,
            username,
            verificationToken
        );

        if (!emailResult.success) {
            // Log the error but don't fail the registration
            console.error('Failed to send verification email:', emailResult.error);
            
            return res.status(201).json({
                success: true,
                message: 'Registration successful, but we couldn\'t send the verification email. Please contact support.',
                data: {
                    userId: newUser._id,
                    username: newUser.username,
                    email: newUser.email,
                    emailSent: false
                }
            });
        }

        // Success response
        res.status(201).json({
            success: true,
            message: 'Registration successful! Please check your email to verify your account.',
            data: {
                userId: newUser._id,
                username: newUser.username,
                email: newUser.email,
                emailSent: true
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        
        // Handle specific MongoDB errors
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'An account with this email or username already exists'
            });
        }

        res.status(500).json({
            success: false,
            message: 'An error occurred during registration. Please try again later.'
        });
    }
};

module.exports = {
    register
};