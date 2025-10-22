const crypto = require('crypto');

const generateToken = (size = 32) => crypto.randomBytes(size).toString('hex');

module.exports = {
  generateVerificationToken: () => generateToken(32),
  generatePasswordResetToken: () => generateToken(32),
  generateSessionId: () => generateToken(32)
};
