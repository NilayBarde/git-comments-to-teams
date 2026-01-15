require('dotenv').config(); // Load .env file for local development

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const _ = require('lodash');

// Load configuration from environment variables
const config = {
  port: process.env.PORT || 3000,
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET
  },
  gitlab: {
    webhookToken: process.env.GITLAB_WEBHOOK_TOKEN
  }
};

// Parse USERS_CONFIG from environment variable
let users = [];
try {
  const usersConfigStr = process.env.USERS_CONFIG;
  if (!usersConfigStr) {
    console.error('Error: USERS_CONFIG environment variable is required');
    console.error('See README.md for the expected format');
    process.exit(1);
  }
  users = JSON.parse(usersConfigStr);
  if (!Array.isArray(users) || users.length === 0) {
    console.error('Error: USERS_CONFIG must be a non-empty JSON array');
    process.exit(1);
  }
} catch (error) {
  console.error('Error parsing USERS_CONFIG:', error.message);
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

// Log config for debugging
console.log('Config loaded:', {
  usersCount: users.length,
  users: users.map(u => ({
    name: u.name,
    teamsWebhookUrl: u.teamsWebhookUrl ? 'SET' : 'NOT SET',
    github: u.github?.username,
    gitlab: `${u.gitlab?.username} (${u.gitlab?.userId})`
  }))
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

// GitHub webhook endpoint
app.post('/webhook/github', async (req, res) => {
  console.log('Received GitHub webhook');

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
  console.log('Received GitLab webhook');

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const port = _.get(config, 'port', 3000);
app.listen(port, () => {
  console.log(`PR Comment Notifier running on port ${port}`);
  console.log(`GitHub webhook URL: http://localhost:${port}/webhook/github`);
  console.log(`GitLab webhook URL: http://localhost:${port}/webhook/gitlab`);
  console.log(`Health check: http://localhost:${port}/health`);
});