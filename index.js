import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import _ from 'lodash';
import { loadFile, persistFile } from './persistence.js';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITLAB_WEBHOOK_TOKEN = process.env.GITLAB_WEBHOOK_TOKEN;

const PIPELINE_STATE_FILE = 'pipeline-state.json';
const PIPELINE_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let pipelineState = loadFile(PIPELINE_STATE_FILE) || {};

let users = [];
try {
  users = loadFile('users.json') || (process.env.USERS_CONFIG ? JSON.parse(process.env.USERS_CONFIG) : null);
  if (!users) {
    console.error('Error: No user config found (users.json or USERS_CONFIG env var)');
    console.error('See README.md or visit /register to add users');
    process.exit(1);
  }
  console.log(`Loaded ${users.length} users`);
  if (!Array.isArray(users) || users.length === 0) {
    console.error('Error: User config must be a non-empty JSON array');
    process.exit(1);
  }
} catch (error) {
  console.error('Error loading user config:', error.message);
  process.exit(1);
}

// Validate each user config
users.forEach((user, index) => {
  if (!user.name) {
    console.error(`Error: User at index ${index} is missing required "name" field`);
    process.exit(1);
  }
  if (!user.teamsWebhookUrl) {
    console.error(`Error: User "${user.name}" is missing required "teamsWebhookUrl" field`);
    process.exit(1);
  }
});

let repos = [];
try {
  repos = loadFile('repos.json') || [];
  if (repos.length) console.log(`Loaded ${repos.length} repos`);
} catch (error) {
  console.error('Error loading repos.json:', error.message);
}

// Log config for debugging
console.log('Config loaded:', {
  usersCount: users.length,
  users: users.map(u => ({
    name: u.name,
    teamsWebhookUrl: u.teamsWebhookUrl ? 'SET' : 'NOT SET',
    github: u.github?.username,
    gitlab: `${u.gitlab?.username} (${u.gitlab?.userId})`
  })),
  repos
});

const app = express();

// Constants
const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
const GITLAB_TOKEN_HEADER = 'x-gitlab-token';
const COMMENT_CREATED_ACTION = 'created';
const NOTE_OBJECT_KIND = 'note';
const MERGE_REQUEST_OBJECT_KIND = 'merge_request';
const MERGE_REQUEST_TYPE = 'MergeRequest';
const MERGE_ACTION = 'merge';
const APPROVED_ACTION = 'approved';
const PR_CLOSED_ACTION = 'closed';
const PR_REVIEW_SUBMITTED_ACTION = 'submitted';
const PR_REVIEW_APPROVED_STATE = 'approved';
const PR_REVIEW_CHANGES_REQUESTED_STATE = 'changes_requested';
const REVIEW_REQUESTED_ACTION = 'review_requested';
const PIPELINE_OBJECT_KIND = 'pipeline';
const PIPELINE_FAILED_STATUS = 'failed';
const PIPELINE_SUCCESS_STATUS = 'success';

// Bot classification patterns (sonar checked first, then project bots, then always-ignored)
const SONAR_BOT_PATTERN = /^DTCI\.DL-Technology\.PE\.Infra\.CD$/i;
const PROJECT_BOT_PATTERN = /^project_\d+_bot_/i;
const ALWAYS_IGNORED_BOT_PATTERNS = [
  /^group_\d+_bot_/i,
  /\[bot\]$/i
];

const NOTIFICATION_DEFAULTS = {
  comments: true, mentions: true, approvals: true,
  merges: true, pipelineFailures: true, pipelineRecoveries: true,
  reviewRequests: true, codeownerReviewRequests: true,
  sonarComments: false, aiReviewComments: false,
  selfComments: false, selfMerges: false,
  selfReviewRequests: false
};

const DISABLED_BY_PREFS = 'disabled by preferences';

function sanitizeNotifications(raw) {
  if (!raw || typeof raw !== 'object') return;
  const sanitized = {};
  for (const key of Object.keys(NOTIFICATION_DEFAULTS)) {
    if (key in raw) {
      sanitized[key] = raw[key] === true;
    }
  }
  return sanitized;
}

function sanitizeUsername(str) {
  if (!str) return str;
  return str.trim().replace(/^@/, '');
}

function looksLikeOwnServerUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('onrender.com') || host === 'localhost';
  } catch {
    return false;
  }
}

// Parse JSON body
app.use(express.json());

/**
 * Verify GitHub webhook signature
 */
