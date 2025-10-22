const { verifyRefreshToken, generateAccessToken } = require('../../utils/jwtUtils');

const refresh = async (req, res) => {
    try {
        const { refreshToken, sessionId } = req.cookies;

        if (!refreshToken) {
            return res.status(401).json({
                success: false,
                message: 'Refresh token not provided'
            });
        }

        // Verify refresh token
        let decoded;
        try {
            decoded = verifyRefreshToken(refreshToken);
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired refresh token'
            });
        }

        // Find user and check if session exists
        const user = await User.findById(decoded.userId);
        
        if (!user || !user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive'
            });
        }

        // Verify session exists and has matching refresh token
        const session = user.sessions.find(s => 
            s.sessionId === sessionId && 
            s.refreshToken === refreshToken &&
            s.expiresAt > new Date()
        );

        if (!session) {
            return res.status(401).json({
                success: false,
                message: 'Invalid session'
            });
        }

        // Generate new access token
        const newAccessToken = generateAccessToken(user._id);

        // Set new access token cookie
        res.cookie('accessToken', newAccessToken, accessTokenCookieOptions);

        res.status(200).json({
            success: true,
            message: 'Token refreshed successfully'
        });

    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while refreshing token'
        });
    }
};

module.exports = { refresh };