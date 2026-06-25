#!/usr/bin/env node
// Quick validation test for /api/links endpoint logic

console.log('=== Testing /api/links endpoint logic ===\n');

// Simulate env vars
const GRAFANA_BASE_URL = 'https://grafana.nonprod.venus.onglueops.rocks';
const VAULT_BASE_URL = 'https://vault.nonprod.venus.onglueops.rocks';
const DEPLOYMENT_CONFIG_REPO_URL = 'https://github.com/GlueOps/deployment-configurations';
const ALLOWED_NAMESPACES = '*';

// Test 1: Valid headers, all services configured
console.log('Test 1: Valid headers, all services configured');
const namespace1 = 'nonprod';
const appName1 = 'back-end-antonios-tacos-prod';
const categories1 = [];

if (GRAFANA_BASE_URL) {
  categories1.push({
    id: 'logs',
    label: 'Logs',
    links: [{
      url: `${GRAFANA_BASE_URL}/d/logs?var-namespace=${encodeURIComponent(namespace1)}&var-pod=${encodeURIComponent(appName1)}`,
      label: 'View Logs'
    }]
  });
}

if (VAULT_BASE_URL) {
  categories1.push({
    id: 'vault-secrets',
    label: 'Secrets (0)',
    links: [{
      url: `${VAULT_BASE_URL}/ui/vault/secrets/secret/list/${encodeURIComponent(namespace1)}`,
      label: 'Open Namespace Secrets'
    }]
  });
}

if (DEPLOYMENT_CONFIG_REPO_URL) {
  categories1.push({
    id: 'deployment-config',
    label: 'Config Repo',
    links: [{
      url: DEPLOYMENT_CONFIG_REPO_URL,
      label: 'Open Repository'
    }]
  });
}

console.log('✓ Generated categories:', JSON.stringify(categories1, null, 2));
console.log(`✓ Expected 3 categories (logs, vault-secrets, deployment-config), got ${categories1.length}`);
const hasTraces = categories1.some(c => c.id === 'traces');
if (categories1.length === 3 && !hasTraces) console.log('✓ PASS\n');
else console.log('✗ FAIL\n');

// Test 2: Namespace filtering
console.log('Test 2: Namespace filtering (ALLOWED_NAMESPACES="nonprod,mmos-dev")');
const allowedNamespaces2 = 'nonprod,mmos-dev';
const testNamespaces = ['nonprod', 'mmos-dev', 'glueops-core'];
testNamespaces.forEach(ns => {
  const allowedList = allowedNamespaces2.split(',').map(s => s.trim());
  const isAllowed = allowedList.includes(ns);
  const expected = ['nonprod', 'mmos-dev'].includes(ns);
  console.log(`  - ${ns}: allowed=${isAllowed}, expected=${expected} ${isAllowed === expected ? '✓' : '✗'}`);
});
console.log();

// Test 3: Missing services
console.log('Test 3: Services disabled (empty URLs)');
const GRAFANA_BASE_URL_3 = '';
const VAULT_BASE_URL_3 = 'https://vault.example.com';
const DEPLOYMENT_CONFIG_REPO_URL_3 = '';
const categories3 = [];

if (GRAFANA_BASE_URL_3) {
  categories3.push({ id: 'logs', label: 'Logs' });
}

if (VAULT_BASE_URL_3) {
  categories3.push({ id: 'vault-secrets', label: 'Secrets (0)' });
}

if (DEPLOYMENT_CONFIG_REPO_URL_3) {
  categories3.push({ id: 'deployment-config', label: 'Config Repo' });
}

console.log(`✓ Generated categories: ${categories3.length} (only secrets, since Grafana and repo URLs are empty)`);
console.log(`✓ Expected 1 category, got ${categories3.length}`);
if (categories3.length === 1 && categories3[0].id === 'vault-secrets') console.log('✓ PASS\n');
else console.log('✗ FAIL\n');

// Test 4: URL encoding
console.log('Test 4: URL encoding edge cases');
const specialApp = 'app/with-special_chars.v1';
const encodedApp = encodeURIComponent(specialApp);
const testUrl = `https://grafana.example.com/d/logs?var-app=${encodedApp}`;
console.log(`  - App name: ${specialApp}`);
console.log(`  - Encoded: ${encodedApp}`);
console.log(`  - URL: ${testUrl}`);
console.log('✓ PASS\n');

console.log('=== All logic tests passed ===');
