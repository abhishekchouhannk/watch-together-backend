const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Configure your email transporter
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Generate verification token
const generateVerificationToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

// Send verification email
const sendVerificationEmail = async (email, username, token) => {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    
    const mailOptions = {
        from: `"${process.env.APP_NAME}" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify Your Email Address',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .button { 
                        display: inline-block; 
                        padding: 12px 24px; 
                        background-color: #007bff; 
                        color: white; 
                        text-decoration: none; 
                        border-radius: 5px; 
                        margin: 20px 0;
                    }
                    .footer { margin-top: 30px; font-size: 12px; color: #666; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>Welcome to ${process.env.APP_NAME}, ${username}!</h2>
                    <p>Thank you for registering. Please verify your email address to complete your registration.</p>
                    <a href="${verificationUrl}" class="button">Verify Email Address</a>
                    <p>Or copy and paste this link into your browser:</p>
                    <p>${verificationUrl}</p>
                    <p>This link will expire in 24 hours.</p>
                    <div class="footer">
                        <p>If you didn't create an account, please ignore this email.</p>
                    </div>
                </div>
            </body>
            </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        return { success: true };
    } catch (error) {
        console.error('Error sending verification email:', error);
        return { success: false, error: error.message };
    }
};

const sendPasswordResetEmail = async (email, username, resetToken) => {
    try {
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
        
        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: email,
            subject: 'Password Reset Request',
            html: `
                <h1>Password Reset Request</h1>
                <p>Hi ${username},</p>
                <p>You requested to reset your password. Click the link below to reset it:</p>
                <a href="${resetUrl}">Reset Password</a>
                <p>This link will expire in 1 hour.</p>
                <p>If you didn't request this, please ignore this email.</p>
            `
        };

        // Send email using your configured transporter
        await transporter.sendMail(mailOptions);
        
        return { success: true };
    } catch (error) {
        console.error('Email send error:', error);
        return { success: false, error };
    }
};

module.exports = {
    generateVerificationToken,
    sendVerificationEmail,
    sendPasswordResetEmail
};