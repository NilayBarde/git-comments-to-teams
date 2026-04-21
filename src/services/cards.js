import { humanizeRequester } from '../lib/helpers.js';

let editSettingsUrl = '';

function setBaseUrl(baseUrl) {
  editSettingsUrl = `${baseUrl}/edit`;
}

function appendSettingsLink(card) {
  const content = card.attachments[0].content;
  const actions = content.actions || [];
  actions.push({
    type: 'Action.OpenUrl',
    title: 'Notifications',
    url: editSettingsUrl
  });
  content.actions = actions;
  return card;
}

function createAdaptiveCard(data) {
  const { source, prTitle, prUrl, commentAuthor, commentBody, commentUrl, repoName, filePath } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';

  const truncatedBody = commentBody.length > 500
    ? commentBody.substring(0, 500) + '...'
    : commentBody;

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

  if (filePath) {
    card.attachments[0].content.body[1].facts.push({
      title: 'File:',
      value: filePath
    });
  }

  card.attachments[0].content.body.push({
    type: 'TextBlock',
    text: truncatedBody,
    wrap: true,
    separator: true
  });

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

function createMentionCard(data, mentionedAs) {
  const { source, prTitle, prUrl, commentAuthor, commentBody, commentUrl, repoName } = data;
  const sourceLabel = source === 'github' ? 'GitHub' : 'GitLab';
  const prLabel = source === 'github' ? 'PR' : 'MR';

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

export {
  setBaseUrl,
  createAdaptiveCard,
  createMentionCard,
  createMergeCard,
  createApprovalCard,
  createReviewRequestedCard,
  createPipelineFailureCard,
  createPipelineRecoveryCard,
  sendToTeams
};
