const puppeteer = require('puppeteer');
const Potrace = require('potrace');
const simplify = require('simplify-js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

function pathToPoints(d, bezierSamples = 8) {
  const contours = [];
  let current = [];
  let cursor = [0, 0];
  let startPoint = [0, 0];

  const tokens = d.match(/[A-Za-z]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
  let i = 0;
  const isCmd = t => /^[A-Za-z]$/.test(t);
  const next = () => {
    if (i >= tokens.length || isCmd(tokens[i])) throw new Error(`malformed path data at token ${i}: ${d.slice(0, 40)}`);
    return parseFloat(tokens[i++]);
  };
  const pair = rel => {
    const x = next(), y = next();
    return rel ? [cursor[0] + x, cursor[1] + y] : [x, y];
  };

  let cmd = null;
  while (i < tokens.length) {
    if (isCmd(tokens[i])) {
      cmd = tokens[i++];
    } else if (cmd === null || cmd === 'Z' || cmd === 'z') {
      throw new Error(`malformed path data at token ${i}: ${d.slice(0, 40)}`);
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        if (current.length > 1) contours.push(current);
        current = [];
        cursor = pair(rel);
        startPoint = [...cursor];
        current.push({ x: cursor[0], y: cursor[1] });
        break;
      }
      case 'L': {
        cursor = pair(rel);
        current.push({ x: cursor[0], y: cursor[1] });
        break;
      }
      case 'C': {
        const cp1 = pair(rel);
        const cp2 = pair(rel);
        const end = pair(rel);
        for (let s = 1; s <= bezierSamples; s++) {
          const t = s / bezierSamples;
          const mt = 1 - t;
          current.push({
            x: mt**3*cursor[0] + 3*mt**2*t*cp1[0] + 3*mt*t**2*cp2[0] + t**3*end[0],
            y: mt**3*cursor[1] + 3*mt**2*t*cp1[1] + 3*mt*t**2*cp2[1] + t**3*end[1],
          });
        }
        cursor = end;
        break;
      }
      case 'Z': {
        if (current.length > 1) {
          current.push({ x: startPoint[0], y: startPoint[1] });
          contours.push(current);
          current = [];
        }
        cursor = [...startPoint];
        break;
      }
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  if (current.length > 1) contours.push(current);
  return contours;
}

function extractPaths(svg) {
  const paths = [];
  const re = /\sd=(["'])([^"']+)\1/g;
  let m;
  while ((m = re.exec(svg)) !== null) paths.push(m[2]);
  return paths;
}

function getViewBox(svg) {
  const m = svg.match(/viewBox=["']([^"']+)["']/);
  const parts = m ? m[1].trim().split(/[\s,]+/).map(Number) : [];
  if (parts.length !== 4 || parts.some(Number.isNaN)) return { x: 0, y: 0, w: 500, h: 500 };
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

function buildState(expressions, range) {
  const borderLines = [
    { id: '__bt', latex: `y=${range}\\{${-range}\\le x\\le ${range}\\}` },
    { id: '__bb', latex: `y=${-range}\\{${-range}\\le x\\le ${range}\\}` },
    { id: '__bl', latex: `x=${-range}\\{${-range}\\le y\\le ${range}\\}` },
    { id: '__br', latex: `x=${range}\\{${-range}\\le y\\le ${range}\\}` },
  ].map(e => ({ type: 'expression', color: '#000000', ...e }));
  return JSON.stringify({
    version: 9,
    graph: { showGrid: false, showXAxis: false, showYAxis: false, xAxisNumbers: false, yAxisNumbers: false },
    expressions: { list: [...borderLines, ...expressions.map(e => ({ type: 'expression', ...e }))] },
  });
}

async function traceImage(imagePath, options = {}) {
  const {
    threshold     = 128,
    rdpTolerance  = 1.5,
    maxContours   = 200,
    bezierSamples = 8,
    desmosRange   = 8,
    minPoints     = 3,
    maxWidth      = 800,
    silent        = false,
  } = options;

  const buf = await sharp(imagePath)
    .grayscale()
    .normalize()
    .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const svg = await new Promise((resolve, reject) => {
    Potrace.trace(buf, { threshold, turdSize: 2 }, (err, svg) => {
      if (err) reject(err); else resolve(svg);
    });
  });

  const pathDs = extractPaths(svg);
  const { x: minX, y: minY, w, h } = getViewBox(svg);
  const scale = (2 * desmosRange) / Math.max(w, h);
  const offsetX = -(w * scale) / 2;
  const offsetY =  (h * scale) / 2;

  const norm = (pt) => ({
    x: Math.round(((pt.x - minX) * scale + offsetX) * 1e3) / 1e3,
    y: Math.round((-(pt.y - minY) * scale + offsetY) * 1e3) / 1e3,
  });

  let contours = [];
  for (const d of pathDs) {
    for (const pts of pathToPoints(d, bezierSamples)) {
      const simplified = simplify(pts, rdpTolerance, true);
      if (simplified.length < minPoints) continue;
      contours.push(simplified.map(norm));
    }
  }

  contours.sort((a, b) => b.length - a.length);
  contours = contours.slice(0, maxContours);

  if (!silent) console.log(`  ${pathDs.length} paths into ${contours.length} contours`);

  const expressions = [];
  contours.forEach((pts, i) => {
    const n = i + 1;
    expressions.push({ id: `xs${n}`, latex: `x_{${n}}=[${pts.map(p => p.x).join(',')}]` });
    expressions.push({ id: `ys${n}`, latex: `y_{${n}}=[${pts.map(p => p.y).join(',')}]` });
    expressions.push({ id: `p${n}`, latex: `(x_{${n}},y_{${n}})`, lines: true, points: false, color: '#000000' });
  });

  return { svg, expressions };
}

async function imageToExpressions(imagePath, options = {}) {
  const { expressions } = await traceImage(imagePath, options);
  return expressions;
}

const CALC_OPTIONS = {
  keypad: false, expressions: false, settingsMenu: false,
  zoomButtons: false, border: false,
  showGrid: false, showXAxis: false, showYAxis: false,
};

class DesmosRenderer {
  constructor(width = 800, height = 800, range = 8) {
    this.width = width;
    this.height = height;
    this.range = range;
    this.browser = null;
    this.page = null;
  }

  async init() {
    this.browser = await puppeteer.launch({ protocolTimeout: 0 });
    this.page = await this.browser.newPage();
    this.page.setDefaultTimeout(0);
    await this.page.setViewport({ width: this.width, height: this.height });
    await this.page.setContent(`<!DOCTYPE html>
      <html><head>
        <script src="https://www.desmos.com/api/v1.9/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6"></script>
        <style>body{margin:0}#c{width:${this.width}px;height:${this.height}px}</style>
      </head><body><div id="c"></div></body></html>`,
      { waitUntil: 'networkidle0' }
    );
    await this.page.evaluate((opts, r) => {
      window._calc = Desmos.GraphingCalculator(document.getElementById('c'), opts);
      window._calc.updateSettings({ showGrid: false, showXAxis: false, showYAxis: false });
      window._calc.setMathBounds({ left: -(r + 0.5), right: r + 0.5, bottom: -(r + 0.5), top: r + 0.5 });
    }, CALC_OPTIONS, this.range);
  }

  async render(expressions, outputPath) {
    const stateJson = buildState(expressions, this.range);
    const dataUrl = await this.page.evaluate((json) => {
      window._calc.setState(JSON.parse(json));
      return new Promise(resolve => window._calc.asyncScreenshot({ format: 'png' }, resolve));
    }, stateJson);
    fs.writeFileSync(outputPath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }

  async close() {
    await this.browser?.close();
  }
}

async function main() {
  const [,, inputPath, outputPath = 'output.png'] = process.argv;
  if (!inputPath) {
    console.error('usage: node pipeline.js <input-image> [output.png]');
    process.exit(1);
  }

  console.log(`tracing ${inputPath}...`);
  const expressions = await imageToExpressions(inputPath);
  console.log(`  ${expressions.length} total expressions`);

  console.log('rendering...');
  const renderer = new DesmosRenderer();
  await renderer.init();
  await renderer.render(expressions, outputPath);
  await renderer.close();

  console.log(`done ${outputPath}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { traceImage, imageToExpressions, DesmosRenderer, buildState, CALC_OPTIONS };
