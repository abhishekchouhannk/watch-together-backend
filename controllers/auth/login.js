const bcrypt = require('bcryptjs');
const User = require('../../models/User');
const { generateAccessToken, generateRefreshToken } = require('../../utils/jwtUtils');
const { generateSessionId } = require('../../utils/tokenUtils');
const { accessTokenCookieOptions, refreshTokenCookieOptions } = require('../../utils/cookieSettings');

const useragent = require("useragent");
const geoip = require("geoip-lite");

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // Find user by email
        const user = await User.findOne({ email: email.toLowerCase() });
        
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Compare password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Check if email is verified
        if (!user.isVerified) {
            return res.status(403).json({
                success: false,
                message: 'Please verify your email before logging in'
            });
        }

        // Check if account is active
        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated. Please contact support.'
            });
        }

        // Generate tokens
        const accessToken = generateAccessToken(user._id);
        const refreshToken = generateRefreshToken(user._id);

        // extract user device data for session management
        const rawIp =
            req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            req.ip ||
            req.connection.remoteAddress

        const agent = useragent.parse(req.headers["user-agent"]);
        const deviceType = req.headers["device-type"] || agent.device.toString() || "Unknown";
        const locationFromHeader = req.headers["location"];
        let location = "Unknown";

        // fallback - try geoip if location header is missing
        if (locationFromHeader && locationFromHeader !== "Unknown") {
            location = locationFromHeader;
        } else {
            const geo = geoip.lookup(rawIp);
            if (geo) location = `${geo.city || "Unknown"}, ${geo.country || "Unknown"}`;
        }
        
        // Create session
        const sessionId = generateSessionId();
        const sessionData = {
            sessionId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            deviceInfo: {
                userAgent: req.headers['user-agent'] || 'Unknown',
                ipAddress: rawIp,
                deviceType,
                location
            }
        };

        // Add session to user's sessions array
        user.sessions.push(sessionData);
        
        // Update last login
        user.lastLogin = new Date();
        
        // Save refresh token to session for validation
        const sessionIndex = user.sessions.length - 1;
        user.sessions[sessionIndex].refreshToken = refreshToken;
        
        await user.save();

        // Set cookies
        res.cookie('accessToken', accessToken, accessTokenCookieOptions);
        res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);
        res.cookie('sessionId', sessionId, refreshTokenCookieOptions);

        // Return user data (excluding sensitive information)
        const userData = {
            _id: user._id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
            joinedRooms: user.joinedRooms,
            isVerified: user.isVerified,
            lastLogin: user.lastLogin
        };

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                user: userData,
                sessionId
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during login. Please try again later.'
        });
    }
};

module.exports = { login };