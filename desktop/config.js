module.exports = {
  appId: 'hc-zalo-agent',

  // VPS license endpoint. Override with env before build if using another domain.
  licenseServerUrl: process.env.LICENSE_SERVER_URL || 'https://ai.hc-agency.online/license-api',

  // Endpoint kiem tra update. Dung chung license server.
  updateCheckUrl: process.env.UPDATE_CHECK_URL || 'https://ai.hc-agency.online/license-api/api/updates/check',

  // URL chua file latest.yml va file setup.exe cho electron-updater.
  updateFeedUrl: process.env.UPDATE_FEED_URL || 'https://ai.hc-agency.online/downloads/zalo-agent/',
};
