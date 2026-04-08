module.exports = {
  apps: [
    {
      name: 'botio',
      script: 'index.js',
      args: '--ws --workers 15',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
