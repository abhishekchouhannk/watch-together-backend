// routes/auth.js
const User = require("../../models/User");
const { generateVerificationToken, sendVerificationEmail } = require("../../utils/emailService");

const resendVerification = async ( req, res ) => {
    try {
        const { email } = req.body;
        if (!email)  return res.status(400).json({message: "Email is required." });

        const user = await User.findOne( { email: email.toLowerCase() });

        if (!user) {
            return res.status(404).json({ message: "No account found with that email. Please register."});
        }

        if (user.isVerified) {
            return res.status(400).json({message: "This account is already verified. "});
        }

        // Generate a new token and expiration
        const newToken = generateVerificationToken();
        const newExpiry = newDate(Date.now() + 24 * 60 * 60 * 1000);
        
        user.verificationToken = newToken;
        user.verificationTokenExpires = newExpiry;

        await user.save();

        await sendVerificationEmail(user.email, user.username, newToken);

        return res.status(200).json({
            message: "A new verification email has been sent to your inbox.",
        });
    } catch(err) {
        console.log(err);
        return res.status(500).json({ message: "Something went wrong while resending verification email. "});
    }
}

module.exports = { resendVerification };