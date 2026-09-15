const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildState, CALC_OPTIONS } = require('./pipeline');

class WorkerPool {
  constructor(size, workerFile) {
    this.workers = Array.from({ length: size }, () => new Worker(workerFile));
    this.idle = [...this.workers];
    this.queue = [];
  }

  run(data) {
    return new Promise((resolve, reject) => {
      if (this.idle.length) {
        this._exec(this.idle.pop(), data, resolve, reject);
      } else {
        this.queue.push({ data, resolve, reject });
      }
    });
  }

  _exec(worker, data, resolve, reject) {
    worker.once('message', result => {
      if (this.queue.length) {
        const next = this.queue.shift();
        this._exec(worker, next.data, next.resolve, next.reject);
      } else {
        this.idle.push(worker);
      }
      result.error ? reject(new Error(result.error)) : resolve(result);
    });
    worker.postMessage(data);
  }

  terminate() { this.workers.forEach(w => w.terminate()); }
}

class PagePool {
  constructor(pages) {
    this.pages = [...pages];
    this.queue = [];
  }

  acquire() {
    return this.pages.length
      ? Promise.resolve(this.pages.pop())
      : new Promise(resolve => this.queue.push(resolve));
  }

  release(page) {
    if (this.queue.length) this.queue.shift()(page);
    else this.pages.push(page);
  }
}

function ffmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      if (onProgress) {
        const m = chunk.match(/frame=\s*(\d+)/);
        if (m) onProgress(parseInt(m[1]));
      }
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))));
  });
}

function getExpectedFrames(inputPath, fps) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      const duration = parseFloat(out.trim());
      resolve(isNaN(duration) ? null : Math.round(duration * fps));
    });
  });
}

async function createPage(browser, idx, width, height, range) {
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  await page.setViewport({ width, height });
  await page.setContent(`<!DOCTYPE html>
    <html><head>
      <script src="https://www.desmos.com/api/v1.9/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6"></script>
      <style>body{margin:0}#c${idx}{width:${width}px;height:${height}px}</style>
    </head><body><div id="c${idx}"></div></body></html>`,
    { waitUntil: 'networkidle0' }
  );
  const key = `_calc${idx}`;
  await page.evaluate((id, k, opts, r) => {
    window[k] = Desmos.GraphingCalculator(document.getElementById(id), opts);
    window[k].updateSettings({ showGrid: false, showXAxis: false, showYAxis: false });
    window[k].setMathBounds({ left: -(r + 0.5), right: r + 0.5, bottom: -(r + 0.5), top: r + 0.5 });
  }, `c${idx}`, key, CALC_OPTIONS, range);
  return { page, key };
}

async function renderFrame(browser, pagePool, stateJson, outPath, width, height, range, frameTimeout, retries = 2) {
  const { page, key } = await pagePool.acquire();
  try {
    await page.evaluate((json, k) => window[k].setState(JSON.parse(json)), stateJson, key);
    const dataUrl = await Promise.race([
      page.evaluate(k => new Promise(resolve => window[k].asyncScreenshot({ format: 'png' }, resolve)), key),
      new Promise((_, reject) => setTimeout(() => reject(new Error('frame timeout')), frameTimeout)),
    ]);
    fs.writeFileSync(outPath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    pagePool.release({ page, key });
  } catch (err) {
    const idx = parseInt(key.replace('_calc', ''));
    await page.close().catch(() => {});
    pagePool.release(await createPage(browser, idx, width, height, range));
    if (retries > 0) return renderFrame(browser, pagePool, stateJson, outPath, width, height, range, frameTimeout, retries - 1);
    throw err;
  }
}

async function videoToDesmos(inputPath, outputPath, options = {}) {
  const {
    fps          = 30,
    concurrency  = 4,
    width        = 800,
    height       = 800,
    frameTimeout = 60000,
    desmosRange  = 8,
    ...traceOptions
  } = options;

  const numWorkers = os.cpus().length;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desmos_video_'));
  const framesInDir  = path.join(tmpDir, 'in');
  const framesOutDir = path.join(tmpDir, 'out');
  fs.mkdirSync(framesInDir);
  fs.mkdirSync(framesOutDir);

  try {
    const expectedFrames = await getExpectedFrames(inputPath, fps);
    const totalStr = expectedFrames ? `/${expectedFrames}` : '';
    await ffmpeg(
      ['-i', inputPath, '-vf', `fps=${fps}`, '-q:v', '3', path.join(framesInDir, 'frame_%06d.jpg')],
      n => process.stdout.write(`\r  extracting [${n}${totalStr}]`)
    );
    console.log();

    const framePaths = fs.readdirSync(framesInDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(framesInDir, f));
    const total = framePaths.length;
    console.log(`  ${total} frames @ ${fps}fps`);

    console.log(`launching ${concurrency} renderer(s), ${numWorkers} trace workers...`);

    const workerPool = new WorkerPool(numWorkers, path.join(__dirname, 'worker.js'));
    const browser = await puppeteer.launch({ protocolTimeout: 0 });
    const pagePool = new PagePool(
      await Promise.all(Array.from({ length: concurrency }, (_, i) => createPage(browser, i, width, height, desmosRange)))
    );

    let done = 0;
    const start = Date.now();
    const print = () => {
      const rate = done / ((Date.now() - start) / 1000);
      const eta = Math.round((total - done) / rate);
      process.stdout.write(`\r  [${String(done).padStart(String(total).length)}/${total}]  ${rate.toFixed(1)} fr/s  eta ${eta}s`);
    };

    console.log('processing frames...');
    await Promise.all(framePaths.map(async (framePath, i) => {
      const outPath = path.join(framesOutDir, `frame_${String(i).padStart(6, '0')}.png`);
      const { expressions } = await workerPool.run({ framePath, options: { ...traceOptions, desmosRange, silent: true } });
      const stateJson = buildState(expressions, desmosRange);
      await renderFrame(browser, pagePool, stateJson, outPath, width, height, desmosRange, frameTimeout);
      done++;
      print();
    }));

    console.log();
    workerPool.terminate();
    await browser.close();

    await ffmpeg([
      '-framerate', String(fps),
      '-i', path.join(framesOutDir, 'frame_%06d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      outputPath,
    ], n => process.stdout.write(`\r  stitching [${n}/${total}]`));
    console.log();

    console.log(`Done → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const [,, inputPath, outputPath = 'output.mp4'] = process.argv;
if (!inputPath) {
  console.error('usage: node video.js <input-video> [output.mp4]');
  process.exit(1);
}

videoToDesmos(inputPath, outputPath).catch(err => { console.error(err); process.exit(1); });

module.exports = { videoToDesmos };
