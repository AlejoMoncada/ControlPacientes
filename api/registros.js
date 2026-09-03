const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FILE_NAME = 'registros.json';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

async function gh(path, options = {}) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    const err = new Error('Faltan GITHUB_TOKEN o GIST_ID en el entorno de Vercel');
    err.status = 500;
    throw err;
  }

  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'control-pacientes-api',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(json?.message || `GitHub error ${res.status}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }

  return json;
}

async function loadRegistros() {
  const gist = await gh(`/gists/${GIST_ID}`);
  const file = gist.files?.[FILE_NAME];
  if (!file) return [];
  try {
    const parsed = JSON.parse(file.content || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRegistros(registros) {
  await gh(`/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: {
        [FILE_NAME]: {
          content: JSON.stringify(registros, null, 2),
        },
      },
    }),
  });
}

function normalizeRecord(input = {}) {
  const timestamp = Number(input.timestamp) || Date.now();
  const fecha = input.fecha || new Date(timestamp).toISOString().slice(0, 10);
  const clientId = String(input.clientId || input.client_id || `c_${timestamp}_${Math.random().toString(36).slice(2, 10)}`);

  return {
    clientId,
    timestamp,
    fecha,
    hora: input.hora || new Date(timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    doctora: input.doctora || '',
    perfilId: input.perfilId || input.perfil_id || '',
    auxiliar: input.auxiliar || '',
    estado: input.estado || '',
  };
}

function sortByTime(list) {
  return [...list].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, { ok: true });
  }

  try {
    if (req.method === 'GET') {
      const registros = sortByTime(await loadRegistros()).map((r, idx) => ({
        ...r,
        id: idx + 1,
      }));
      return send(res, 200, { ok: true, source: 'cloud', count: registros.length, registros });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const incoming = Array.isArray(body?.registros)
        ? body.registros.map(normalizeRecord)
        : [normalizeRecord(body?.registro || body || {})];

      let current = await loadRegistros();
      const byId = new Map(current.map((r) => [String(r.clientId), r]));

      for (const item of incoming) {
        if (!item.perfilId || !item.estado) continue;
        byId.set(String(item.clientId), item);
      }

      current = sortByTime([...byId.values()]);
      await saveRegistros(current);

      const registros = current.map((r, idx) => ({ ...r, id: idx + 1 }));
      return send(res, 200, { ok: true, count: registros.length, registros });
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req);
      const clientId = body?.clientId || body?.client_id;
      const perfilId = body?.perfilId || body?.perfil_id;
      let current = await loadRegistros();

      if (clientId) {
        current = current.filter((r) => String(r.clientId) !== String(clientId));
      } else if (perfilId) {
        let lastIdx = -1;
        for (let i = current.length - 1; i >= 0; i -= 1) {
          if (current[i].perfilId === perfilId) {
            lastIdx = i;
            break;
          }
        }
        if (lastIdx >= 0) current.splice(lastIdx, 1);
      } else {
        return send(res, 400, { ok: false, error: 'Indica clientId o perfilId' });
      }

      current = sortByTime(current);
      await saveRegistros(current);
      const registros = current.map((r, idx) => ({ ...r, id: idx + 1 }));
      return send(res, 200, { ok: true, count: registros.length, registros });
    }

    return send(res, 405, { ok: false, error: 'Método no permitido' });
  } catch (err) {
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || 'Error interno',
      details: err.details || null,
    });
  }
};