function verifyGitHubSignature(payload, signature) {
  const secret = GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;

  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  const sigBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

/**
 * Verify GitLab webhook token
 */
function verifyGitLabToken(token) {
  const configuredToken = GITLAB_WEBHOOK_TOKEN;
  if (!configuredToken) return true; // Skip verification if no token configured
  return token === configuredToken;
}

/**
 * Find the user whose PR/MR this is based on the author
 * @returns {Object|undefined} The user object if found, undefined otherwise
 */
function findPROwner(source, prAuthor) {
  const prAuthorStr = String(prAuthor).toLowerCase();
  
  return users.find(user => {
    if (source === 'github') {
      const githubUsername = _.get(user, 'github.username', '').toLowerCase();
      return prAuthorStr === githubUsername;
    }
    if (source === 'gitlab') {
      const gitlabUserId = String(_.get(user, 'gitlab.userId', ''));
      return prAuthorStr === gitlabUserId;
    }
    return false;
  });
}

function findUserByUsername(source, username) {
  const usernameLower = String(username).toLowerCase();
  return users.find(user => {
    const configuredName = source === 'github'
      ? _.get(user, 'github.username', '')
      : _.get(user, 'gitlab.username', '');
    return configuredName.toLowerCase() === usernameLower;
  });
}

/**
 * Check if a user authored this comment (to avoid self-notifications)
 */
function isCommentAuthor(user, source, commentAuthor) {
  const commentAuthorLower = String(commentAuthor).toLowerCase();
  
  if (source === 'github') {
    const githubUsername = _.get(user, 'github.username', '').toLowerCase();
    return commentAuthorLower === githubUsername;
  }
  if (source === 'gitlab') {
    const gitlabUsername = _.get(user, 'gitlab.username', '').toLowerCase();
    return commentAuthorLower === gitlabUsername;
  }
  return false;
}

function classifyBotComment(username) {
  if (!username) return null;
  if (SONAR_BOT_PATTERN.test(username)) return 'sonar';
  if (PROJECT_BOT_PATTERN.test(username)) return 'projectBot';
  if (ALWAYS_IGNORED_BOT_PATTERNS.some(p => p.test(username))) return 'bot';
  return null;
}

function isCodeownerBot(username) {
  if (!username) return false;
  return /^group_\d+_bot_/i.test(username) || /^project_\d+_bot_/i.test(username);
}

function humanizeRequester(username) {
  if (!username) return 'Unknown';
  if (isCodeownerBot(username)) return 'CODEOWNERS';
  if (/\[bot\]$/i.test(username)) return username.replace(/\[bot\]$/i, ' (bot)');
  return username;
}

function userWantsNotification(user, type) {
  const defaultVal = _.get(NOTIFICATION_DEFAULTS, type, true);
  return _.get(user, `notifications.${type}`, defaultVal);
}

/**
 * Find all users who are mentioned in a comment
 * @returns {Array<{user: Object, mentionedAs: string}>} Array of user/mention pairs
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMentionedUsers(commentBody, source) {
  if (!commentBody) return [];
  
  const mentionedUsers = [];
  
  users.forEach(user => {
    const username = source === 'github' 
      ? _.get(user, 'github.username', '')
      : _.get(user, 'gitlab.username', '');
    
    const aliases = _.get(user, 'mentionAliases', []);
    const allNames = [username, ...aliases].filter(Boolean);
    
    const mentioned = allNames.find(name => {
      const pattern = new RegExp(`@${escapeRegExp(name)}\\b`, 'i');
      return pattern.test(commentBody);
    });
    
    if (mentioned) {
      mentionedUsers.push({ user, mentionedAs: mentioned });
    }
  });
  
  return mentionedUsers;
}

/**
 * Parse GitLab MR merge event webhook payload
 */
function parseGitLabMergeEvent(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== MERGE_REQUEST_OBJECT_KIND) return;

  const action = _.get(body, 'object_attributes.action');
  if (action !== MERGE_ACTION) return;

  const mergeRequest = _.get(body, 'object_attributes');
  if (!mergeRequest) return;

  const prAuthor = _.get(mergeRequest, 'author_id');
  const prTitle = _.get(mergeRequest, 'title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const mergedBy = _.get(body, 'user.username', '');
  const repoName = _.get(body, 'project.path_with_namespace', '');
  const sourceBranch = _.get(mergeRequest, 'source_branch', '');

  return {
    type: 'merge',
    source: 'gitlab',
    prAuthor,
    prTitle,
    prUrl,
    mergedBy,
    repoName,
    sourceBranch
  };
}

/**
 * Parse GitHub PR merge event webhook payload
 */
function parseGitHubMergeEvent(body) {
  const action = _.get(body, 'action');
  if (action !== PR_CLOSED_ACTION) return;

  const pullRequest = _.get(body, 'pull_request');
  if (!pullRequest) return;

  // Check if it was actually merged (not just closed)
  const merged = _.get(pullRequest, 'merged', false);
  if (!merged) return;

  const prAuthor = _.get(pullRequest, 'user.login', '');
  const prTitle = _.get(pullRequest, 'title', '');
  const prUrl = _.get(pullRequest, 'html_url', '');
  const mergedBy = _.get(pullRequest, 'merged_by.login', '') || _.get(body, 'sender.login', '');
  const repoName = _.get(body, 'repository.full_name', '');
  const sourceBranch = _.get(pullRequest, 'head.ref', '');

  return {
    type: 'merge',
    source: 'github',
    prAuthor,
    prTitle,
    prUrl,
    mergedBy,
    repoName,
    sourceBranch
  };
}

/**
 * Parse GitLab MR approval event webhook payload
 */
function parseGitLabApprovalEvent(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== MERGE_REQUEST_OBJECT_KIND) return;

  const action = _.get(body, 'object_attributes.action');
  if (action !== APPROVED_ACTION) return;

  const mergeRequest = _.get(body, 'object_attributes');
  if (!mergeRequest) return;

  const prAuthor = _.get(mergeRequest, 'author_id');
  const prTitle = _.get(mergeRequest, 'title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const approvedBy = _.get(body, 'user.username', '');
  const repoName = _.get(body, 'project.path_with_namespace', '');

  return {
    type: 'approval',
    source: 'gitlab',
    state: 'approved',
    prAuthor,
    prTitle,
    prUrl,
    reviewedBy: approvedBy,
    repoName
  };
}

/**
 * Parse GitHub review-requested event
 */
function parseGitHubReviewRequestedEvent(body) {
  const action = _.get(body, 'action');
  if (action !== REVIEW_REQUESTED_ACTION) return;

  const pullRequest = _.get(body, 'pull_request');
  const reviewer = _.get(body, 'requested_reviewer');
  if (!pullRequest || !reviewer) return;

  return {
    type: 'review_requested',
    source: 'github',
    requestedBy: _.get(body, 'sender.login', ''),
    reviewers: [_.get(reviewer, 'login', '')],
    prAuthor: _.get(pullRequest, 'user.login', ''),
    prTitle: _.get(pullRequest, 'title', ''),
    prUrl: _.get(pullRequest, 'html_url', ''),
    repoName: _.get(body, 'repository.full_name', '')
  };
}

/**
 * Parse GitLab reviewer-assigned event (MR update with changed reviewers)
 */
function parseGitLabReviewRequestedEvent(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== MERGE_REQUEST_OBJECT_KIND) return;

  const action = _.get(body, 'object_attributes.action');
  if (action !== 'update') return;

  const reviewerChanges = _.get(body, 'changes.reviewers');
  if (!reviewerChanges) return;

  const previous = (reviewerChanges.previous || []).map(r => r.username);
  const current = (reviewerChanges.current || []).map(r => r.username);
  const newReviewers = current.filter(u => !previous.includes(u));
  if (newReviewers.length === 0) return;

  const mergeRequest = _.get(body, 'object_attributes');

  return {
    type: 'review_requested',
    source: 'gitlab',
    requestedBy: _.get(body, 'user.username', ''),
    reviewers: newReviewers,
    prAuthor: _.get(mergeRequest, 'author_id'),
    prTitle: _.get(mergeRequest, 'title', ''),
    prUrl: _.get(mergeRequest, 'url', ''),
    repoName: _.get(body, 'project.path_with_namespace', '')
  };
}

/**
 * Parse GitLab pipeline event webhook payload
 */
function parseGitLabPipelineEvent(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== PIPELINE_OBJECT_KIND) return;

  const status = _.get(body, 'object_attributes.status');
  const pipelineSource = _.get(body, 'object_attributes.source', 'unknown');
  const ref = _.get(body, 'object_attributes.ref', '');
  console.log(`Pipeline event: status=${status}, source=${pipelineSource}, ref=${ref}`);

  const isFailed = status === PIPELINE_FAILED_STATUS;
  const isSuccess = status === PIPELINE_SUCCESS_STATUS;
  if (!isFailed && !isSuccess) {
    console.log(`Ignoring pipeline with status: ${status}`);
    return;
  }

  const mergeRequest = _.get(body, 'merge_request');
  const prAuthor = _.get(mergeRequest, 'author_id') || _.get(body, 'user.id');

  if (!prAuthor) {
    console.log('Ignoring pipeline - could not determine author from merge_request or user');
    return;
  }

  const prTitle = _.get(mergeRequest, 'title', '') || _.get(body, 'commit.title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const branch = ref;
  const pipelineId = _.get(body, 'object_attributes.id');
  const pipelineUrl = `${_.get(body, 'project.web_url', '')}/pipelines/${pipelineId}`;
  const repoName = _.get(body, 'project.path_with_namespace', '');

  const result = {
    type: isFailed ? 'pipeline_failed' : 'pipeline_success',
    source: 'gitlab',
    prAuthor,
    prTitle,
    prUrl,
    branch,
    pipelineUrl,
    repoName
  };

  if (isFailed) {
    const builds = _.get(body, 'builds', []);
    result.failedJobs = builds
      .filter(build => _.get(build, 'status') === PIPELINE_FAILED_STATUS)
      .map(build => `${_.get(build, 'stage', '')}:${_.get(build, 'name', '')}`);
  }

  return result;
}

function pipelineStateKey(repoName, branch) {
  return `${repoName}:${branch}`;
}

function prunePipelineState() {
  const now = Date.now();
  for (const key of Object.keys(pipelineState)) {
    if (now - pipelineState[key].timestamp > PIPELINE_STATE_TTL_MS) {
      delete pipelineState[key];
    }
  }
}

function savePipelineState() {
  prunePipelineState();
  persistFile(PIPELINE_STATE_FILE, pipelineState);
}

function checkPipelineDedup(pipelineEvent) {
  const { type, repoName, branch, failedJobs } = pipelineEvent;
  const key = pipelineStateKey(repoName, branch);
  const prev = pipelineState[key];
  const isFailed = type === 'pipeline_failed';

  if (isFailed) {
    const sortedJobs = (failedJobs || []).slice().sort();
    const prevJobs = prev?.failedJobs || [];
    const isDuplicate = prev?.status === 'failed' &&
      sortedJobs.length === prevJobs.length &&
      sortedJobs.every((job, i) => job === prevJobs[i]);

    pipelineState[key] = { status: 'failed', failedJobs: sortedJobs, timestamp: Date.now() };
    savePipelineState();

    if (isDuplicate) return 'suppress';
    return 'notify_failure';
  }

  // Pipeline succeeded
  const wasFailure = prev?.status === 'failed';
  delete pipelineState[key];
  savePipelineState();

  if (wasFailure) return 'notify_recovery';
  return 'suppress';
}

/**
 * Parse GitHub PR review event webhook payload (approvals and changes requested)
 */
