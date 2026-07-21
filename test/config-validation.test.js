'use strict';

// Config validation runs at module load and calls process.exit(1), so it can only
// be exercised from a child process. Each case boots src/server.js with one bad
// env var and asserts the process refuses to start with an actionable [FATAL].

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// A rejected config exits 1 immediately; an accepted one reaches listen() and runs
// until the timeout kills it (status null). So "booted cleanly" is asserted as
// "printed the [CONFIG] line and never printed [FATAL]", which holds either way and
// does not depend on how the child was reaped.
function boot(env) {
  const res = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT++), ...env },
    encoding: 'utf8',
    timeout: 3000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

let PORT = 45311;

test('PROMETHEUS_BASE_URL without a scheme is rejected at boot, not at request time', () => {
  const res = boot({ PROMETHEUS_BASE_URL: 'prometheus.monitoring:9090' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[FATAL\] PROMETHEUS_BASE_URL must be an http\(s\) URL/);
});

test('TEMPO_BASE_URL without a scheme is rejected at boot', () => {
  const res = boot({ TEMPO_BASE_URL: 'tempo.tracing:3200' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[FATAL\] TEMPO_BASE_URL must be an http\(s\) URL/);
});

// Sibling of the above: a whitespace-only value is truthy, so without the trim it
// would slip past the `if (!PROMETHEUS_BASE_URL)` config guard and only fail inside
// the request handler as a misleading 502.
test('a whitespace-only base URL is treated as unset, not as a configured upstream', () => {
  const res = boot({ PROMETHEUS_BASE_URL: '   ', TEMPO_BASE_URL: '   ' });
  assert.doesNotMatch(res.stderr, /\[FATAL\]/);
  assert.match(res.stdout, /\[CONFIG\]/);
});

test('a well-formed http(s) base URL boots cleanly', () => {
  const res = boot({
    PROMETHEUS_BASE_URL: 'http://prometheus.monitoring:9090',
    TEMPO_BASE_URL: 'https://tempo.tracing:3200/'
  });
  assert.doesNotMatch(res.stderr, /\[FATAL\]/);
  assert.match(res.stdout, /\[CONFIG\]/);
});

// A scheme-prefix regex is not enough: an embedded space passes `^https?://` but is
// rejected by new URL() and would otherwise fail on every request as a 502
// misattributed to the upstream. Fail at boot instead.
test('a base URL that passes the scheme prefix but is not a valid URL is rejected at boot', () => {
  const res = boot({ PROMETHEUS_BASE_URL: 'https://exa mple.com:9090' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[FATAL\] PROMETHEUS_BASE_URL must be an http\(s\) URL/);
});

// The proxied bases are dereferenced via new URL(path, base); a query/fragment on the
// base makes the appended path's leading "/" land inside the query and every request
// then throws buildUrl's base-path escape error. Reject at boot.
test('a proxied base URL with a query string is rejected at boot', () => {
  const res = boot({ PROMETHEUS_BASE_URL: 'http://prometheus.monitoring:9090/?x=1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[FATAL\] PROMETHEUS_BASE_URL must not contain a query string or fragment/);
});

// Whitespace-only TEMPO_SEARCH_PATH is truthy, so it skips the `|| '/api/search'`
// default and trims to '', which would resolve to the Tempo base ROOT instead of the
// search endpoint. It must fall back to the default like an unset value.
test('a whitespace-only TEMPO_SEARCH_PATH falls back to the default, not the Tempo root', () => {
  const res = boot({ TEMPO_BASE_URL: 'http://tempo:3200', TEMPO_SEARCH_PATH: '   ' });
  assert.doesNotMatch(res.stderr, /\[FATAL\]/);
  assert.match(res.stdout, /TEMPO_SEARCH_PATH="\/api\/search"/);
});

// The link-only base URLs are the siblings of PROMETHEUS/TEMPO above and were the
// last three without a trim. The `^https?://` check is not anchored at the end, so a
// LEADING space fatals while a TRAILING one passes -- and the padded value then
// reaches the string concatenations that build every link.
['GRAFANA_BASE_URL', 'VAULT_BASE_URL', 'DEPLOYMENT_CONFIG_REPO_URL'].forEach(name => {
  test(`${name} without a scheme is rejected at boot`, () => {
    const res = boot({ [name]: 'example.com' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`\\[FATAL\\] ${name} must be an http\\(s\\) URL`));
  });

  test(`${name} tolerates surrounding whitespace`, () => {
    const res = boot({ [name]: '  https://example.com  ' });
    assert.doesNotMatch(res.stderr, /\[FATAL\]/);
    assert.match(res.stdout, /\[CONFIG\]/);
  });

  // The rejection message must echo the RAW value: reporting the trimmed one would
  // print back a string that looks perfectly valid.
  test(`${name} rejection reports the raw value, padding included`, () => {
    const res = boot({ [name]: ' example.com ' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /got: " example\.com "/);
  });
});
