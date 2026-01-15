#!/usr/bin/env node

/**
 * Test script to simulate GitHub and GitLab webhooks locally
 * Usage: node test-webhook.js [github|gitlab]
 */

const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';

// Sample GitHub PR comment payload
const githubPayload = {
  action: 'created',
  issue: {
    number: 42,
    title: 'Add new feature for user authentication',
    html_url: 'https://github.com/example/repo/pull/42',
    user: {
      login: 'YOUR_GITHUB_USERNAME' // Change this to match your config
    },
    pull_request: {} // Indicates this is a PR, not an issue
  },
  comment: {
    body: 'Great work! Just a few suggestions:\n\n1. Consider adding error handling here\n2. Could you add a unit test for this function?',
    html_url: 'https://github.com/example/repo/pull/42#issuecomment-123456',
    user: {
      login: 'reviewer-user'
    }
  },
  repository: {
    full_name: 'example/repo'
  }
};

// Sample GitHub PR review comment payload
const githubReviewPayload = {
  action: 'created',
  pull_request: {
    number: 42,
    title: 'Add new feature for user authentication',
    html_url: 'https://github.com/example/repo/pull/42',
    user: {
      login: 'YOUR_GITHUB_USERNAME' // Change this to match your config
    }
  },
  comment: {
    body: 'This line should use `const` instead of `let` since the value is never reassigned.',
    html_url: 'https://github.com/example/repo/pull/42#discussion_r123456',
    path: 'src/auth/login.js',
    user: {
      login: 'reviewer-user'
    }
  },
  repository: {
    full_name: 'example/repo'
  }
};

// Sample GitLab MR note payload
const gitlabPayload = {
  object_kind: 'note',
  event_type: 'note',
  user: {
    username: 'reviewer-user'
  },
  project: {
    path_with_namespace: 'group/project'
  },
  merge_request: {
    title: 'Implement OAuth2 integration',
    url: 'https://gitlab.com/group/project/-/merge_requests/15',
    author_id: 12345 // Change this to match your config gitlab.userId
  },
  object_attributes: {
    note: 'Nice implementation! One question: should we add rate limiting to this endpoint?',
    noteable_type: 'MergeRequest',
    url: 'https://gitlab.com/group/project/-/merge_requests/15#note_123456'
  }
};

async function sendTestWebhook(type) {
  let url;
  let payload;
  let headers = { 'Content-Type': 'application/json' };

  switch (type) {
    case 'github':
      url = `${BASE_URL}/webhook/github`;
      payload = githubPayload;
      break;
    case 'github-review':
      url = `${BASE_URL}/webhook/github`;
      payload = githubReviewPayload;
      break;
    case 'gitlab':
      url = `${BASE_URL}/webhook/gitlab`;
      payload = gitlabPayload;
      // Add GitLab token header if configured
      // headers['x-gitlab-token'] = 'YOUR_GITLAB_WEBHOOK_TOKEN';
      break;
    default:
      console.log('Usage: node test-webhook.js [github|github-review|gitlab]');
      console.log('');
      console.log('Options:');
      console.log('  github        - Test GitHub issue comment on PR');
      console.log('  github-review - Test GitHub PR review comment');
      console.log('  gitlab        - Test GitLab MR note');
      process.exit(1);
  }

  console.log(`Sending test ${type} webhook to ${url}...`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log('Response:', JSON.stringify(result, null, 2));

    if (result.processed) {
      console.log('\n✓ Webhook processed successfully! Check your Teams channel.');
    } else {
      console.log(`\n✗ Webhook was not processed. Reason: ${result.reason}`);
      console.log('\nCommon issues:');
      console.log('  - "not your PR/MR": Update the username in the test payload and config.json');
      console.log('  - "self-comment": The comment author matches your username');
      console.log('  - "not a PR/MR comment": The payload structure is incorrect');
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.log('\nMake sure the server is running: npm start');
  }
}

const type = process.argv[2];
sendTestWebhook(type);
