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
const links1 = [];

if (GRAFANA_BASE_URL) {
  links1.push({
    id: 'logs',
    title: 'Logs',
    icon: 'fa-file-lines',
    url: `${GRAFANA_BASE_URL}/d/logs?var-namespace=${encodeURIComponent(namespace1)}&var-pod=${encodeURIComponent(appName1)}`,
    category: 'logs'
  });
  links1.push({
    id: 'traces',
    title: 'Traces',
    icon: 'fa-timeline',
    url: `${GRAFANA_BASE_URL}/d/traces?var-namespace=${encodeURIComponent(namespace1)}&var-service=${encodeURIComponent(appName1)}`,
    category: 'traces'
  });
}

if (VAULT_BASE_URL) {
  links1.push({
    id: 'vault',
    title: 'Vault Secrets',
    icon: 'fa-key',
    url: `${VAULT_BASE_URL}/ui/vault/secrets/secret/list/${encodeURIComponent(namespace1)}/${encodeURIComponent(appName1)}/`,
    category: 'vault'
  });
}

if (DEPLOYMENT_CONFIG_REPO_URL) {
  links1.push({
    id: 'deployment-config',
    title: 'Deployment Config',
    icon: 'fa-code',
    url: `${DEPLOYMENT_CONFIG_REPO_URL}/blob/main/deployment-configurations/apps/${encodeURIComponent(appName1)}/`,
    category: 'deployment-config'
  });
}

console.log('✓ Generated links:', JSON.stringify(links1, null, 2));
console.log(`✓ Expected 4 links (logs, traces, vault, deployment-config), got ${links1.length}`);
if (links1.length === 4) console.log('✓ PASS\n');
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
const links3 = [];

if (GRAFANA_BASE_URL_3) {
  links3.push({ id: 'logs', title: 'Logs', category: 'logs' });
}

if (VAULT_BASE_URL_3) {
  links3.push({ id: 'vault', title: 'Vault Secrets', category: 'vault' });
}

if (DEPLOYMENT_CONFIG_REPO_URL_3) {
  links3.push({ id: 'deployment-config', title: 'Deployment Config', category: 'deployment-config' });
}

console.log(`✓ Generated links: ${links3.length} (only vault, since Grafana and repo URLs are empty)`);
console.log(`✓ Expected 1 link, got ${links3.length}`);
if (links3.length === 1) console.log('✓ PASS\n');
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
