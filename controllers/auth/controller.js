const { forgotPassword } = require('./forgotPassword');
const { login } = require('./login');
const { logout } = require('./logout');
const { refresh } = require('./refresh');
const { register } = require('./register');
const { resetPassword } = require('./resetPassword');
const { verifyEmail } = require('./verifyEmail');

module.exports = {
    forgotPassword,
    login,
    logout,
    register,
    refresh,
    resetPassword,
    verifyEmail
};