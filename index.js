require('dotenv').config(); // Load .env file for local development

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');

// Load configuration from environment variables
const config = {
  port: process.env.PORT || 3000,
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO
  },
  gitlab: {
    webhookToken: process.env.GITLAB_WEBHOOK_TOKEN,
    apiToken: process.env.GITLAB_API_TOKEN,
    apiUrl: process.env.GITLAB_API_URL || 'https://gitlab.com'
  }
};

// Load users from users.json (primary) or USERS_CONFIG env var (fallback)
const USERS_FILE = path.join(__dirname, 'users.json');
let users = [];
try {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log(`Loaded ${users.length} users from users.json`);
  } else if (process.env.USERS_CONFIG) {
    users = JSON.parse(process.env.USERS_CONFIG);
    console.log(`Loaded ${users.length} users from USERS_CONFIG env var`);
  } else {
    console.error('Error: No user config found (users.json or USERS_CONFIG env var)');
    console.error('See README.md or visit /register to add users');
    process.exit(1);
  }
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

// Parse configured repos and track discovered ones
const configuredRepos = process.env.WATCHED_REPOS
  ? process.env.WATCHED_REPOS.split(',').map(r => r.trim()).filter(Boolean)
  : [];
const discoveredRepos = new Set();

// Log config for debugging
console.log('Config loaded:', {
  usersCount: users.length,
  users: users.map(u => ({
    name: u.name,
    teamsWebhookUrl: u.teamsWebhookUrl ? 'SET' : 'NOT SET',
    github: u.github?.username,
    gitlab: `${u.gitlab?.username} (${u.gitlab?.userId})`
  })),
  watchedRepos: configuredRepos
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
const PIPELINE_OBJECT_KIND = 'pipeline';
const PIPELINE_FAILED_STATUS = 'failed';
const PIPELINE_SUCCESS_STATUS = 'success';

// Patterns for bot usernames to ignore (GitLab project/group bots, GitHub app bots)
const BOT_USERNAME_PATTERNS = [
  /^project_\d+_bot_/i,
  /^group_\d+_bot_/i,
  /\[bot\]$/i,
  /^DTCI\.DL-Technology\.PE\.Infra\.CD$/i
];

// Parse JSON body
app.use(express.json());

/**
 * Verify GitHub webhook signature
 */
function verifyGitHubSignature(payload, signature) {
  const secret = _.get(config, 'github.webhookSecret');
  if (!secret) return true; // Skip verification if no secret configured
  
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest));
}

/**
 * Verify GitLab webhook token
 */
