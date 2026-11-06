'use strict';

function createPlatform() {
  if (process.platform === 'win32') return new (require('./win').WinPlatform)();
  if (process.platform === 'linux') return new (require('./linux').LinuxPlatform)();
  throw new Error('Lookout supports Windows and Linux.');
}

module.exports = { createPlatform };
