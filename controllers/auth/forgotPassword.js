const { generatePasswordResetToken } = require('../../utils/tokenUtils');
const { sendPasswordResetEmail } = require('../../utils/emailService');
const User = require('../../models/User');

const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        // Find user
        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            // Don't reveal if email exists
            return res.status(200).json({
                success: true,
                message: 'If an account exists with this email, you will receive password reset instructions.'
            });
        }

        // Generate reset token
        const resetToken = generatePasswordResetToken();
        const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        try {
  user.passwordResetToken = resetToken;
  user.passwordResetTokenExpires = resetTokenExpires;
  await user.save();
  console.log("User document saved successfully!");
} catch (error) {
  console.error("Error saving user document:", error);
}

        // Send reset email
        const emailResult = await sendPasswordResetEmail(
            user.email,
            user.username,
            resetToken
        );

        if (!emailResult.success) {
            console.error('Failed to send password reset email:', emailResult.error);
        }

        res.status(200).json({
            success: true,
            message: 'If an account exists with this email, you will receive password reset instructions.'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while processing your request'
        });
    }
};

module.exports = { forgotPassword };