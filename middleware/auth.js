const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticateToken = async (req, res, next) => {
  try {
    const { accessToken } = req.cookies;

    // No token → user not logged in
    if (!accessToken) {
      return res.status(401).json({ message: 'Access token missing' });
    }

    // Verify the token
    const decoded = jwt.verify(accessToken, process.env.JWT_ACCESS_SECRET);
    const userId = decoded.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    // Find user in database
    const user = await User.findById(userId).select('username email _id');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Attach user object to request
    req.user = {
      id: user._id,
      username: user.username,
      email: user.email
    };

    // Continue to next middleware/route
    next();

  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateToken };
