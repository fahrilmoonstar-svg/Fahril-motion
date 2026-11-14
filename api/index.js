const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Helper: validasi link Alight Motion ----------
function isValidAmLink(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes('alightcreative.com') ||
      u.hostname.includes('alightmotion.com')
    );
  } catch {
    return false;
  }
}

// ---------- Helper: parse XML preset ----------
function parseXmlPreset(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true
  });
  const data = parser.parse(xmlText);

  const rootKeys = Object.keys(data);
  const root = rootKeys[0] || 'unknown';
  const rootNode = data[root] || {};

  const counts = { scenes: 0, layers: 0, effects: 0, elements: 0 };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (key === 'scene') counts.scenes++;
      if (key === 'layer') counts.layers++;
      if (key === 'effect') counts.effects++;
      if (key === 'element' || key === 'image' || key === 'text') counts.elements++;
      walk(node[key]);
    }
  };
  walk(data);

  return {
    root,
    counts,
    version: rootNode['@_version'] || rootNode.version || 'unknown',
    appVersion: rootNode['@_appVersion'] || 'unknown'
  };
}

// ---------- Helper: parse multipart in-memory ----------
function parseMultipart(req, maxSize = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return reject(new Error('Content-Type harus multipart/form-data'));
    }

    const bb = Busboy({ headers: req.headers });
    let fileData = null;
    let totalSize = 0;

    bb.on('file', (fieldname, file, info) => {
      const chunks = [];

      file.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          file.resume();
          return reject(new Error('File terlalu besar (maks 4 MB)'));
        }
        chunks.push(chunk);
      });

      file.on('end', () => {
        if (!info.filename || !info.filename.toLowerCase().endsWith('.xml')) {
          return reject(new Error('Hanya file .xml yang diizinkan'));
        }
        fileData = {
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
          size: totalSize
        };
      });
    });

    bb.on('close', () => {
      if (!fileData) return reject(new Error('File tidak ditemukan'));
      resolve(fileData);
    });

    bb.on('error', (err) => reject(err));
    req.pipe(bb);
  });
}

// ==================================================
// ROUTE: Health check
// ==================================================
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Rillzy Dex',
    runtime: 'vercel-functions',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// ==================================================
// ROUTE: Proses link share Alight Motion
// ==================================================
app.post('/api/render-link', async (req, res) => {
  const { link } = req.body || {};
  if (!link || typeof link !== 'string') {
    return res.status(400).json({ ok: false, error: 'Link tidak boleh kosong' });
  }
  if (!isValidAmLink(link)) {
    return res.status(400).json({ ok: false, error: 'Link bukan dari Alight Motion' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `Gagal mengambil data (HTTP ${response.status})`
      });
    }

    const html = await response.text();

    const getMeta = (prop) => {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
        'i'
      );
      const m = html.match(re);
      return m ? m[1] : null;
    };

    const title =
      getMeta('og:title') ||
      (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Preset Alight Motion');
    const description = getMeta('og:description') || null;
    const thumbnail = getMeta('og:image') || null;
    const presetIdMatch = link.match(/\/share\/([a-zA-Z0-9_-]+)/);
    const presetId = presetIdMatch ? presetIdMatch[1] : null;
    const xmlUrlMatch = html.match(/https?:\/\/[^"'\s]+\.xml[^"'\s]*/i);

    return res.json({
      ok: true,
      data: {
        link,
        presetId,
        title: title.trim(),
        description,
        thumbnail,
        hasDirectXml: !!xmlUrlMatch,
        xmlUrl: xmlUrlMatch ? xmlUrlMatch[0] : null,
        note:
          'Metadata berhasil dibaca. Untuk unduh file preset asli, ' +
          'buka link langsung di aplikasi Alight Motion (butuh login).'
      }
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'Timeout saat mengambil link' });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================================================
// ROUTE: Upload & parse XML
// ==================================================
app.post('/api/render-file', async (req, res) => {
  try {
    const file = await parseMultipart(req, 4 * 1024 * 1024);
    const xmlText = file.buffer.toString('utf8');

    if (!/^\s*</.test(xmlText)) {
      return res.status(400).json({ ok: false, error: 'File bukan XML valid' });
    }

    let parsed;
    try {
      parsed = parseXmlPreset(xmlText);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'XML gagal di-parse: ' + e.message });
    }

    return res.json({
      ok: true,
      data: {
        originalName: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.size,
        sizeKb: +(file.size / 1024).toFixed(2),
        uploadedAt: new Date().toISOString(),
        ...parsed,
        note: 'File diproses di memory. Vercel tidak menyimpan file secara permanen.'
      }
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// 404 fallback
app.use('/api/*', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan' });
});

// Error handler
app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: err.message || 'Server error' });
});

module.exports = app;
