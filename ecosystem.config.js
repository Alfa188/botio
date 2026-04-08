module.exports = {
  apps: [
    {
      name: 'botio',
      script: 'index.js',
      args: '--browser --workers 3',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':99',
      },
    },
  ],
};