function parseGitHubReviewEvent(body) {
  const action = _.get(body, 'action');
  if (action !== PR_REVIEW_SUBMITTED_ACTION) return;

  const review = _.get(body, 'review');
  const pullRequest = _.get(body, 'pull_request');
  if (!review || !pullRequest) return;

  const state = _.get(review, 'state', '').toLowerCase();
  
  // Only handle approved and changes_requested states
  if (state !== PR_REVIEW_APPROVED_STATE && state !== PR_REVIEW_CHANGES_REQUESTED_STATE) return;

  const prAuthor = _.get(pullRequest, 'user.login', '');
  const prTitle = _.get(pullRequest, 'title', '');
  const prUrl = _.get(pullRequest, 'html_url', '');
  const reviewedBy = _.get(review, 'user.login', '');
  const repoName = _.get(body, 'repository.full_name', '');
  const reviewBody = _.get(review, 'body', '');

  return {
    type: 'approval',
    source: 'github',
    state, // 'approved' or 'changes_requested'
    prAuthor,
    prTitle,
    prUrl,
    reviewedBy,
    repoName,
    reviewBody
  };
}

/**
 * Parse GitHub PR comment webhook payload
 */
function parseGitHubPayload(body) {
  const action = _.get(body, 'action');
  if (action !== COMMENT_CREATED_ACTION) return;

  const issueComment = _.get(body, 'comment');
  const issue = _.get(body, 'issue');
  if (!issue || !issueComment) return;

  const isPR = _.has(issue, 'pull_request');
  if (!isPR) return;

  const prAuthor = _.get(issue, 'user.login', '');
  const prTitle = _.get(issue, 'title', '');
  const prUrl = _.get(issue, 'pull_request.html_url', '') || _.get(issue, 'html_url', '');
  const commentAuthor = _.get(issueComment, 'user.login', '');
  const commentBody = _.get(issueComment, 'body', '');
  const commentUrl = _.get(issueComment, 'html_url', '');
  const repoName = _.get(body, 'repository.full_name', '');

  return {
    source: 'github',
    prAuthor,
    prTitle,
    prUrl,
    commentAuthor,
    commentBody,
    commentUrl,
    repoName
  };
}

/**
 * Parse GitHub PR review comment webhook payload
 */
function parseGitHubReviewPayload(body) {
  const action = _.get(body, 'action');
  if (action !== COMMENT_CREATED_ACTION) return;

  const comment = _.get(body, 'comment');
  const pullRequest = _.get(body, 'pull_request');
  
  if (!pullRequest || !comment) return;

  const prAuthor = _.get(pullRequest, 'user.login', '');
  const prTitle = _.get(pullRequest, 'title', '');
  const prUrl = _.get(pullRequest, 'html_url', '');
  const commentAuthor = _.get(comment, 'user.login', '');
  const commentBody = _.get(comment, 'body', '');
  const commentUrl = _.get(comment, 'html_url', '');
  const repoName = _.get(body, 'repository.full_name', '');
  const filePath = _.get(comment, 'path', '');

  return {
    source: 'github',
    prAuthor,
    prTitle,
    prUrl,
    commentAuthor,
    commentBody,
    commentUrl,
    repoName,
    filePath
  };
}

/**
 * Parse GitLab MR note webhook payload
 */
function parseGitLabPayload(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== NOTE_OBJECT_KIND) return;

  const noteableType = _.get(body, 'object_attributes.noteable_type');
  if (noteableType !== MERGE_REQUEST_TYPE) return;

  // Only notify on new comments, not edits/updates (e.g. bots updating their comment on each push)
  const noteAction = _.get(body, 'object_attributes.action');
  if (noteAction && noteAction !== 'create') {
    console.log(`Ignoring note event with action: ${noteAction}`);
    return;
  }

  const mergeRequest = _.get(body, 'merge_request');
  if (!mergeRequest) return;

  const prAuthor = _.get(mergeRequest, 'author_id');
  const prAuthorUsername = _.get(body, 'user.username', ''); // Commenter, need to get MR author differently
  const prTitle = _.get(mergeRequest, 'title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const commentAuthor = _.get(body, 'user.username', '');
  const commentBody = _.get(body, 'object_attributes.note', '');
  const commentUrl = _.get(body, 'object_attributes.url', '');
  const repoName = _.get(body, 'project.path_with_namespace', '');

  // For GitLab, we need to check against the author_id since the webhook doesn't include author username
  return {
    source: 'gitlab',
    prAuthor: prAuthor, // This is the user ID
    prTitle,
    prUrl,
    commentAuthor,
    commentBody,
    commentUrl,
    repoName
  };
}

const EDIT_SETTINGS_URL = 'https://git-comments-to-teams.onrender.com/edit';

function appendSettingsLink(card) {
  const content = card.attachments[0].content;
  const actions = content.actions || [];
  actions.push({
    type: 'Action.OpenUrl',
    title: 'Notifications',
    url: EDIT_SETTINGS_URL
  });
  content.actions = actions;
  return card;
}

/**
 * Create Teams Adaptive Card for the notification
 */
function createAdaptiveCard(data) {
  const { source, prTitle, prUrl, commentAuthor, commentBody, commentUrl, repoName, filePath } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';
  
  // Truncate comment body if too long
  const truncatedBody = commentBody.length > 500 
    ? commentBody.substring(0, 500) + '...' 
    : commentBody;

  // Create dynamic title based on whether it's a code review comment or general comment
  const title = filePath 
    ? `💬 Code Review Comment from ${commentAuthor}` 
    : `💬 ${commentAuthor} commented on your ${prLabel}`;

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'Bolder',
              size: 'Medium',
              color: 'Accent'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Source:', value: sourceLabel },
                { title: 'Repository:', value: repoName },
                { title: `${prLabel}:`, value: prTitle },
                { title: 'Comment by:', value: commentAuthor }
              ]
            }
          ]
        }
      }
    ]
  };

  // Add file path if present (for review comments)
  if (filePath) {
    card.attachments[0].content.body[1].facts.push({
      title: 'File:',
      value: filePath
    });
  }

  // Add comment body
  card.attachments[0].content.body.push({
    type: 'TextBlock',
    text: truncatedBody,
    wrap: true,
    separator: true
  });

  // Add action buttons
  card.attachments[0].content.actions = [
    {
      type: 'Action.OpenUrl',
      title: 'View Comment',
      url: commentUrl
    },
    {
      type: 'Action.OpenUrl',
      title: `View ${prLabel}`,
      url: prUrl
    }
  ];

  return appendSettingsLink(card);
}

/**
 * Create Teams Adaptive Card for mention notifications
 */
function createMentionCard(data, mentionedAs) {
  const { source, prTitle, prUrl, commentAuthor, commentBody, commentUrl, repoName } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';
  
  // Truncate comment body if too long
  const truncatedBody = commentBody.length > 500 
    ? commentBody.substring(0, 500) + '...' 
    : commentBody;

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: `📢 ${commentAuthor} mentioned you (@${mentionedAs})`,
              weight: 'Bolder',
              size: 'Medium',
              color: 'Attention'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Source:', value: sourceLabel },
                { title: 'Repository:', value: repoName },
                { title: `${prLabel}:`, value: prTitle },
                { title: 'Mentioned by:', value: commentAuthor }
              ]
            },
            {
              type: 'TextBlock',
              text: truncatedBody,
              wrap: true,
              separator: true
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View Comment',
              url: commentUrl
            },
            {
              type: 'Action.OpenUrl',
              title: `View ${prLabel}`,
              url: prUrl
            }
          ]
        }
      }
    ]
  };

  return appendSettingsLink(card);
}

/**
 * Create Teams Adaptive Card for merge notifications
 */
function createMergeCard(data) {
  const { source, prTitle, prUrl, mergedBy, repoName } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: `🎉 ${mergedBy} merged your ${prLabel}`,
              weight: 'Bolder',
              size: 'Medium',
              color: 'Good'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Source:', value: sourceLabel },
                { title: 'Repository:', value: repoName },
                { title: `${prLabel}:`, value: prTitle },
                { title: 'Merged by:', value: mergedBy }
              ]
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: `View ${prLabel}`,
              url: prUrl
            }
          ]
        }
      }
    ]
  };

  return appendSettingsLink(card);
}

