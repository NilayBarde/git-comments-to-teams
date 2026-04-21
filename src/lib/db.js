import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { loadFile, persistFile } from './persistence.js';

const TABLE_NAME = process.env.DYNAMODB_TABLE;
const USE_DYNAMO = !!TABLE_NAME;
const PIPELINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let docClient;
if (USE_DYNAMO) {
  const client = new DynamoDBClient({});
  docClient = DynamoDBDocumentClient.from(client);
}

// ── Local-mode state (only used when USE_DYNAMO is false) ──

let localPipelineState;
const PIPELINE_STATE_FILE = 'pipeline-state.json';

function getLocalPipelineState() {
  if (!localPipelineState) {
    localPipelineState = loadFile(PIPELINE_STATE_FILE) || {};
  }
  return localPipelineState;
}

function pruneAndSaveLocal() {
  const state = getLocalPipelineState();
  const now = Date.now();
  for (const key of Object.keys(state)) {
    if (now - state[key].timestamp > PIPELINE_TTL_MS) {
      delete state[key];
    }
  }
  persistFile(PIPELINE_STATE_FILE, state);
}

// ── Users ──

async function getUsers() {
  if (!USE_DYNAMO) {
    return loadFile('users.json') || (process.env.USERS_CONFIG ? JSON.parse(process.env.USERS_CONFIG) : []);
  }
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'sk-index',
    KeyConditionExpression: 'sk = :sk',
    ExpressionAttributeValues: { ':sk': 'USER' }
  }));
  return (result.Items || []).map(dynamoUserToApp);
}

async function putUser(user, allUsers) {
  if (!USE_DYNAMO) {
    await persistFile('users.json', allUsers, `user: update ${user.name}`);
    return;
  }
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { pk: `USER#${user.name}`, sk: 'USER', ...appUserToDynamo(user) }
  }));
}

async function deleteUser(name, allUsers) {
  if (!USE_DYNAMO) {
    await persistFile('users.json', allUsers, `unregister: remove ${name}`);
    return;
  }
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { pk: `USER#${name}`, sk: 'USER' }
  }));
}

function appUserToDynamo(user) {
  return {
    name: user.name,
    teamsWebhookUrl: user.teamsWebhookUrl,
    ...(user.github && { github: user.github }),
    ...(user.gitlab && { gitlab: user.gitlab }),
    ...(user.mentionAliases?.length && { mentionAliases: user.mentionAliases }),
    ...(user.notifications && { notifications: user.notifications })
  };
}

function dynamoUserToApp(item) {
  const user = {
    name: item.name,
    teamsWebhookUrl: item.teamsWebhookUrl
  };
  if (item.github) user.github = item.github;
  if (item.gitlab) user.gitlab = item.gitlab;
  if (item.mentionAliases) user.mentionAliases = item.mentionAliases;
  if (item.notifications) user.notifications = item.notifications;
  return user;
}

// ── Repos ──

async function getRepos() {
  if (!USE_DYNAMO) {
    return loadFile('repos.json') || [];
  }
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'sk-index',
    KeyConditionExpression: 'sk = :sk',
    ExpressionAttributeValues: { ':sk': 'REPO' }
  }));
  return (result.Items || []).map(item => item.repoKey);
}

async function putRepo(repoKey) {
  if (!USE_DYNAMO) {
    const allRepos = loadFile('repos.json') || [];
    if (!allRepos.includes(repoKey)) {
      allRepos.push(repoKey);
      allRepos.sort();
      await persistFile('repos.json', allRepos, `repos: add ${repoKey}`);
    }
    return;
  }
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { pk: `REPO#${repoKey}`, sk: 'REPO', repoKey }
  }));
}

// ── Pipeline State ──

async function getPipelineState(repoName, branch) {
  const key = `${repoName}:${branch}`;
  if (!USE_DYNAMO) {
    const state = getLocalPipelineState();
    return state[key] || null;
  }
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `PIPE#${key}`, sk: 'PIPE' }
  }));
  if (!result.Item) return null;
  return {
    status: result.Item.status,
    failedJobs: result.Item.failedJobs || [],
    timestamp: result.Item.timestamp
  };
}

async function setPipelineState(repoName, branch, state) {
  const key = `${repoName}:${branch}`;
  if (!USE_DYNAMO) {
    const localState = getLocalPipelineState();
    localState[key] = state;
    pruneAndSaveLocal();
    return;
  }
  const ttl = Math.floor((Date.now() + PIPELINE_TTL_MS) / 1000);
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: `PIPE#${key}`,
      sk: 'PIPE',
      status: state.status,
      failedJobs: state.failedJobs,
      timestamp: state.timestamp,
      ttl
    }
  }));
}

async function deletePipelineState(repoName, branch) {
  const key = `${repoName}:${branch}`;
  if (!USE_DYNAMO) {
    const localState = getLocalPipelineState();
    if (!localState[key]) return false;
    delete localState[key];
    pruneAndSaveLocal();
    return true;
  }
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `PIPE#${key}`, sk: 'PIPE' },
    ProjectionExpression: 'pk'
  }));
  if (!existing.Item) return false;
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { pk: `PIPE#${key}`, sk: 'PIPE' }
  }));
  return true;
}

console.log(`Storage backend: ${USE_DYNAMO ? 'DynamoDB' : 'local'}`);

export {
  getUsers,
  putUser,
  deleteUser,
  getRepos,
  putRepo,
  getPipelineState,
  setPipelineState,
  deletePipelineState,
  USE_DYNAMO
};
