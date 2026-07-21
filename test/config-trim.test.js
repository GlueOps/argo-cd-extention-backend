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

// An app can declare an unbounded number of value files; each is a token-authenticated
// GitHub fetch, so the collector caps the fan-out at MAX_CONFIG_VALUE_FILES (default 50)
// rather than letting one app burn the shared rate limit / hang the request.
test('collectAppSpecificValueFiles caps the number of value files it returns', () => {
  const valueFiles = [];
  for (let i = 0; i < 120; i++) valueFiles.push(`$values/apps/team-a/v${i}/values.yaml`);
  const appObj = {
    metadata: { name: 'team-a' },
    spec: {
      sources: [
        { ref: 'values', repoURL: 'https://github.com/GlueOps/deployment-configurations', targetRevision: 'main' },
        { repoURL: 'https://github.com/GlueOps/app', helm: { valueFiles } }
      ]
    }
  };

  const result = collectAppSpecificValueFiles(appObj);
  assert.equal(result.length, 50);
  // The cap keeps the FIRST N distinct entries in declaration order.
  assert.equal(result[0].path, 'apps/team-a/v0/values.yaml');
  assert.equal(result[49].path, 'apps/team-a/v49/values.yaml');
});