/**
 * Create Teams Adaptive Card for approval/review notifications
 */
function createApprovalCard(data) {
  const { source, state, prTitle, prUrl, reviewedBy, repoName, reviewBody } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';
  
  const isApproved = state === 'approved';
  const title = isApproved 
    ? `✅ ${reviewedBy} approved your ${prLabel}` 
    : `⚠️ ${reviewedBy} requested changes on your ${prLabel}`;
  const color = isApproved ? 'Good' : 'Warning';

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'Bolder',
              size: 'Medium',
              color: color
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Source:', value: sourceLabel },
                { title: 'Repository:', value: repoName },
                { title: `${prLabel}:`, value: prTitle },
                { title: 'Reviewed by:', value: reviewedBy }
              ]
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: `View ${prLabel}`,
              url: prUrl
            }
          ]
        }
      }
    ]
  };

  // Add review comment if present
  if (reviewBody) {
    const truncatedBody = reviewBody.length > 500 
      ? reviewBody.substring(0, 500) + '...' 
      : reviewBody;
    card.attachments[0].content.body.push({
      type: 'TextBlock',
      text: truncatedBody,
      wrap: true,
      separator: true
    });
  }

  return appendSettingsLink(card);
}

function createReviewRequestedCard(data) {
  const { source, prTitle, prUrl, requestedBy, repoName } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';
  const displayRequester = humanizeRequester(requestedBy);

  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: `👀 ${displayRequester} requested your review`,
            weight: 'Bolder',
            size: 'Medium',
            color: 'Accent'
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Source:', value: sourceLabel },
              { title: 'Repository:', value: repoName },
              { title: `${prLabel}:`, value: prTitle },
              { title: 'Requested by:', value: displayRequester }
            ]
          }
        ],
        actions: [
          {
            type: 'Action.OpenUrl',
            title: `View ${prLabel}`,
            url: prUrl
          }
        ]
      }
    }]
  };

  return appendSettingsLink(card);
}

/**
 * Create Teams Adaptive Card for pipeline failure notifications
 */
function createPipelineFailureCard(data) {
  const { prTitle, prUrl, branch, pipelineUrl, repoName, failedJobs } = data;

  const facts = [
    { title: 'Source:', value: 'GitLab' },
    { title: 'Repository:', value: repoName },
    { title: 'MR:', value: prTitle },
    { title: 'Branch:', value: branch }
  ];

  if (failedJobs.length > 0) {
    facts.push({ title: 'Failed jobs:', value: failedJobs.join(', ') });
  }

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: '🔴 Pipeline Failed on your MR',
              weight: 'Bolder',
              size: 'Medium',
              color: 'Attention'
            },
            {
              type: 'FactSet',
              facts
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View Pipeline',
              url: pipelineUrl
            },
            {
              type: 'Action.OpenUrl',
              title: 'View MR',
              url: prUrl
            }
          ]
        }
      }
    ]
  };

  return appendSettingsLink(card);
}

/**
 * Create Teams Adaptive Card for pipeline recovery notifications
 */
function createPipelineRecoveryCard(data) {
  const { prTitle, prUrl, branch, pipelineUrl, repoName } = data;

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: '🟢 Pipeline Fixed! Previously failing pipeline now passes',
              weight: 'Bolder',
              size: 'Medium',
              color: 'Good'
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Source:', value: 'GitLab' },
                { title: 'Repository:', value: repoName },
                { title: 'MR:', value: prTitle },
                { title: 'Branch:', value: branch }
              ]
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View Pipeline',
              url: pipelineUrl
            },
            {
              type: 'Action.OpenUrl',
              title: 'View MR',
              url: prUrl
            }
          ]
        }
      }
    ]
  };

  return appendSettingsLink(card);
}

/**
 * Send notification to Teams
 * @param {Object} card - The Adaptive Card to send
 * @param {string} webhookUrl - The Teams webhook URL to send to
 */
async function sendToTeams(card, webhookUrl) {
  if (!webhookUrl) {
    console.error('Teams webhook URL not provided');
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Failed to send to Teams:', response.status, text);
      return false;
    }

    console.log('Successfully sent notification to Teams');
    return true;
  } catch (error) {
    console.error('Error sending to Teams:', error.message);
    return false;
  }
}

/**
 * Process incoming webhook and send to Teams if applicable
 */
