const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    path: '/',
};

const accessTokenCookieOptions = {
    ...cookieOptions,
    maxAge: 15 * 60 * 10000, // 15 minutes
};

const refreshTokenCookieOptions = {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

module.exports = {
    accessTokenCookieOptions,
    refreshTokenCookieOptions
};