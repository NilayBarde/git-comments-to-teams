const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const _ = require('lodash');

// Load configuration
let config;
try {
  config = require('./config.json');
} catch (error) {
  console.error('Error: config.json not found. Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}

const app = express();

// Constants
const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
const GITLAB_TOKEN_HEADER = 'x-gitlab-token';
const COMMENT_CREATED_ACTION = 'created';
const NOTE_OBJECT_KIND = 'note';
const MERGE_REQUEST_TYPE = 'MergeRequest';

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
 * Check if the PR/MR belongs to the configured user
 */
function isOwnPullRequest(source, prAuthor) {
  if (source === 'github') {
    const configuredUsername = _.get(config, 'github.username', '').toLowerCase();
    const prAuthorLower = String(prAuthor).toLowerCase();
    console.log(`GitHub PR comparison: author="${prAuthorLower}" vs configured="${configuredUsername}"`);
    return prAuthorLower === configuredUsername;
  }
  if (source === 'gitlab') {
    const configuredUsername = _.get(config, 'gitlab.username', '').toLowerCase();
    const configuredUserId = _.get(config, 'gitlab.userId');
    const prAuthorStr = String(prAuthor);
    const configuredUserIdStr = String(configuredUserId);
    console.log(`GitLab MR comparison: author_id="${prAuthorStr}" vs configured userId="${configuredUserIdStr}" username="${configuredUsername}"`);
    // Compare as strings to handle type mismatches
    return prAuthorStr === configuredUserIdStr;
  }
  return false;
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
              text: `New Comment on Your ${prLabel}`,
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
 * Send notification to Teams
 */
async function sendToTeams(card) {
  const webhookUrl = _.get(config, 'teamsWebhookUrl');
  if (!webhookUrl || webhookUrl === 'YOUR_TEAMS_INCOMING_WEBHOOK_URL') {
    console.error('Teams webhook URL not configured');
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
  let parsed;

  if (source === 'github') {
    // Try parsing as PR review comment first, then as issue comment
    parsed = parseGitHubReviewPayload(data) || parseGitHubPayload(data);
  } else if (source === 'gitlab') {
    parsed = parseGitLabPayload(data);
  }

  if (!parsed) {
    console.log(`Ignoring ${source} event - not a PR/MR comment`);
    return { processed: false, reason: 'not a PR/MR comment' };
  }

  const { prAuthor, commentAuthor } = parsed;

  // Don't notify for your own comments (unless ALLOW_SELF_COMMENTS is set for testing)
  const allowSelfComments = process.env.ALLOW_SELF_COMMENTS === 'true';
  if (!allowSelfComments && isOwnPullRequest(source, commentAuthor.toString())) {
    console.log('Ignoring self-comment');
    return { processed: false, reason: 'self-comment' };
  }

  // Only notify if it's your PR/MR
  if (!isOwnPullRequest(source, prAuthor.toString())) {
    console.log(`Ignoring - not your ${source === 'github' ? 'PR' : 'MR'}`);
    return { processed: false, reason: 'not your PR/MR' };
  }

  console.log(`Processing ${source} comment from ${commentAuthor} on "${parsed.prTitle}"`);
  
  const card = createAdaptiveCard(parsed);
  const sent = await sendToTeams(card);

  return { processed: sent, data: parsed };
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