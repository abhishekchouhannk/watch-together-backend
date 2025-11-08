const { forgotPassword } = require('./forgotPassword');
const { login } = require('./login');
const { loggedIn } = require('./loggedIn');
const { logout } = require('./logout');
const { refresh } = require('./refresh');
const { register } = require('./register');
const { resetPassword } = require('./resetPassword');

// verification Endpoints
const { resendVerification } = require('./resendVerification');
const { verifyEmail } = require('./verifyEmail');

module.exports = {
    forgotPassword,
    login,
    loggedIn,
    logout,
    register,
    refresh,
    resetPassword,
    verifyEmail,
    resendVerification
};