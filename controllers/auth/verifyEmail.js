const User = require('../../models/User');

const verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Verification token is required'
            });
        }

        // Find user with token
        const user = await User.findOne({ 
            verificationToken: token,
            verificationTokenExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired verification token'
            });
        }

        // Update user verification status
        user.isVerified = true;
        user.verificationToken = undefined;
        user.verificationTokenExpires = undefined;
        
        await user.save();

        res.status(200).json({
            success: true,
            message: 'Email verified successfully. You can now login.'
        });

    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during email verification'
        });
    }
};

module.exports = { verifyEmail };