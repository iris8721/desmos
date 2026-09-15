const { parentPort } = require('worker_threads');
const { imageToExpressions } = require('./pipeline');

parentPort.on('message', async ({ framePath, options }) => {
  try {
    const expressions = await imageToExpressions(framePath, { ...options, silent: true });
    parentPort.postMessage({ expressions, error: null });
  } catch (err) {
    parentPort.postMessage({ expressions: null, error: String((err && err.message) || err) });
  }
});
