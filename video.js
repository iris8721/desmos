const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildState, withTimeout, CALC_OPTIONS } = require('./pipeline');

class WorkerPool {
  constructor(size, workerFile) {
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.tasks = new Map();
    this.error = null;
    for (let i = 0; i < size; i++) this._spawn(workerFile);
  }

  _spawn(workerFile) {
    const worker = new Worker(workerFile);
    worker.on('message', result => {
      const task = this.tasks.get(worker);
      if (!task) return;
      this.tasks.delete(worker);
      this._next(worker);
      result.error ? task.reject(new Error(result.error)) : task.resolve(result);
    });
    const fail = err => {
      if (!this.workers.delete(worker)) return;
      this.idle = this.idle.filter(w => w !== worker);
      const task = this.tasks.get(worker);
      this.tasks.delete(worker);
      if (task) task.reject(err);
      if (this.workers.size === 0) {
        this.error = err;
        this.queue.splice(0).forEach(t => t.reject(err));
      }
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`worker exited with code ${code}`)));
    this.workers.add(worker);
    this.idle.push(worker);
  }

  run(data) {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      const task = { data, resolve, reject };
      if (this.idle.length) this._exec(this.idle.pop(), task);
      else this.queue.push(task);
    });
  }

  _exec(worker, task) {
    this.tasks.set(worker, task);
    worker.postMessage(task.data);
  }

  _next(worker) {
    if (this.queue.length) this._exec(worker, this.queue.shift());
    else this.idle.push(worker);
  }

  terminate() {
    const err = new Error('worker pool terminated');
    this.error = err;
    const workers = [...this.workers];
    this.workers.clear();
    this.queue.splice(0).forEach(t => t.reject(err));
    this.tasks.forEach(t => t.reject(err));
    this.tasks.clear();
    return Promise.all(workers.map(w => w.terminate()));
  }
}

class PagePool {
  constructor(pages) {
    this.pages = [...pages];
    this.size = pages.length;
    this.queue = [];
    this.error = null;
  }

  acquire() {
    if (this.error) return Promise.reject(this.error);
    return this.pages.length
      ? Promise.resolve(this.pages.pop())
      : new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  release(page) {
    if (this.queue.length) this.queue.shift().resolve(page);
    else this.pages.push(page);
  }

  drop(err) {
    if (--this.size > 0) return;
    this.error = err;
    this.queue.splice(0).forEach(w => w.reject(err));
  }
}

function spawnError(name, err) {
  return err.code === 'ENOENT' ? new Error(`${name} not found on PATH`) : err;
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
    proc.on('error', err => reject(spawnError('ffmpeg', err)));
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
    proc.on('error', () => resolve(null));
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
    const dataUrl = await withTimeout(page.evaluate((json, k) => {
      window[k].setState(JSON.parse(json));
      return new Promise(resolve => window[k].asyncScreenshot({ format: 'png' }, resolve));
    }, stateJson, key), frameTimeout, 'frame timeout');
    fs.writeFileSync(outPath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    pagePool.release({ page, key });
  } catch (err) {
    const idx = parseInt(key.replace('_calc', ''));
    await withTimeout(page.close(), 5000, 'page close timeout').catch(() => {});
    let replacement;
    try {
      replacement = await createPage(browser, idx, width, height, range);
    } catch (createErr) {
      pagePool.drop(createErr);
      throw createErr;
    }
    pagePool.release(replacement);
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

    const browser = await puppeteer.launch({ protocolTimeout: 0 });
    const workerPool = new WorkerPool(numWorkers, path.join(__dirname, 'worker.js'));
    try {
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
      let nextFrame = 0;
      let failure = null;
      const lane = async () => {
        while (nextFrame < total && !failure) {
          const i = nextFrame++;
          try {
            const outPath = path.join(framesOutDir, `frame_${String(i).padStart(6, '0')}.png`);
            const { expressions } = await workerPool.run({ framePath: framePaths[i], options: { ...traceOptions, desmosRange, silent: true } });
            const stateJson = buildState(expressions, desmosRange);
            await renderFrame(browser, pagePool, stateJson, outPath, width, height, desmosRange, frameTimeout);
            done++;
            print();
          } catch (err) {
            failure ??= err;
          }
        }
      };
      await Promise.all(Array.from({ length: numWorkers + concurrency }, lane));
      if (failure) throw failure;
      console.log();
    } finally {
      await workerPool.terminate().catch(() => {});
      await browser.close().catch(() => {});
    }

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

if (require.main === module) {
  const [,, inputPath, outputPath = 'output.mp4'] = process.argv;
  if (!inputPath) {
    console.error('usage: node video.js <input-video> [output.mp4]');
    process.exit(1);
  }
  videoToDesmos(inputPath, outputPath).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { videoToDesmos };
