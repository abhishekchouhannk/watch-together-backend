// routes/auth/status.js
const User = require('../../models/User');
const {
    verifyAccessToken,
    verifyRefreshToken,
    generateAccessToken
} = require('../../utils/jwtUtils');

const { accessTokenCookieOptions } = require('../../utils/cookieSettings');

const loggedIn = async(req, res) => {
    try {

        console.log(req.cookies);
        const { accessToken, refreshToken, sessionId } = req.cookies;

        // 1. No access or refresh token at all
        if (!accessToken && !refreshToken) {
            return res.status(401).json({ loggedIn: false, reason: 'No tokens found'});
        }

        // 2. Try verifying access token
        try {
            const decoded = verifyAccessToken(accessToken);
            const user = await User.findById(decoded.userId);

            if (!user || !user.isActive) {
                return res.status(401).json({ loggedIn: false, reason: 'User not found or inactive'});
            }

            // Clean expired sessions lazily
            user.sessions = user.sessions.filter(s => s.expiresAt > newDate());
            await user.save();

            return res.status(200).json({
                loggedIn: true,
                user: {
                    id: user_id,
                    username: user.username,
                    email: user.email
                }
            });
        } catch (accessTokenErr) {
            // Access Token invalid or expired - continue to refresh check
        }

        // 3. Try verifying refresh token
        if (!refreshToken) {
            return res.status(401).json({ loggedIn: false, reason: 'No refresh token'});
        }

        let decodedRefresh;
        try {
            decodedRefresh = verifyRefreshToken(refreshToken);
        } catch (refreshTokenErr) {
            // If refresh token is bad, remove session
            if (sessionId) {
                await User.updateOne(
                    { 'sessions.sessionId': sessionId },
                    { $pull: { sessions: {sessionId} } }
                );
            }
            return res.status(401).json({ loggedIn: false, reason: 'Invalid refresh token'});
        }

        // 4. Find user and matching valid session
        const user = await User.findById(decodedRefresh.userId);
        if (!user || !user.isActive) {
            return res.status(401).json({ loggedIn: false, reason: 'User not found or inactive'});
        }

        // Remove expired sessions
        const now = new Date();
        user.sessions = user.sessions.filter(s => s.expiresAt > now);
        await user.save();

        const session = user.sessions.find(
            s => s.sessionId === sessionId && s.expiresAt > now
        );

        if (!session) {
            return res.status(401).json({ loggedIn: false, reason: 'Session expired or invalid' });
        }

        // 5. If all good, issue new access token
        const newAccessToken = generateAccessToken(user._id);

        res.cookie('accessToken', newAccessToken, accessTokenCookieOptions);

        return res.status(200).json({
            loggedIn: true,
            refreshed: true,
            user: {
                id: user._id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Status check error: ', error);
        return res.status(500).json({ loggedIn: false, reason: 'Server error'});
    }
}

module.exports = { loggedIn };