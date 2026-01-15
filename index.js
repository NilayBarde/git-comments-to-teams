require('dotenv').config(); // Load .env file for local development

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const _ = require('lodash');

// Load configuration from environment variables
const config = {
  port: process.env.PORT || 3000,
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL,
  github: {
    username: process.env.GITHUB_USERNAME,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET
  },
  gitlab: {
    username: process.env.GITLAB_USERNAME,
    userId: process.env.GITLAB_USER_ID ? parseInt(process.env.GITLAB_USER_ID, 10) : undefined,
    webhookToken: process.env.GITLAB_WEBHOOK_TOKEN
  }
};

// Log config for debugging
console.log('Config loaded:', {
  teamsWebhookUrl: config.teamsWebhookUrl ? 'SET' : 'NOT SET',
  gitlabUsername: config.gitlab.username,
  gitlabUserId: config.gitlab.userId,
  githubUsername: config.github.username
});

// Validate required config
if (!config.teamsWebhookUrl) {
  console.error('Error: TEAMS_WEBHOOK_URL environment variable is required');
  console.error('For local dev: create a .env file (copy from .env.example)');
  console.error('For production: set environment variables in your hosting platform');
  process.exit(1);
}

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
 * Check if the user or their team aliases are mentioned in a comment
 */
function isMentioned(commentBody, source) {
  if (!commentBody) return false;
  
  // Get the user's username for the source
  const username = source === 'github' 
    ? _.get(config, 'github.username', '')
    : _.get(config, 'gitlab.username', '');
  
  // Get additional team aliases from env
  const aliasesStr = process.env.MENTION_ALIASES || '';
  const aliases = aliasesStr.split(',').map(a => a.trim()).filter(Boolean);
  
  // Combine username and aliases
  const allNames = [username, ...aliases].filter(Boolean);
  
  // Check if any name is mentioned
  const mentioned = allNames.find(name => {
    const pattern = new RegExp(`@${name}\\b`, 'i');
    return pattern.test(commentBody);
  });
  
  if (mentioned) {
    console.log(`Mention detected: @${mentioned}`);
    return mentioned;
  }
  
  return false;
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
    
    // Only notify if it's YOUR MR that was merged
    if (isOwnPullRequest(source, prAuthor.toString())) {
      console.log(`Processing ${source} merge event for "${mergeEvent.prTitle}"`);
      const card = createMergeCard(mergeEvent);
      const sent = await sendToTeams(card);
      return { processed: sent, type: 'merge', data: mergeEvent };
    }
    
    console.log(`Ignoring merge event - not your ${source === 'github' ? 'PR' : 'MR'}`);
    return { processed: false, reason: 'not your PR/MR merge' };
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
    
    // Only notify if it's YOUR MR that was reviewed
    if (isOwnPullRequest(source, prAuthor.toString())) {
      const stateLabel = state === 'approved' ? 'approval' : 'changes requested';
      console.log(`Processing ${source} ${stateLabel} from ${reviewedBy} for "${approvalEvent.prTitle}"`);
      const card = createApprovalCard(approvalEvent);
      const sent = await sendToTeams(card);
      return { processed: sent, type: 'approval', state, data: approvalEvent };
    }
    
    console.log(`Ignoring approval event - not your ${source === 'github' ? 'PR' : 'MR'}`);
    return { processed: false, reason: 'not your PR/MR approval' };
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
    console.log(`Ignoring ${source} event - not a recognized PR/MR event`);
    return { processed: false, reason: 'not a recognized PR/MR event' };
  }

  const { prAuthor, commentAuthor, commentBody } = parsed;

  // Don't notify for your own comments (unless ALLOW_SELF_COMMENTS is set for testing)
  const allowSelfComments = process.env.ALLOW_SELF_COMMENTS === 'true';
  if (!allowSelfComments && isOwnPullRequest(source, commentAuthor.toString())) {
    console.log('Ignoring self-comment');
    return { processed: false, reason: 'self-comment' };
  }

  // Check if it's your PR/MR
  const isYourPR = isOwnPullRequest(source, prAuthor.toString());
  
  // Check if you were mentioned in the comment
  const mentionedAs = isMentioned(commentBody, source);
  
  // Notify if it's your PR OR if you were mentioned
  if (isYourPR) {
    console.log(`Processing ${source} comment from ${commentAuthor} on YOUR "${parsed.prTitle}"`);
    const card = createAdaptiveCard(parsed);
    const sent = await sendToTeams(card);
    return { processed: sent, type: 'comment', data: parsed };
  }
  
  if (mentionedAs) {
    console.log(`Processing ${source} mention from ${commentAuthor} - mentioned as @${mentionedAs}`);
    const card = createMentionCard(parsed, mentionedAs);
    const sent = await sendToTeams(card);
    return { processed: sent, type: 'mention', mentionedAs, data: parsed };
  }

  console.log(`Ignoring - not your ${source === 'github' ? 'PR' : 'MR'} and not mentioned`);
  return { processed: false, reason: 'not your PR/MR and not mentioned' };
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