async function processWebhook(source, data, signature) {
  const results = [];
  const prLabel = source === 'github' ? 'PR' : 'MR';

  // First, check for merge events
  let mergeEvent;
  if (source === 'github') {
    mergeEvent = parseGitHubMergeEvent(data);
  } else if (source === 'gitlab') {
    mergeEvent = parseGitLabMergeEvent(data);
  }

  // Handle merge events
  if (mergeEvent) {
    const { prAuthor, repoName: mergeRepo, sourceBranch } = mergeEvent;
    if (mergeRepo && sourceBranch) {
      const stateKey = pipelineStateKey(mergeRepo, sourceBranch);
      if (pipelineState[stateKey]) {
        delete pipelineState[stateKey];
        savePipelineState();
        console.log(`Cleared pipeline state for merged branch ${mergeRepo}:${sourceBranch}`);
      }
    }
    const prOwner = findPROwner(source, prAuthor);
    
    if (prOwner) {
      const { mergedBy } = mergeEvent;
      const isSelfMerge = isCommentAuthor(prOwner, source, mergedBy);
      if (isSelfMerge && !userWantsNotification(prOwner, 'selfMerges')) {
        console.log(`Ignoring self-merge by ${mergedBy} on their own ${prLabel}`);
        return { processed: false, reason: 'self-merge' };
      }
      if (!userWantsNotification(prOwner, 'merges')) {
        console.log(`Skipping merge notification for ${prOwner.name} (disabled by preferences)`);
        return { processed: false, reason: DISABLED_BY_PREFS };
      }
      console.log(`Processing ${source} merge event for ${prOwner.name}'s "${mergeEvent.prTitle}"`);
      const card = createMergeCard(mergeEvent);
      const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
      return { processed: sent, type: 'merge', user: prOwner.name, data: mergeEvent };
    }
    
    console.log(`Ignoring merge event - ${prLabel} author not in configured users`);
    return { processed: false, reason: `${prLabel} author not configured` };
  }

  // Check for approval/review events
  let approvalEvent;
  if (source === 'github') {
    approvalEvent = parseGitHubReviewEvent(data);
  } else if (source === 'gitlab') {
    approvalEvent = parseGitLabApprovalEvent(data);
  }

  // Handle approval events
  if (approvalEvent) {
    const { prAuthor, state, reviewedBy } = approvalEvent;
    const prOwner = findPROwner(source, prAuthor);
    
    if (prOwner) {
      if (!userWantsNotification(prOwner, 'approvals')) {
        console.log(`Skipping approval notification for ${prOwner.name} (disabled by preferences)`);
        return { processed: false, reason: DISABLED_BY_PREFS };
      }
      const stateLabel = state === 'approved' ? 'approval' : 'changes requested';
      console.log(`Processing ${source} ${stateLabel} from ${reviewedBy} for ${prOwner.name}'s "${approvalEvent.prTitle}"`);
      const card = createApprovalCard(approvalEvent);
      const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
      return { processed: sent, type: 'approval', state, user: prOwner.name, data: approvalEvent };
    }
    
    console.log(`Ignoring approval event - ${prLabel} author not in configured users`);
    return { processed: false, reason: `${prLabel} author not configured` };
  }

  // Check for review-requested events
  let reviewRequestedEvent;
  if (source === 'github') {
    reviewRequestedEvent = parseGitHubReviewRequestedEvent(data);
  } else if (source === 'gitlab') {
    reviewRequestedEvent = parseGitLabReviewRequestedEvent(data);
  }

  if (reviewRequestedEvent) {
    const { requestedBy, reviewers } = reviewRequestedEvent;
    const isCodeowner = isCodeownerBot(requestedBy);
    const notifications = [];

    for (const reviewerUsername of reviewers) {
      const reviewer = findUserByUsername(source, reviewerUsername);
      if (!reviewer) continue;
      if (isCodeowner && !userWantsNotification(reviewer, 'codeownerReviewRequests')) {
        console.log(`Skipping CODEOWNERS review-request notification for ${reviewer.name} (disabled by preferences)`);
        continue;
      }
      const isSelfRequest = isCommentAuthor(reviewer, source, requestedBy);
      if (isSelfRequest && !userWantsNotification(reviewer, 'selfReviewRequests')) continue;
      if (!userWantsNotification(reviewer, 'reviewRequests')) {
        console.log(`Skipping review-request notification for ${reviewer.name} (disabled by preferences)`);
        continue;
      }

      console.log(`Processing ${source} review request from ${requestedBy} to ${reviewer.name} on "${reviewRequestedEvent.prTitle}"`);
      const card = createReviewRequestedCard(reviewRequestedEvent);
      const sent = await sendToTeams(card, reviewer.teamsWebhookUrl);
      notifications.push({ user: reviewer.name, sent });
    }

    if (notifications.length === 0) {
      console.log(`Ignoring review-requested event - no configured reviewers matched`);
      return { processed: false, reason: 'no configured reviewers matched' };
    }

    return { processed: true, type: 'review_requested', notifications };
  }

  // Check for pipeline events (GitLab only)
  if (source === 'gitlab') {
    const pipelineEvent = parseGitLabPipelineEvent(data);

    if (pipelineEvent) {
      const { prAuthor, type: pipelineType } = pipelineEvent;
      const prOwner = findPROwner(source, prAuthor);

      if (!prOwner) {
        console.log('Ignoring pipeline event - pipeline owner not in configured users');
        return { processed: false, reason: 'pipeline owner not configured' };
      }

      const dedupResult = checkPipelineDedup(pipelineEvent);

      if (dedupResult === 'suppress') {
        const label = pipelineType === 'pipeline_failed' ? 'failure (duplicate)' : 'success (no prior failure)';
        console.log(`Suppressing pipeline ${label} for ${pipelineEvent.repoName}:${pipelineEvent.branch}`);
        return { processed: false, reason: `pipeline ${label} suppressed` };
      }

      const isRecovery = dedupResult === 'notify_recovery';
      const prefKey = isRecovery ? 'pipelineRecoveries' : 'pipelineFailures';
      if (!userWantsNotification(prOwner, prefKey)) {
        const label = isRecovery ? 'recovery' : 'failure';
        console.log(`Skipping pipeline ${label} notification for ${prOwner.name} (disabled by preferences)`);
        return { processed: false, reason: DISABLED_BY_PREFS };
      }
      const label = isRecovery ? 'recovery' : 'failure';
      console.log(`Processing ${source} pipeline ${label} for ${prOwner.name}'s "${pipelineEvent.prTitle}"`);
      const card = isRecovery ? createPipelineRecoveryCard(pipelineEvent) : createPipelineFailureCard(pipelineEvent);
      const resultType = isRecovery ? 'pipeline_recovered' : pipelineType;
      const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
      return { processed: sent, type: resultType, user: prOwner.name, data: pipelineEvent };
    }
  }

  // Then, check for comment events
  let parsed;
  if (source === 'github') {
    // Try parsing as PR review comment first, then as issue comment
    parsed = parseGitHubReviewPayload(data) || parseGitHubPayload(data);
  } else if (source === 'gitlab') {
    parsed = parseGitLabPayload(data);
  }

  if (!parsed) {
    console.log(`Ignoring ${source} event - not a recognized ${prLabel} event`);
    return { processed: false, reason: `not a recognized ${prLabel} event` };
  }

  const { prAuthor, commentAuthor, commentBody } = parsed;

  const botType = classifyBotComment(commentAuthor);
  if (botType === 'bot') {
    console.log(`Ignoring comment from bot user: ${commentAuthor}`);
    return { processed: false, reason: 'comment from bot user' };
  }

  const botPrefKey = botType === 'sonar' ? 'sonarComments'
    : botType === 'projectBot' ? 'aiReviewComments'
    : null;

  const prOwner = findPROwner(source, prAuthor);
  const mentionedUsers = findMentionedUsers(commentBody, source);
  const notifiedUsers = new Set();

  if (prOwner) {
    const isSelfComment = isCommentAuthor(prOwner, source, commentAuthor);
    if (isSelfComment && !userWantsNotification(prOwner, 'selfComments')) {
      console.log(`Ignoring self-comment by ${commentAuthor} on their own ${prLabel}`);
    } else {
      const wantsComments = userWantsNotification(prOwner, 'comments');
      const wantsBotType = botPrefKey ? userWantsNotification(prOwner, botPrefKey) : true;

      if (wantsComments && wantsBotType) {
        console.log(`Processing ${source} comment from ${commentAuthor} on ${prOwner.name}'s "${parsed.prTitle}"`);
        const card = createAdaptiveCard(parsed);
        const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
        results.push({ type: 'comment', user: prOwner.name, sent });
        notifiedUsers.add(prOwner.name);
      } else {
        console.log(`Skipping comment notification for ${prOwner.name} (disabled by preferences)`);
      }
    }
  }

  for (const { user, mentionedAs } of mentionedUsers) {
    const isSelfMention = isCommentAuthor(user, source, commentAuthor);
    if (isSelfMention && !userWantsNotification(user, 'selfComments')) continue;
    if (notifiedUsers.has(user.name)) continue;

    const wantsMentions = userWantsNotification(user, 'mentions');
    const wantsBotType = botPrefKey ? userWantsNotification(user, botPrefKey) : true;

    if (!wantsMentions || !wantsBotType) {
      console.log(`Skipping mention notification for ${user.name} (disabled by preferences)`);
      continue;
    }
    
    console.log(`Processing ${source} mention for ${user.name} (@${mentionedAs}) from ${commentAuthor}`);
    const card = createMentionCard(parsed, mentionedAs);
    const sent = await sendToTeams(card, user.teamsWebhookUrl);
    results.push({ type: 'mention', user: user.name, mentionedAs, sent });
    notifiedUsers.add(user.name);
  }

  if (results.length === 0) {
    console.log(`Ignoring - ${prLabel} author and mentioned users not in configured users`);
    return { processed: false, reason: 'no configured users to notify' };
  }

  return { processed: true, notifications: results };
}

// ── Registration helpers ──

async function addRepoIfNew(repoKey) {
  if (repos.includes(repoKey)) return;
  repos.push(repoKey);
  repos.sort();
  try {
    await persistFile('repos.json', repos, `repos: add ${repoKey}`);
    console.log(`New repo discovered and saved: ${repoKey}`);
  } catch (err) {
    console.error(`Failed to persist repos.json for ${repoKey}:`, err.message);
  }
}

const TOGGLE_CSS = `
  .toggle { display: flex; align-items: center; gap: .5rem; font-weight: 400; font-size: .9rem; margin-bottom: .5rem; cursor: pointer; }
  .toggle input[type="checkbox"] { width: 1rem; height: 1rem; cursor: pointer; }`;

const NOTIF_CHECKBOXES_HTML = `
    <div class="field">
      <label>Notification Preferences</label>
      <div class="hint">Choose which events you want to be notified about</div>
      <label class="toggle"><input type="checkbox" id="notif-comments" checked> Comments on your PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-mentions" checked> @mentions in comments</label>
      <label class="toggle"><input type="checkbox" id="notif-approvals" checked> Approvals and change requests</label>
      <label class="toggle"><input type="checkbox" id="notif-merges" checked> PRs/MRs merged</label>
      <label class="toggle"><input type="checkbox" id="notif-pipelineFailures" checked> Pipeline failures</label>
      <label class="toggle"><input type="checkbox" id="notif-pipelineRecoveries" checked> Pipeline recovered (fixed after failure)</label>
      <label class="toggle"><input type="checkbox" id="notif-reviewRequests" checked> Review requests</label>
      <label class="toggle"><input type="checkbox" id="notif-codeownerReviewRequests" checked> CODEOWNERS auto-assigned review requests</label>
      <hr style="margin:.75rem 0;border:none;border-top:1px solid #e0e0e0">
      <div class="hint">Bot comments (off by default)</div>
      <label class="toggle"><input type="checkbox" id="notif-sonarComments"> SonarQube analysis comments</label>
      <label class="toggle"><input type="checkbox" id="notif-aiReviewComments"> AI review / project bot comments</label>
      <hr style="margin:.75rem 0;border:none;border-top:1px solid #e0e0e0">
      <div class="hint">Self-activity (off by default)</div>
      <label class="toggle"><input type="checkbox" id="notif-selfComments"> Your own comments on your PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-selfMerges"> When you merge your own PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-selfReviewRequests"> When you add yourself as a reviewer</label>
    </div>`;

