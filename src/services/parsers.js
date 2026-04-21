import crypto from 'crypto';
import _ from 'lodash';
import { getPipelineState, setPipelineState, deletePipelineState } from '../lib/db.js';

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

function verifyGitHubSignature(payload, signature, secret) {
  if (!secret) return true;
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  const sigBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

function verifyGitLabToken(token, configuredToken) {
  if (!configuredToken) return true;
  return token === configuredToken;
}

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

function parseGitHubMergeEvent(body) {
  const action = _.get(body, 'action');
  if (action !== PR_CLOSED_ACTION) return;

  const pullRequest = _.get(body, 'pull_request');
  if (!pullRequest) return;

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

async function checkPipelineDedup(pipelineEvent) {
  const { type, repoName, branch, failedJobs } = pipelineEvent;
  const prev = await getPipelineState(repoName, branch);
  const isFailed = type === 'pipeline_failed';

  if (isFailed) {
    const sortedJobs = (failedJobs || []).slice().sort();
    const prevJobs = prev?.failedJobs || [];
    const isDuplicate = prev?.status === 'failed' &&
      sortedJobs.length === prevJobs.length &&
      sortedJobs.every((job, i) => job === prevJobs[i]);

    await setPipelineState(repoName, branch, { status: 'failed', failedJobs: sortedJobs, timestamp: Date.now() });

    if (isDuplicate) return 'suppress';
    return 'notify_failure';
  }

  const wasFailure = prev?.status === 'failed';
  await deletePipelineState(repoName, branch);

  if (wasFailure) return 'notify_recovery';
  return 'suppress';
}

function parseGitHubReviewEvent(body) {
  const action = _.get(body, 'action');
  if (action !== PR_REVIEW_SUBMITTED_ACTION) return;

  const review = _.get(body, 'review');
  const pullRequest = _.get(body, 'pull_request');
  if (!review || !pullRequest) return;

  const state = _.get(review, 'state', '').toLowerCase();

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
    state,
    prAuthor,
    prTitle,
    prUrl,
    reviewedBy,
    repoName,
    reviewBody
  };
}

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

function parseGitLabPayload(body) {
  const objectKind = _.get(body, 'object_kind');
  if (objectKind !== NOTE_OBJECT_KIND) return;

  const noteableType = _.get(body, 'object_attributes.noteable_type');
  if (noteableType !== MERGE_REQUEST_TYPE) return;

  const noteAction = _.get(body, 'object_attributes.action');
  if (noteAction && noteAction !== 'create') {
    console.log(`Ignoring note event with action: ${noteAction}`);
    return;
  }

  const mergeRequest = _.get(body, 'merge_request');
  if (!mergeRequest) return;

  const prAuthor = _.get(mergeRequest, 'author_id');
  const prTitle = _.get(mergeRequest, 'title', '');
  const prUrl = _.get(mergeRequest, 'url', '');
  const commentAuthor = _.get(body, 'user.username', '');
  const commentBody = _.get(body, 'object_attributes.note', '');
  const commentUrl = _.get(body, 'object_attributes.url', '');
  const repoName = _.get(body, 'project.path_with_namespace', '');

  return {
    source: 'gitlab',
    prAuthor,
    prTitle,
    prUrl,
    commentAuthor,
    commentBody,
    commentUrl,
    repoName
  };
}

export {
  GITHUB_SIGNATURE_HEADER,
  GITLAB_TOKEN_HEADER,
  verifyGitHubSignature,
  verifyGitLabToken,
  parseGitLabMergeEvent,
  parseGitHubMergeEvent,
  parseGitLabApprovalEvent,
  parseGitHubReviewRequestedEvent,
  parseGitLabReviewRequestedEvent,
  parseGitLabPipelineEvent,
  checkPipelineDedup,
  parseGitHubReviewEvent,
  parseGitHubPayload,
  parseGitHubReviewPayload,
  parseGitLabPayload
};
