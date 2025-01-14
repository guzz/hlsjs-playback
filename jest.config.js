const ClapprCorePkg = require('@guzzj/clappr-core/package.json')

module.exports = {
  verbose: true,
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^clappr$': '<rootDir>/node_modules/@guzzj/clappr-core/dist/clappr-core.js',
    '^clappr-zepto$': 'clappr-zepto/zepto.js',
  },
  globals: { CLAPPR_CORE_VERSION: ClapprCorePkg.version },
}
