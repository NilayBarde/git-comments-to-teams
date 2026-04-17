import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_BACKENDS = ['local', 'github', 'gitlab'];
const BACKEND = detectBackend();
let commitQueue = Promise.resolve();

function detectBackend(env = process.env) {
  const explicit = env.PERSISTENCE_BACKEND;
  if (explicit) {
    if (!VALID_BACKENDS.includes(explicit)) {
      console.error(`Invalid PERSISTENCE_BACKEND "${explicit}". Must be one of: ${VALID_BACKENDS.join(', ')}`);
      process.exit(1);
    }
    return explicit;
  }
  if (env.GITLAB_TOKEN && env.GITLAB_PROJECT_ID) return 'gitlab';
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) return 'github';
  return 'local';
}

function loadFile(filePath) {
  const fullPath = path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeLocal(filePath, data) {
  try {
    const fullPath = path.join(__dirname, filePath);
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    console.error(`Failed to write local ${filePath}:`, err.message);
  }
}

function persistFile(filePath, data, commitMessage) {
  const pending = commitQueue.then(() => _persist(filePath, data, commitMessage));
  commitQueue = pending.catch(() => {});
  return pending;
}

async function _persist(filePath, data, commitMessage) {
  if (BACKEND === 'github') {
    await commitToGitHub(filePath, data, commitMessage);
  } else if (BACKEND === 'gitlab') {
    await commitToGitLab(filePath, data, commitMessage);
  }
  writeLocal(filePath, data);
}

// ── GitHub backend ──

async function commitToGitHub(filePath, data, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPO are not configured');

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  let sha;
  const getResponse = await fetch(apiUrl, { headers });
  if (getResponse.ok) {
    const result = await getResponse.json();
    sha = result.sha;
  }

  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64');
  const body = { message: commitMessage, content, ...(sha ? { sha } : {}) };

  const putResponse = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });

  if (!putResponse.ok) {
    const text = await putResponse.text();
    throw new Error(`GitHub API returned ${putResponse.status}: ${text}`);
  }
}

// ── GitLab backend ──

async function commitToGitLab(filePath, data, commitMessage) {
  const token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;
  if (!token || !projectId) throw new Error('GITLAB_TOKEN and GITLAB_PROJECT_ID are not configured');

  const baseUrl = process.env.GITLAB_URL || 'https://gitlab.com';
  const encodedPath = encodeURIComponent(filePath);
  const headers = {
    'PRIVATE-TOKEN': token,
    'Content-Type': 'application/json'
  };

  const getResponse = await fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/files/${encodedPath}?ref=main`, { headers });
  const method = getResponse.ok ? 'PUT' : 'POST';

  const body = {
    branch: 'main',
    content: JSON.stringify(data, null, 2) + '\n',
    commit_message: commitMessage
  };

  const writeResponse = await fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/files/${encodedPath}`, {
    method,
    headers,
    body: JSON.stringify(body)
  });

  if (!writeResponse.ok) {
    const text = await writeResponse.text();
    throw new Error(`GitLab API returned ${writeResponse.status}: ${text}`);
  }
}

console.log(`Persistence backend: ${BACKEND}`);

export { loadFile, persistFile, detectBackend, BACKEND };