const NOTIF_COLLECT_JS = `{
          comments: document.getElementById('notif-comments').checked,
          mentions: document.getElementById('notif-mentions').checked,
          approvals: document.getElementById('notif-approvals').checked,
          merges: document.getElementById('notif-merges').checked,
          pipelineFailures: document.getElementById('notif-pipelineFailures').checked,
          pipelineRecoveries: document.getElementById('notif-pipelineRecoveries').checked,
          reviewRequests: document.getElementById('notif-reviewRequests').checked,
          codeownerReviewRequests: document.getElementById('notif-codeownerReviewRequests').checked,
          sonarComments: document.getElementById('notif-sonarComments').checked,
          aiReviewComments: document.getElementById('notif-aiReviewComments').checked,
          selfComments: document.getElementById('notif-selfComments').checked,
          selfMerges: document.getElementById('notif-selfMerges').checked,
          selfReviewRequests: document.getElementById('notif-selfReviewRequests').checked
        }`;

function getRegistrationPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Sign Up</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 1.25rem; }
  .card h2 { font-size: 1.05rem; margin-bottom: .75rem; }
  details summary { cursor: pointer; font-weight: 600; font-size: .95rem; padding: .5rem 0; }
  details[open] summary { margin-bottom: .5rem; }
  .steps { padding-left: 1.25rem; }
  .steps li { margin-bottom: .5rem; line-height: 1.5; font-size: .9rem; color: #333; }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"], input[type="url"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #4f6ef7; box-shadow: 0 0 0 3px rgba(79,110,247,.12); }
  .field { margin-bottom: 1rem; }
  .field:last-child { margin-bottom: 0; }
  button { width: 100%; padding: .7rem; background: #4f6ef7; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #3b5de7; }
  button:disabled { background: #a0b0f0; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
  .optional-tag { font-weight: 400; color: #999; font-size: .8rem; }
  ${TOGGLE_CSS}
</style>
</head>
<body>
<div class="container">
  <h1>PR Comment Notifier</h1>
  <p class="subtitle">Sign up to get Teams notifications for comments, reviews, merges, and pipeline events on your MRs/PRs.</p>
  <div style="font-size:.85rem;margin-bottom:1rem"><a href="/edit" style="color:#4f6ef7;text-decoration:none">Edit settings</a> · <a href="/unregister" style="color:#4f6ef7;text-decoration:none">Unregister</a></div>

  <div class="card">
    <details>
      <summary>How to create your Teams Webhook URL</summary>
      <ol class="steps">
        <li>Open <strong>Microsoft Teams</strong></li>
        <li>Create a private Team &amp; Channel for your notifications (or use an existing one)</li>
        <li>Click <strong>Apps</strong> (left sidebar) → search <strong>Workflows</strong></li>
        <li>Click the <strong>Create</strong> tab</li>
        <li>Search for "<strong>Send webhook alerts to a channel</strong>" and select it</li>
        <li>Choose your Team and Channel, give it a name (e.g. "PR Notifications")</li>
        <li>After saving, click <strong>Copy webhook link</strong> — that's your webhook URL</li>
      </ol>
    </details>
  </div>

  <form id="regForm" class="card">
    <h2>Your Details</h2>

    <div class="field">
      <label for="teamsWebhookUrl">Teams Webhook URL</label>
      <div class="hint">The URL you copied from the Workflows step above</div>
      <input type="url" id="teamsWebhookUrl" name="teamsWebhookUrl" placeholder="https://..." required>
    </div>

    <div class="field">
      <label for="gitlabUsername">GitLab Username <span class="optional-tag">optional</span></label>
      <div class="hint">Go to <a href="https://gitlab.disney.com/-/user_settings/profile" target="_blank" style="color:#4f6ef7">your GitLab profile</a> — your username is shown under your name (e.g. @Nilay.Barde)</div>
      <input type="text" id="gitlabUsername" name="gitlabUsername" placeholder="e.g. Nilay.Barde">
    </div>

    <div class="field">
      <label for="gitlabUserId">GitLab User ID <span class="optional-tag">required if GitLab username is set</span></label>
      <details style="margin-bottom:.5rem"><summary style="font-size:.8rem;color:#4f6ef7;cursor:pointer;font-weight:400">How do I find my GitLab User ID?</summary><ol class="steps" style="margin-top:.5rem"><li>Go to <a href="https://gitlab.disney.com" target="_blank" style="color:#4f6ef7">gitlab.disney.com</a> (must be on VPN)</li><li>Open Developer Tools (Cmd+Option+I or F12)</li><li>Go to the <strong>Console</strong> tab</li><li>Type <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">gon.current_user_id</code> and press Enter</li><li>The number shown is your User ID</li></ol></details>
      <input type="text" id="gitlabUserId" name="gitlabUserId" placeholder="e.g. 10957" inputmode="numeric">
    </div>

    <div class="field">
      <label for="githubUsername">GitHub Username <span class="optional-tag">optional</span></label>
      <input type="text" id="githubUsername" name="githubUsername" placeholder="e.g. NilayBarde">
    </div>

    <div class="field">
      <label for="mentionAliases">Mention Aliases <span class="optional-tag">optional, comma-separated</span></label>
      <div class="hint">Team aliases you want to be notified for (without the @), e.g. espn-core-web</div>
      <input type="text" id="mentionAliases" name="mentionAliases" placeholder="e.g. espn-core-web, bet-squad">
    </div>

    ${NOTIF_CHECKBOXES_HTML}

    <button type="submit" id="submitBtn">Sign Up</button>
    <div id="msg"></div>
  </form>
</div>

<script>
document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = 'Registering…';
  msg.className = 'msg';
  msg.textContent = '';

  const webhookUrl = document.getElementById('teamsWebhookUrl').value.trim();
  const gitlabUser = document.getElementById('gitlabUsername').value.trim();
  const gitlabId = document.getElementById('gitlabUserId').value.trim();
  const githubUser = document.getElementById('githubUsername').value.trim();
  const strip = s => s.trim().replace(/^@/, '');
  const aliases = document.getElementById('mentionAliases').value
    .split(',').map(strip).filter(Boolean);

  try {
    let parsedOk = false;
    try {
      const host = new URL(webhookUrl).hostname;
      parsedOk = true;
      if (host.endsWith('onrender.com') || host === 'localhost') {
        throw new Error('That looks like this server\\x27s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate — see the instructions above.');
      }
    } catch (urlErr) {
      if (parsedOk) throw urlErr;
      throw new Error('Please enter a valid URL for the Teams webhook.');
    }

    if (!gitlabUser && !githubUser) {
      throw new Error('Please enter at least one username (GitLab or GitHub).');
    }
    if (gitlabUser && !gitlabId) {
      throw new Error('GitLab User ID is required when a GitLab username is provided.');
    }
    if (gitlabId && isNaN(Number(gitlabId))) {
      throw new Error('GitLab User ID must be a number (e.g. 12345).');
    }

    const res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamsWebhookUrl: webhookUrl,
        gitlabUsername: gitlabUser,
        gitlabUserId: gitlabId,
        githubUsername: githubUser,
        mentionAliases: aliases,
        notifications: ${NOTIF_COLLECT_JS}
      })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Done!';
    } else {
      throw new Error(data.error || 'Registration failed');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Sign Up';
  }
});
</script>
</body>
</html>`;
}

function getUnregisterPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Unsubscribe</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #e45; box-shadow: 0 0 0 3px rgba(228,68,85,.12); }
  .field { margin-bottom: 1rem; }
  button { width: 100%; padding: .7rem; background: #e44; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #c33; }
  button:disabled { background: #e9a; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
</style>
</head>
<body>
<div class="container">
  <h1>Unsubscribe</h1>
  <p class="subtitle">Remove yourself from PR Comment Notifier. You'll stop receiving Teams notifications.</p>
  <div style="font-size:.85rem;margin-bottom:1rem"><a href="/register" style="color:#4f6ef7;text-decoration:none">Register</a> · <a href="/edit" style="color:#4f6ef7;text-decoration:none">Edit settings</a></div>
  <form id="unregForm" class="card">
    <div class="field">
      <label for="gitlabUsername">Your GitLab Username</label>
      <div class="hint">The GitLab username you registered with (e.g. Nilay.Barde)</div>
      <input type="text" id="gitlabUsername" name="gitlabUsername" placeholder="e.g. Nilay.Barde" required>
    </div>
    <button type="submit" id="submitBtn">Unsubscribe</button>
    <div id="msg"></div>
  </form>
</div>
<script>
document.getElementById('unregForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = 'Removing…';
  msg.className = 'msg';
  msg.textContent = '';
  try {
    const res = await fetch('/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitlabUsername: document.getElementById('gitlabUsername').value.trim() })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Done';
    } else {
      throw new Error(data.error || 'Failed to unsubscribe');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Unsubscribe';
  }
});
</script>
</body>
</html>`;
}

function getEditPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Edit Settings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 1.25rem; }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"], input[type="url"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #4f6ef7; box-shadow: 0 0 0 3px rgba(79,110,247,.12); }
  input:read-only { background: #f5f5f5; color: #888; }
  .field { margin-bottom: 1rem; }
  button { width: 100%; padding: .7rem; background: #4f6ef7; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #3b5de7; }
  button:disabled { background: #a0b0f0; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
  .optional-tag { font-weight: 400; color: #999; font-size: .8rem; }
  .hidden { display: none; }
  .nav { font-size: .85rem; margin-bottom: 1rem; }
  .nav a { color: #4f6ef7; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  ${TOGGLE_CSS}
</style>
</head>
<body>
<div class="container">
  <h1>Edit Settings</h1>
  <p class="subtitle">Update your PR Comment Notifier configuration.</p>
  <div class="nav"><a href="/register">Register</a> · <a href="/unregister">Unregister</a></div>

  <div id="lookupCard" class="card">
    <div class="field">
      <label for="lookupUsername">Your GitLab Username</label>
      <input type="text" id="lookupUsername" placeholder="e.g. Nilay.Barde" required>
    </div>
    <button id="lookupBtn" onclick="lookupUser()">Look Up</button>
    <div id="lookupMsg"></div>
  </div>

  <form id="editForm" class="card hidden">
    <div class="field">
      <label>GitLab Username</label>
      <input type="text" id="gitlabUsername" readonly>
    </div>

    <div class="field">
      <label for="teamsWebhookUrl">Teams Webhook URL</label>
      <input type="url" id="teamsWebhookUrl" required>
    </div>

    <div class="field">
      <label for="githubUsername">GitHub Username <span class="optional-tag">optional</span></label>
      <input type="text" id="githubUsername" placeholder="e.g. NilayBarde">
    </div>

    <div class="field">
      <label for="mentionAliases">Mention Aliases <span class="optional-tag">optional, comma-separated</span></label>
      <div class="hint">Team aliases you want to be notified for (without the @), e.g. espn-core-web</div>
      <input type="text" id="mentionAliases" placeholder="e.g. espn-core-web, bet-squad">
    </div>

    ${NOTIF_CHECKBOXES_HTML}

    <button type="submit" id="saveBtn">Save Changes</button>
    <div id="editMsg"></div>
  </form>
</div>

<script>
async function lookupUser() {
  const btn = document.getElementById('lookupBtn');
  const msg = document.getElementById('lookupMsg');
  const username = document.getElementById('lookupUsername').value.trim();
  if (!username) return;
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  msg.className = 'msg';
  msg.textContent = '';
  try {
    const res = await fetch('/api/user/' + encodeURIComponent(username));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'User not found');
    document.getElementById('gitlabUsername').value = data.gitlab?.username || '';
    document.getElementById('teamsWebhookUrl').value = data.teamsWebhookUrl || '';
    document.getElementById('githubUsername').value = data.github?.username || '';
    document.getElementById('mentionAliases').value = (data.mentionAliases || []).join(', ');
    const notifs = data.notifications || {};
    document.getElementById('notif-comments').checked = notifs.comments !== false;
    document.getElementById('notif-mentions').checked = notifs.mentions !== false;
    document.getElementById('notif-approvals').checked = notifs.approvals !== false;
    document.getElementById('notif-merges').checked = notifs.merges !== false;
    document.getElementById('notif-pipelineFailures').checked = notifs.pipelineFailures !== false;
    document.getElementById('notif-pipelineRecoveries').checked = notifs.pipelineRecoveries !== false;
    document.getElementById('notif-reviewRequests').checked = notifs.reviewRequests !== false;
    document.getElementById('notif-codeownerReviewRequests').checked = notifs.codeownerReviewRequests !== false;
    document.getElementById('notif-sonarComments').checked = notifs.sonarComments === true;
    document.getElementById('notif-aiReviewComments').checked = notifs.aiReviewComments === true;
    document.getElementById('notif-selfComments').checked = notifs.selfComments === true;
    document.getElementById('notif-selfMerges').checked = notifs.selfMerges === true;
    document.getElementById('notif-selfReviewRequests').checked = notifs.selfReviewRequests === true;
    document.getElementById('lookupCard').classList.add('hidden');
    document.getElementById('editForm').classList.remove('hidden');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Look Up';
  }
}

document.getElementById('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
  const msg = document.getElementById('editMsg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msg.className = 'msg';
  msg.textContent = '';
  const webhookUrl = document.getElementById('teamsWebhookUrl').value.trim();
  const strip = s => s.trim().replace(/^@/, '');
  const aliases = document.getElementById('mentionAliases').value
    .split(',').map(strip).filter(Boolean);
  try {
    let parsedOk = false;
    try {
      const host = new URL(webhookUrl).hostname;
      parsedOk = true;
      if (host.endsWith('onrender.com') || host === 'localhost') {
        throw new Error('That looks like this server\\x27s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate.');
      }
    } catch (urlErr) {
      if (parsedOk) throw urlErr;
      throw new Error('Please enter a valid URL for the Teams webhook.');
    }

    const res = await fetch('/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gitlabUsername: document.getElementById('gitlabUsername').value.trim(),
        teamsWebhookUrl: webhookUrl,
        githubUsername: document.getElementById('githubUsername').value.trim(),
        mentionAliases: aliases,
        notifications: ${NOTIF_COLLECT_JS}
      })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Saved!';
    } else {
      throw new Error(data.error || 'Save failed');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
});
</script>
</body>
</html>`;
}

// ── Routes ──

app.get('/register', (req, res) => {
  res.send(getRegistrationPage());
});

app.post('/register', async (req, res) => {
  try {
    const { teamsWebhookUrl, gitlabUserId } = req.body;
    const mentionAliases = (req.body.mentionAliases || []).map(a => sanitizeUsername(a)).filter(Boolean);
    const gitlabUsername = sanitizeUsername(req.body.gitlabUsername);
    const githubUsername = sanitizeUsername(req.body.githubUsername);

    if (!teamsWebhookUrl) {
      return res.status(400).json({ error: 'Teams Webhook URL is required' });
    }

    if (looksLikeOwnServerUrl(teamsWebhookUrl)) {
      return res.status(400).json({ error: 'That looks like this server\'s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate — see the instructions above.' });
    }

    if (!gitlabUsername && !githubUsername) {
      return res.status(400).json({ error: 'At least one username (GitLab or GitHub) is required' });
    }

    if (gitlabUsername && !gitlabUserId) {
      return res.status(400).json({ error: 'GitLab User ID is required when GitLab username is provided' });
    }

    if (gitlabUserId && isNaN(Number(gitlabUserId))) {
      return res.status(400).json({ error: 'GitLab User ID must be a number' });
    }

    if (gitlabUsername) {
      const isDuplicate = users.some(u => _.get(u, 'gitlab.username', '').toLowerCase() === gitlabUsername.toLowerCase().trim());
      if (isDuplicate) {
        return res.status(409).json({ error: `GitLab user "${gitlabUsername}" is already registered` });
      }
    }

    const name = gitlabUsername
      ? gitlabUsername.toLowerCase()
      : githubUsername.toLowerCase();

    // Build user object
    const newUser = { name, teamsWebhookUrl };

    if (gitlabUsername) {
      newUser.gitlab = { username: gitlabUsername, userId: Number(gitlabUserId) };
    }

    if (githubUsername) {
      newUser.github = { username: githubUsername };
    }

    if (mentionAliases && mentionAliases.length > 0) {
      newUser.mentionAliases = mentionAliases;
    }

    newUser.notifications = sanitizeNotifications(req.body.notifications) || { ...NOTIFICATION_DEFAULTS };

    // Validate webhook by sending a test notification
    const testCard = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{
            type: 'TextBlock',
            text: '✅ PR Comment Notifier is connected!',
            weight: 'Bolder',
            size: 'Medium',
            color: 'Good'
          }, {
            type: 'TextBlock',
            text: `Hi ${name}! You're all set. You'll start receiving Teams alerts for comments, reviews, merges, and pipeline events.`,
            wrap: true
          }]
        }
      }]
    };

    const webhookValid = await sendToTeams(testCard, teamsWebhookUrl);
    if (!webhookValid) {
      return res.status(400).json({ error: 'Could not send to that Teams webhook URL. Please check it and try again.' });
    }

    // Add to in-memory list (works immediately, no restart needed)
    const updatedUsers = [...users, newUser];
    users.push(newUser);

    try {
      await persistFile('users.json', updatedUsers, `register: add ${name}`);
    } catch (err) {
      console.error('Failed to persist users.json:', err.message);
      return res.status(500).json({ error: 'Registered locally but failed to save permanently. Ask an admin to check the server logs.' });
    }

    console.log(`New user registered: ${name}`);
    res.json({ message: `Welcome, ${name}! You're all set. A test notification was sent to your Teams channel. The server will redeploy in about a minute to make it permanent.` });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/unregister', (req, res) => {
  res.send(getUnregisterPage());
});

app.post('/unregister', async (req, res) => {
  try {
    const gitlabUsername = sanitizeUsername(req.body.gitlabUsername);
    if (!gitlabUsername) {
      return res.status(400).json({ error: 'GitLab username is required' });
    }

    const usernameLower = gitlabUsername.toLowerCase().trim();
    const userIndex = users.findIndex(u => _.get(u, 'gitlab.username', '').toLowerCase() === usernameLower);
    if (userIndex === -1) {
      return res.status(404).json({ error: `No user found with GitLab username "${gitlabUsername}"` });
    }

    const removedUser = users[userIndex];
    const updatedUsers = users.filter((_, i) => i !== userIndex);

    try {
      await persistFile('users.json', updatedUsers, `unregister: remove ${removedUser.name}`);
    } catch (err) {
      console.error('Failed to persist users.json:', err.message);
      return res.status(500).json({ error: 'Failed to save changes. Ask an admin to check the server logs.' });
    }

    users.splice(userIndex, 1);
    console.log(`User unregistered: ${removedUser.name} (${gitlabUsername})`);
    res.json({ message: `${removedUser.name} has been removed. You'll stop receiving notifications shortly.` });
  } catch (err) {
    console.error('Unregister error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/edit', (req, res) => {
  res.send(getEditPage());
});

app.get('/api/user/:gitlabUsername', (req, res) => {
  const usernameLower = req.params.gitlabUsername.toLowerCase().trim();
  const user = users.find(u => _.get(u, 'gitlab.username', '').toLowerCase() === usernameLower);
  if (!user) {
    return res.status(404).json({ error: `No user found with GitLab username "${req.params.gitlabUsername}"` });
  }
  res.json({
    teamsWebhookUrl: user.teamsWebhookUrl,
    github: user.github,
    gitlab: user.gitlab,
    mentionAliases: user.mentionAliases || [],
    notifications: user.notifications || {}
  });
});

app.post('/edit', async (req, res) => {
  try {
    const gitlabUsername = sanitizeUsername(req.body.gitlabUsername);
    const githubUsername = sanitizeUsername(req.body.githubUsername);
    const { teamsWebhookUrl } = req.body;
    const mentionAliases = (req.body.mentionAliases || []).map(a => sanitizeUsername(a)).filter(Boolean);

    if (!gitlabUsername) {
      return res.status(400).json({ error: 'GitLab username is required' });
    }
    if (!teamsWebhookUrl) {
      return res.status(400).json({ error: 'Teams Webhook URL is required' });
    }

    if (looksLikeOwnServerUrl(teamsWebhookUrl)) {
      return res.status(400).json({ error: 'That looks like this server\'s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate.' });
    }

    const usernameLower = gitlabUsername.toLowerCase().trim();
    const userIndex = users.findIndex(u => _.get(u, 'gitlab.username', '').toLowerCase() === usernameLower);
    if (userIndex === -1) {
      return res.status(404).json({ error: `No user found with GitLab username "${gitlabUsername}"` });
    }

    const updatedUser = { ...users[userIndex], teamsWebhookUrl };

    if (githubUsername) {
      updatedUser.github = { username: githubUsername };
    } else {
      delete updatedUser.github;
    }

    if (mentionAliases && mentionAliases.length > 0) {
      updatedUser.mentionAliases = mentionAliases;
    } else {
      delete updatedUser.mentionAliases;
    }

    const notifications = sanitizeNotifications(req.body.notifications);
    if (notifications) {
      updatedUser.notifications = notifications;
    }

    users[userIndex] = updatedUser;
    const updatedUsers = [...users];

    try {
      await persistFile('users.json', updatedUsers, `edit: update ${updatedUser.name}`);
    } catch (err) {
      console.error('Failed to persist users.json:', err.message);
      return res.status(500).json({ error: 'Updated locally but failed to save permanently. Ask an admin to check the server logs.' });
    }

    console.log(`User updated: ${updatedUser.name}`);
    res.json({ message: 'Settings saved! Changes take effect within about a minute.' });
  } catch (err) {
    console.error('Edit error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Unified webhook handler
async function handleWebhook(req, res) {
  try {
    const isGitLab = req.headers['x-gitlab-event'] || req.headers[GITLAB_TOKEN_HEADER] || _.has(req.body, 'object_kind');
    const source = isGitLab ? 'gitlab' : 'github';

    if (source === 'gitlab') {
      const objectKind = _.get(req.body, 'object_kind', 'unknown');
      console.log(`Received GitLab webhook: object_kind=${objectKind}`);

      const repoName = _.get(req.body, 'project.path_with_namespace', '');
      if (repoName) addRepoIfNew(`gitlab:${repoName}`);

      const token = req.headers[GITLAB_TOKEN_HEADER];
      if (!verifyGitLabToken(token)) {
        console.error('Invalid GitLab token');
        return res.status(401).json({ error: 'Invalid token' });
      }

      const result = await processWebhook('gitlab', req.body);
      return res.json(result);
    }

    console.log('Received GitHub webhook');

    const repoName = _.get(req.body, 'repository.full_name', '');
    if (repoName) addRepoIfNew(`github:${repoName}`);

    const signature = req.headers[GITHUB_SIGNATURE_HEADER];
    if (!verifyGitHubSignature(req.body, signature)) {
      console.error('Invalid GitHub signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const result = await processWebhook('github', req.body, signature);
    return res.json(result);
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Single webhook endpoint — auto-detects GitHub vs GitLab
app.post('/webhook', handleWebhook);

// Legacy endpoints — keep for existing configurations
app.post('/webhook/github', handleWebhook);
app.post('/webhook/gitlab', handleWebhook);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    users: users.map(u => u.name),
    repos
  });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PR Comment Notifier running on port ${port}`);
  console.log(`Register: http://localhost:${port}/register`);
  console.log(`Webhook URL: http://localhost:${port}/webhook`);
  console.log(`Health check: http://localhost:${port}/health`);
});