function verifyGitLabToken(token) {
  const configuredToken = _.get(config, 'gitlab.webhookToken');
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

/**
 * Check if a username belongs to a bot account
 */
function isBotUser(username) {
  if (!username) return false;
  return BOT_USERNAME_PATTERNS.some(pattern => pattern.test(username));
}

/**
 * Find all users who are mentioned in a comment
 * @returns {Array<{user: Object, mentionedAs: string}>} Array of user/mention pairs
 */
function findMentionedUsers(commentBody, source) {
  if (!commentBody) return [];
  
  const mentionedUsers = [];
  
  users.forEach(user => {
    // Get the user's username for the source
    const username = source === 'github' 
      ? _.get(user, 'github.username', '')
      : _.get(user, 'gitlab.username', '');
    
    // Get additional team aliases for this user
    const aliases = _.get(user, 'mentionAliases', []);
    
    // Combine username and aliases
    const allNames = [username, ...aliases].filter(Boolean);
    
    // Check if any name is mentioned
    const mentioned = allNames.find(name => {
      const pattern = new RegExp(`@${name}\\b`, 'i');
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

  return {
    type: 'merge',
    source: 'gitlab',
    prAuthor,
    prTitle,
    prUrl,
    mergedBy,
    repoName
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

  return {
    type: 'merge',
    source: 'github',
    prAuthor,
    prTitle,
    prUrl,
    mergedBy,
    repoName
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

  // Only notify for pipelines associated with a merge request
  const mergeRequest = _.get(body, 'merge_request');
  if (!mergeRequest) {
    console.log(`Ignoring pipeline - no merge_request in payload (source: ${pipelineSource}, ref: ${ref}). Pipeline events must come from MR pipelines.`);
    return;
  }

  const prAuthor = _.get(mergeRequest, 'author_id');
  const prTitle = _.get(mergeRequest, 'title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const branch = _.get(body, 'object_attributes.ref', '');
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

  // Collect failed stages/jobs for context when pipeline failed
  if (isFailed) {
    const builds = _.get(body, 'builds', []);
    result.failedJobs = builds
      .filter(build => _.get(build, 'status') === PIPELINE_FAILED_STATUS)
      .map(build => `${_.get(build, 'stage', '')}:${_.get(build, 'name', '')}`);
  }

  return result;
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

  // Handle issue comments on PRs
  const issueComment = _.get(body, 'comment');
  const issue = _.get(body, 'issue');
  const pullRequest = _.get(body, 'pull_request') || issue;
  
  if (!pullRequest || !issueComment) return;
  
  // Check if it's actually a PR (issues don't have pull_request field in the issue object)
  const isPR = _.has(issue, 'pull_request') || _.has(body, 'pull_request');
  if (!isPR) return;

  const prAuthor = _.get(pullRequest, 'user.login', '');
  const prTitle = _.get(pullRequest, 'title', '');
  const prUrl = _.get(pullRequest, 'html_url', '');
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

  return card;
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

  return card;
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

  return card;
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

  return card;
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

  return card;
}

/**
 * Create Teams Adaptive Card for pipeline success notifications
 */
function createPipelineSuccessCard(data) {
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
              text: '🟢 Pipeline Passed on your MR',
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

  return card;
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
    const { prAuthor } = mergeEvent;
    const prOwner = findPROwner(source, prAuthor);
    
    if (prOwner) {
      const { mergedBy } = mergeEvent;
      if (isCommentAuthor(prOwner, source, mergedBy)) {
        console.log(`Ignoring self-merge by ${mergedBy} on their own ${prLabel}`);
        return { processed: false, reason: 'self-merge' };
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
      const stateLabel = state === 'approved' ? 'approval' : 'changes requested';
      console.log(`Processing ${source} ${stateLabel} from ${reviewedBy} for ${prOwner.name}'s "${approvalEvent.prTitle}"`);
      const card = createApprovalCard(approvalEvent);
      const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
      return { processed: sent, type: 'approval', state, user: prOwner.name, data: approvalEvent };
    }
    
    console.log(`Ignoring approval event - ${prLabel} author not in configured users`);
    return { processed: false, reason: `${prLabel} author not configured` };
  }

  // Check for pipeline events (GitLab only)
  if (source === 'gitlab') {
    const pipelineEvent = parseGitLabPipelineEvent(data);

    if (pipelineEvent) {
      const { prAuthor, type: pipelineType } = pipelineEvent;
      const prOwner = findPROwner(source, prAuthor);

      if (prOwner) {
        const isFailed = pipelineType === 'pipeline_failed';
        const statusLabel = isFailed ? 'failure' : 'success';
        console.log(`Processing ${source} pipeline ${statusLabel} for ${prOwner.name}'s "${pipelineEvent.prTitle}"`);
        const card = isFailed ? createPipelineFailureCard(pipelineEvent) : createPipelineSuccessCard(pipelineEvent);
        const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
        return { processed: sent, type: pipelineType, user: prOwner.name, data: pipelineEvent };
      }

      console.log('Ignoring pipeline event - MR author not in configured users');
      return { processed: false, reason: 'MR author not configured' };
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

  // Filter out bot comments
  if (isBotUser(commentAuthor)) {
    console.log(`Ignoring comment from bot user: ${commentAuthor}`);
    return { processed: false, reason: 'comment from bot user' };
  }

  // Find the PR owner
  const prOwner = findPROwner(source, prAuthor);
  
  // Find all mentioned users
  const mentionedUsers = findMentionedUsers(commentBody, source);
  
  // Track who we've notified to avoid duplicates
  const notifiedUsers = new Set();
  
  // Allow self-comments for testing (set ALLOW_SELF_COMMENTS=true)
  const allowSelfComments = process.env.ALLOW_SELF_COMMENTS === 'true';

  // Notify PR owner (if not commenting on their own PR, unless ALLOW_SELF_COMMENTS is set)
  if (prOwner && (allowSelfComments || !isCommentAuthor(prOwner, source, commentAuthor))) {
    console.log(`Processing ${source} comment from ${commentAuthor} on ${prOwner.name}'s "${parsed.prTitle}"`);
    const card = createAdaptiveCard(parsed);
    const sent = await sendToTeams(card, prOwner.teamsWebhookUrl);
    results.push({ type: 'comment', user: prOwner.name, sent });
    notifiedUsers.add(prOwner.name);
  }

  // Notify mentioned users (if not the comment author and not already notified as PR owner)
  for (const { user, mentionedAs } of mentionedUsers) {
    // Skip if this user is the comment author (unless ALLOW_SELF_COMMENTS is set)
    if (!allowSelfComments && isCommentAuthor(user, source, commentAuthor)) {
      continue;
    }
    // Skip if already notified as PR owner
    if (notifiedUsers.has(user.name)) {
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

async function lookupGitLabUserId(username) {
  const { apiUrl, apiToken } = config.gitlab;
  if (!apiToken) throw new Error('GITLAB_API_TOKEN is not configured on the server');

  const response = await fetch(
    `${apiUrl}/api/v4/users?username=${encodeURIComponent(username)}`,
    { headers: { 'PRIVATE-TOKEN': apiToken } }
  );

  if (!response.ok) throw new Error(`GitLab API returned ${response.status}`);

  const results = await response.json();
  if (results.length === 0) throw new Error(`GitLab user "${username}" not found`);

  return results[0].id;
}

async function commitUsersToGitHub(updatedUsers, commitMessage) {
  const { token, repo } = config.github;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPO are not configured on the server');

  const apiUrl = `https://api.github.com/repos/${repo}/contents/users.json`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  let sha;
  const getResponse = await fetch(apiUrl, { headers });
  if (getResponse.ok) {
    const data = await getResponse.json();
    sha = data.sha;
  }

  const content = Buffer.from(JSON.stringify(updatedUsers, null, 2) + '\n').toString('base64');
  const body = {
    message: commitMessage,
    content,
    ...(sha ? { sha } : {})
  };

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
</style>
</head>
<body>
<div class="container">
  <h1>PR Comment Notifier</h1>
  <p class="subtitle">Sign up to get Teams notifications for comments, reviews, merges, and pipeline events on your MRs/PRs.</p>

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
        <li>After saving, copy the <strong>HTTP POST URL</strong> — that's your webhook URL</li>
      </ol>
    </details>
  </div>

  <form id="regForm" class="card">
    <h2>Your Details</h2>

    <div class="field">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" placeholder="e.g. nilay" required>
    </div>

    <div class="field">
      <label for="teamsWebhookUrl">Teams Webhook URL</label>
      <div class="hint">The URL you copied from the Workflows step above</div>
      <input type="url" id="teamsWebhookUrl" name="teamsWebhookUrl" placeholder="https://..." required>
    </div>

    <div class="field">
      <label for="gitlabUsername">GitLab Username <span class="optional-tag">optional</span></label>
      <div class="hint">Your GitLab user ID will be looked up automatically</div>
      <input type="text" id="gitlabUsername" name="gitlabUsername" placeholder="e.g. Nilay.Barde">
    </div>

    <div class="field">
      <label for="githubUsername">GitHub Username <span class="optional-tag">optional</span></label>
      <input type="text" id="githubUsername" name="githubUsername" placeholder="e.g. NilayBarde">
    </div>

    <div class="field">
      <label for="mentionAliases">Mention Aliases <span class="optional-tag">optional, comma-separated</span></label>
      <div class="hint">Team aliases you want to be notified for, e.g. @espn-core-web</div>
      <input type="text" id="mentionAliases" name="mentionAliases" placeholder="e.g. espn-core-web, bet-squad">
    </div>

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

  const aliases = document.getElementById('mentionAliases').value
    .split(',').map(s => s.trim()).filter(Boolean);

  try {
    const res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('name').value.trim(),
        teamsWebhookUrl: document.getElementById('teamsWebhookUrl').value.trim(),
        gitlabUsername: document.getElementById('gitlabUsername').value.trim(),
        githubUsername: document.getElementById('githubUsername').value.trim(),
        mentionAliases: aliases
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

// ── Routes ──

app.get('/register', (req, res) => {
  res.send(getRegistrationPage());
});

app.post('/register', async (req, res) => {
  try {
    const { name, teamsWebhookUrl, gitlabUsername, githubUsername, mentionAliases } = req.body;

    if (!name || !teamsWebhookUrl) {
      return res.status(400).json({ error: 'Name and Teams Webhook URL are required' });
    }

    const nameLower = name.toLowerCase().trim();
    const isDuplicate = users.some(u => u.name.toLowerCase() === nameLower);
    if (isDuplicate) {
      return res.status(409).json({ error: `User "${name}" is already registered` });
    }

    // Build user object
    const newUser = { name: nameLower, teamsWebhookUrl };

    if (gitlabUsername) {
      try {
        const userId = await lookupGitLabUserId(gitlabUsername);
        newUser.gitlab = { username: gitlabUsername, userId };
      } catch (err) {
        return res.status(400).json({ error: `GitLab lookup failed: ${err.message}` });
      }
    }

    if (githubUsername) {
      newUser.github = { username: githubUsername };
    }

    if (mentionAliases && mentionAliases.length > 0) {
      newUser.mentionAliases = mentionAliases;
    }

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
            text: `Hi ${name}! Your notifications are set up. You'll start receiving alerts for comments, reviews, merges, and pipeline events.`,
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

    // Commit to GitHub to persist across deploys
    try {
      await commitUsersToGitHub(updatedUsers, `register: add ${nameLower}`);
    } catch (err) {
      console.error('Failed to commit users.json to GitHub:', err.message);
      return res.status(500).json({ error: 'Registered locally but failed to save permanently. Ask an admin to check the server logs.' });
    }

    console.log(`New user registered: ${nameLower}`);
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
    const { gitlabUsername } = req.body;
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
      await commitUsersToGitHub(updatedUsers, `unregister: remove ${removedUser.name}`);
    } catch (err) {
      console.error('Failed to commit users.json to GitHub:', err.message);
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

// GitHub webhook endpoint
app.post('/webhook/github', async (req, res) => {
  console.log('Received GitHub webhook');

  const repoName = _.get(req.body, 'repository.full_name', '');
  if (repoName) discoveredRepos.add(`github:${repoName}`);

  const signature = req.headers[GITHUB_SIGNATURE_HEADER];
  
  if (!verifyGitHubSignature(req.body, signature)) {
    console.error('Invalid GitHub signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const result = await processWebhook('github', req.body, signature);
  res.json(result);
});

// GitLab webhook endpoint
app.post('/webhook/gitlab', async (req, res) => {
  const objectKind = _.get(req.body, 'object_kind', 'unknown');
  console.log(`Received GitLab webhook: object_kind=${objectKind}`);

  const repoName = _.get(req.body, 'project.path_with_namespace', '');
  if (repoName) discoveredRepos.add(`gitlab:${repoName}`);

  const token = req.headers[GITLAB_TOKEN_HEADER];
  
  if (!verifyGitLabToken(token)) {
    console.error('Invalid GitLab token');
    return res.status(401).json({ error: 'Invalid token' });
  }

  const result = await processWebhook('gitlab', req.body);
  res.json(result);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const allRepos = [...new Set([...configuredRepos, ...discoveredRepos])].sort();
  const newRepos = [...discoveredRepos].filter(r => !configuredRepos.includes(r)).sort();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    users: users.map(u => u.name),
    repos: {
      configured: configuredRepos.length,
      discovered: newRepos.length,
      total: allRepos.length,
      list: allRepos,
      ...(newRepos.length > 0 ? { new: newRepos } : {})
    }
  });
});

// Start server
const port = _.get(config, 'port', 3000);
app.listen(port, () => {
  console.log(`PR Comment Notifier running on port ${port}`);
  console.log(`Register: http://localhost:${port}/register`);
  console.log(`GitHub webhook URL: http://localhost:${port}/webhook/github`);
  console.log(`GitLab webhook URL: http://localhost:${port}/webhook/gitlab`);
  console.log(`Health check: http://localhost:${port}/health`);
});