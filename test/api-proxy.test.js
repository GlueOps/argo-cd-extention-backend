'use strict';

// Prometheus/Tempo proxy behavior against a controllable fake upstream.
// Set env BEFORE requiring the server (config is read at module load). We point the
// proxies at local fake HTTP servers on fixed ports and keep REQUEST_TIMEOUT_MS short
// so the timeout case is fast and deterministic.
const PROM_PORT = 34191;
const TEMPO_PORT = 34192;
process.env.ALLOWED_NAMESPACES = '*';
process.env.PROMETHEUS_BASE_URL = `http://127.0.0.1:${PROM_PORT}`;
process.env.TEMPO_BASE_URL = `http://127.0.0.1:${TEMPO_PORT}`;
process.env.TEMPO_SEARCH_PATH = '/api/search';
process.env.REQUEST_TIMEOUT_MS = '300';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after } = require('node:test');

const { app } = require('../src/server');

const APP_HEADER = { 'Argocd-Application-Name': 'default:app' };

// Fake upstream whose response is selected by the `?mode=` query the test sends
// (the proxy forwards req.query verbatim, so the upstream sees it).
function makeUpstream(kind) {
  return http.createServer((req, res) => {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode');
    res.on('error', () => {});
    if (mode === 'empty') { res.writeHead(200); return res.end(''); }
    if (mode === 'nonjson') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not json</html>'); }
    if (mode === 'err500') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'slow') {
      // Never respond before the client's REQUEST_TIMEOUT_MS fires (abort in the
      // connect/headers phase — the case undici reports as a plain TypeError).
      const t = setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch (_e) { /* aborted */ } }, 5000);
      t.unref();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (kind === 'prometheus') {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, '1'] }] } }));
    }
    return res.end(JSON.stringify({ traces: [{ traceID: 'abc123' }] }));
  });
}

let server, base;
const prom = makeUpstream('prometheus');
const tempo = makeUpstream('tempo');

before(async () => {
  await new Promise(r => prom.listen(PROM_PORT, r));
  await new Promise(r => tempo.listen(TEMPO_PORT, r));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  await new Promise(r => prom.close(r));
  await new Promise(r => tempo.close(r));
});

function promGet(mode) {
  return fetch(`${base}/api/datasources/proxy/prometheus/api/v1/query?query=up&mode=${mode}`, { headers: APP_HEADER });
}
function tempoGet(mode) {
  return fetch(`${base}/api/datasources/proxy/tempo/api/search?tags=x&mode=${mode}`, { headers: APP_HEADER });
}

test('prometheus: valid JSON upstream is passed through as 200', async () => {
  const res = await promGet('ok');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.ok(Array.isArray(body.data.result));
});

test('prometheus: a 200 with an EMPTY body is surfaced as invalid_upstream_response (not a fabricated empty vector)', async () => {
  const res = await promGet('empty');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).errorType, 'invalid_upstream_response');
});

test('prometheus: a 200 with a NON-JSON body is surfaced as invalid_upstream_response', async () => {
  const res = await promGet('nonjson');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).errorType, 'invalid_upstream_response');
});

test('prometheus: a non-2xx upstream is surfaced as upstream_error (status passed through)', async () => {
  const res = await promGet('err500');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).errorType, 'upstream_error');
});

test('prometheus: a hung upstream is classified as 504 upstream_timeout (not 502)', async () => {
  const res = await promGet('slow');
  assert.equal(res.status, 504);
  assert.equal((await res.json()).errorType, 'upstream_timeout');
});

test('tempo: valid JSON upstream is passed through as 200', async () => {
  const res = await tempoGet('ok');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.traces));
  assert.equal(body.traces[0].traceID, 'abc123');
});

test('tempo: a 200 with an EMPTY body is surfaced as invalid_upstream_response with a renderable traces array', async () => {
  const res = await tempoGet('empty');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.errorType, 'invalid_upstream_response');
  assert.deepEqual(body.traces, []);
});
