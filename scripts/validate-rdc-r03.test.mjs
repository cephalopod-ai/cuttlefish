import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const validatorPath = fileURLToPath(new URL('./validate-rdc-r03.mjs', import.meta.url));
const sha = '0123456789abcdef0123456789abcdef01234567';

function runFixture({ workflow, compose, createWorkflowDir = true, createSecretScan = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-r03-'));

  try {
    if (createWorkflowDir) {
      const workflowDir = path.join(root, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      if (createSecretScan) {
        fs.writeFileSync(path.join(workflowDir, 'secret-scan.yml'), workflow);
      }
    }
    if (compose !== undefined) {
      fs.writeFileSync(path.join(root, 'docker-compose.yml'), compose);
    }

    try {
      const stdout = execFileSync(process.execPath, [validatorPath], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output: stdout };
    } catch (error) {
      return {
        status: error.status,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const compliantWorkflow = `
name: Secret scan
permissions:
  contents: read
jobs:
  scan:
    steps:
      - uses: actions/checkout@${sha} # v4.2.2
`;

const compliantCompose = `
services:
  app:
    image: registry.example.com:5000/team/app:1.2.3
`;

function assertFails(result, message) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /VALIDATION ERROR/, message);
}

test('compliant block-style fixture passes', () => {
  const result = runFixture({ workflow: compliantWorkflow, compose: compliantCompose });
  assert.equal(result.status, 0, result.output);
});

for (const [style, uses] of [
  ['block', '      - uses: actions/checkout@v4'],
  ['inline flow', '    steps: [{ uses: actions/checkout@v4 }]'],
  ['folded', '      - uses: >\n          actions/checkout@v4'],
]) {
  test(`unpinned uses in ${style} YAML fails`, () => {
    const workflow = `name: Invalid\npermissions: {}\njobs:\n  scan:\n${uses}\n`;
    assertFails(runFixture({ workflow, compose: compliantCompose }));
  });
}

for (const [description, compose] of [
  ['floating image in block YAML', 'services:\n  app:\n    image: team/app:latest'],
  ['untagged image in block YAML', 'services:\n  app:\n    image: team/app'],
  ['floating image in inline YAML', 'services: { app: { image: team/app:latest-edge } }'],
  ['untagged image in inline YAML', 'services: { app: { image: team/app } }'],
]) {
  test(`${description} fails`, () => {
    assertFails(runFixture({ workflow: compliantWorkflow, compose }));
  });
}

test('missing workflow directory fails', () => {
  assertFails(
    runFixture({
      workflow: compliantWorkflow,
      compose: compliantCompose,
      createWorkflowDir: false,
    })
  );
});

test('missing secret scan workflow fails', () => {
  assertFails(
    runFixture({
      workflow: compliantWorkflow,
      compose: compliantCompose,
      createSecretScan: false,
    })
  );
});

test('missing compose file fails', () => {
  assertFails(runFixture({ workflow: compliantWorkflow, compose: undefined }));
});
