module.exports = {
  apps: [{
    name: 'academy-notice-board',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      BASE_URL: 'https://nuaacs.site'
    }
  }]
};
