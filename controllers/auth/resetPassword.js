const User = require('../../models/User');
const bcrypt = require('bcryptjs');

const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        if (!token || !password) {
            return res.status(400).json({
                success: false,
                message: 'Token and new password are required'
            });
        }

        // Validate password strength (add your validation logic)
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long'
            });
        }

        // Find user with valid token
        const user = await User.findOne({
            passwordResetToken: token,
            passwordResetTokenExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token'
            });
        }

        // Hash new password
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Update password and clear reset token
        user.password = hashedPassword;
        user.passwordResetToken = undefined;
        user.passwordResetTokenExpires = undefined;

        // Invalidate all sessions
        user.sessions = [];

        await user.save();

        res.status(200).json({
            success: true,
            message: 'Password reset successfully. Please login with your new password.'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while resetting password'
        });
    }
};

module.exports = { resetPassword };