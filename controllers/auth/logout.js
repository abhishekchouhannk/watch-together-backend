const User = require('../../models/User');

const logout = async (req, res) => {
    try {
        const { sessionId } = req.cookies;
        const userId = req.user?.userId; // Assuming you have auth middleware that sets this

        if (userId && sessionId) {
            // Remove the session from database
            await User.findByIdAndUpdate(userId, {
                $pull: { sessions: { sessionId } }
            });
        }

        // Clear cookies
        res.clearCookie('accessToken');
        res.clearCookie('refreshToken');
        res.clearCookie('sessionId');

        res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during logout'
        });
    }
};

module.exports = { logout };