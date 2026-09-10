'use strict';

// Regression tests for the trim on the link-only base URLs. These need their own
// test file because config is read once at module load: the env must be padded
// BEFORE src/server.js is required, and unit.test.js requires it with clean values.
//
// Trailing whitespace is the dangerous half. The boot-time `^https?://` check is not
// anchored at the end, so a LEADING space fatals loudly while a TRAILING one passes
// validation and travels on into the string concatenations that build every link.
process.env.VAULT_BASE_URL = 'https://vault.example.com ';
process.env.GRAFANA_BASE_URL = 'https://grafana.example.com ';
process.env.DEPLOYMENT_CONFIG_REPO_URL = 'https://github.com/GlueOps/deployment-configurations ';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVaultSecretUrl, collectAppSpecificValueFiles } = require('../src/server.js');

test('a padded VAULT_BASE_URL does not render a link containing a space', () => {
  const url = buildVaultSecretUrl('secret/foo/bar');
  assert.equal(url, 'https://vault.example.com/ui/vault/secrets/secret/show/foo/bar');
  assert.doesNotMatch(url, / /);
});

// The worst consequence of the missing trim: DEPLOYMENT_CONFIG_REPO_URL is compared
// against each Application's repoURL to scope config-repo reads (the confused-deputy
// guard). Padded, it matched nothing and silently dropped every config-derived Vault
// link -- no error, no warning, just a category quietly missing links.
test('a padded DEPLOYMENT_CONFIG_REPO_URL still matches an Application repoURL', () => {
  const appObj = {
    spec: {
      sources: [
        {
          ref: 'values',
          repoURL: 'https://github.com/GlueOps/deployment-configurations',
          targetRevision: 'main'
        },
        {
          repoURL: 'https://github.com/GlueOps/app',
          helm: { valueFiles: ['$values/apps/team-a/values.yaml'] }
        }
      ]
    }
  };

  assert.deepEqual(collectAppSpecificValueFiles(appObj), [{
    repoUrl: 'https://github.com/GlueOps/deployment-configurations',
    revision: 'main',
    path: 'apps/team-a/values.yaml'
  }]);
});

// Build an appObj with `n` distinct value files under the configured config repo.
function appWithValueFiles(n) {
  const valueFiles = [];
  for (let i = 0; i < n; i++) valueFiles.push(`$values/apps/team-a/v${i}/values.yaml`);
  return {
    metadata: { name: 'team-a' },
    spec: {
      sources: [
        { ref: 'values', repoURL: 'https://github.com/GlueOps/deployment-configurations', targetRevision: 'main' },
        { repoURL: 'https://github.com/GlueOps/app', helm: { valueFiles } }
      ]
    }
  };
}

// Capture console.warn for the duration of `fn` so the observability guarantee (never
// silently drop) can be asserted, not just the cap itself.
function captureWarn(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(' '));
  try {
    return { result: fn(), messages };
  } finally {
    console.warn = original;
  }
}

// An app can declare an unbounded number of value files; each is a token-authenticated
// GitHub fetch, so the collector caps the fan-out at MAX_CONFIG_VALUE_FILES (default 50)
// rather than letting one app burn the shared rate limit / hang the request.
test('collectAppSpecificValueFiles caps at MAX and WARNs, but not at the boundary', () => {
  // Exactly at the cap (50): no truncation, no warning.
  const atCap = captureWarn(() => collectAppSpecificValueFiles(appWithValueFiles(50)));
  assert.equal(atCap.result.length, 50);
  assert.deepEqual(atCap.messages, [], 'no warning when count == MAX');

  // One over (51): capped to 50, exactly one WARN naming the cap.
  const overCap = captureWarn(() => collectAppSpecificValueFiles(appWithValueFiles(51)));
  assert.equal(overCap.result.length, 50);
  assert.equal(overCap.messages.length, 1, 'the drop must be logged, never silent');
  assert.match(overCap.messages[0], /\[WARN\].*MAX_CONFIG_VALUE_FILES=50/);
  // The cap keeps the FIRST N distinct entries in declaration order.
  assert.equal(overCap.result[0].path, 'apps/team-a/v0/values.yaml');
  assert.equal(overCap.result[49].path, 'apps/team-a/v49/values.yaml');
});

// GitHub owner/repo are case-insensitive, so a repoURL differing only in case from
// DEPLOYMENT_CONFIG_REPO_URL is the same repo and must still be read (else all
// config-derived Vault links silently drop).
test('collectAppSpecificValueFiles matches the config repo case-insensitively', () => {
  const appObj = {
    spec: {
      sources: [
        { ref: 'values', repoURL: 'https://github.com/glueops/Deployment-Configurations.git', targetRevision: 'main' },
        { repoURL: 'https://github.com/GlueOps/app', helm: { valueFiles: ['$values/apps/team-a/values.yaml'] } }
      ]
    }
  };
  assert.deepEqual(collectAppSpecificValueFiles(appObj), [{
    repoUrl: 'https://github.com/glueops/Deployment-Configurations.git',
    revision: 'main',
    path: 'apps/team-a/values.yaml'
  }]);
});
