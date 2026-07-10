import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

let failed = false;

function reportError(filePath, lineNum, message) {
  const location = lineNum ? `${filePath}:${lineNum}` : filePath;
  console.error(`[VALIDATION ERROR] ${location} - ${message}`);
  failed = true;
}

function nodeLine(node, lineCounter) {
  return node?.range ? lineCounter.linePos(node.range[0]).line : undefined;
}

function parseYamlFile(filePath) {
  const lineCounter = new LineCounter();
  const document = parseDocument(fs.readFileSync(filePath, 'utf8'), {
    keepSourceTokens: true,
    lineCounter,
  });

  for (const error of document.errors) {
    const line = error.linePos?.[0]?.line;
    reportError(filePath, line, `Invalid YAML: ${error.message}`);
  }

  return { document, lineCounter };
}

function visitMappings(node, visitor) {
  if (isMap(node)) {
    for (const pair of node.items) {
      visitor(pair);
      visitMappings(pair.value, visitor);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      visitMappings(item, visitor);
    }
  }
}

function isNamedKey(key, name) {
  return isScalar(key) && key.value === name;
}

function validateWorkflowFile(filePath) {
  const { document, lineCounter } = parseYamlFile(filePath);
  if (document.errors.length > 0) return;

  const root = document.contents;
  const hasTopLevelPermissions =
    isMap(root) && root.items.some((pair) => isNamedKey(pair.key, 'permissions'));

  if (!hasTopLevelPermissions) {
    reportError(filePath, undefined, "Missing explicit top-level 'permissions:' key.");
  }

  visitMappings(root, (pair) => {
    if (!isNamedKey(pair.key, 'uses')) return;

    const line = nodeLine(pair.key, lineCounter);
    if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
      reportError(filePath, line, "Invalid 'uses:' value. Expected a scalar action reference.");
      return;
    }

    const actionReference = pair.value.value.trim();
    const hasPinnedSha = /^[^@\s]+@[0-9a-fA-F]{40}$/.test(actionReference);
    const hasVersionComment = /^\s*v?\d+(?:\.\d+)*(?:\s|$)/.test(pair.value.comment ?? '');

    if (!hasPinnedSha || !hasVersionComment) {
      reportError(
        filePath,
        line,
        "Invalid 'uses:' format. Every action reference must use a 40-character hex SHA and have an adjacent version comment (for example, '# v4.2.0')."
      );
    }
  });
}

function validateImage(filePath, pair, lineCounter) {
  const line = nodeLine(pair.key, lineCounter);
  if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
    reportError(filePath, line, "Invalid 'image:' value. Expected a non-empty scalar image reference.");
    return;
  }

  const image = pair.value.value.trim();
  if (!image) {
    reportError(filePath, line, "Invalid 'image:' value. Expected a non-empty scalar image reference.");
    return;
  }

  const finalComponent = image.split('/').at(-1);
  const nameAndTag = finalComponent.split('@', 1)[0];
  const colonIndex = nameAndTag.lastIndexOf(':');

  if (colonIndex === -1 || colonIndex === nameAndTag.length - 1) {
    reportError(filePath, line, `Image "${image}" is untagged (must specify a tag).`);
    return;
  }

  const tag = nameAndTag.slice(colonIndex + 1).toLowerCase();
  if (tag.startsWith('latest')) {
    reportError(filePath, line, `Image "${image}" uses a floating latest tag.`);
  }
}

function validateComposeFile(filePath) {
  const { document, lineCounter } = parseYamlFile(filePath);
  if (document.errors.length > 0) return;

  visitMappings(document.contents, (pair) => {
    if (isNamedKey(pair.key, 'image')) validateImage(filePath, pair, lineCounter);
  });
}

const workflowDir = path.join('.github', 'workflows');
const secretScanPath = path.join(workflowDir, 'secret-scan.yml');

if (!fs.existsSync(workflowDir) || !fs.statSync(workflowDir).isDirectory()) {
  reportError(workflowDir, undefined, 'Required workflow directory does not exist.');
} else {
  if (!fs.existsSync(secretScanPath)) {
    reportError(secretScanPath, undefined, 'Missing required secret-scanning workflow file.');
  }

  for (const file of fs.readdirSync(workflowDir)) {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      validateWorkflowFile(path.join(workflowDir, file));
    }
  }
}

const composePath = 'docker-compose.yml';
if (!fs.existsSync(composePath)) {
  reportError(composePath, undefined, 'Missing required Docker Compose file.');
} else {
  validateComposeFile(composePath);
}

if (failed) {
  process.exit(1);
}

console.log('All RDC-R03 validations passed successfully!');
