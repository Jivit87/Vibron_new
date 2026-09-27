/** @param {{ VIBERON_DEV_SERVER_URL?: string }} [env] */
function getDevServerUrl(env = process.env) {
  return env.VIBERON_DEV_SERVER_URL || "http://127.0.0.1:3000";
}

module.exports = { getDevServerUrl };
