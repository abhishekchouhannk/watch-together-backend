const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const { verifyAccessToken } = require("../../utils/jwtUtils");

const logout = async (req, res) => {
  try {
    const { accessToken, sessionId } = req.cookies;

    let userId = null;

    // Decode JWT to get userId
    if (accessToken) {
      try {
        const decoded = verifyAccessToken(accessToken);
        userId = decoded.userId;
      } catch (err) {
        console.error("JWT verification failed:", err.message);
      }
    }

    console.log(sessionId);
    console.log(userId);

    const result = await User.findByIdAndUpdate(
      userId,
      { $pull: { sessions: { sessionId } } },
      { new: true }
    );

    if (!result) {
      console.warn(`Logout: user ${userId} or session ${sessionId} not found.`);
    }

    // Clear cookies
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");
    res.clearCookie("sessionId");

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during logout",
    });
  }
};

module.exports = { logout };
