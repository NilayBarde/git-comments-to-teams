import _ from 'lodash';
import { deletePipelineState } from '../lib/db.js';
import {
  findPROwner,
  findUserByUsername,
  isCommentAuthor,
  classifyBotComment,
  isCodeownerBot,
  userWantsNotification,
  findMentionedUsers,
  DISABLED_BY_PREFS
} from '../lib/helpers.js';
import {
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
} from './parsers.js';
import {
  createAdaptiveCard,
  createMentionCard,
  createMergeCard,
  createApprovalCard,
  createReviewRequestedCard,
  createPipelineFailureCard,
  createPipelineRecoveryCard,
  sendToTeams
} from './cards.js';

async function processWebhook(source, data, { users }) {
  const results = [];
  const prLabel = source === 'github' ? 'PR' : 'MR';

  let mergeEvent;
  if (source === 'github') {
    mergeEvent = parseGitHubMergeEvent(data);
  } else if (source === 'gitlab') {
    mergeEvent = parseGitLabMergeEvent(data);
  }

  if (mergeEvent) {
    const { prAuthor, repoName: mergeRepo, sourceBranch } = mergeEvent;
    if (mergeRepo && sourceBranch) {
      try {
        const cleared = await deletePipelineState(mergeRepo, sourceBranch);
        if (cleared) console.log(`Cleared pipeline state for merged branch ${mergeRepo}:${sourceBranch}`);
      } catch (err) {
        console.error(`Failed to clear pipeline state for ${mergeRepo}:${sourceBranch}:`, err.message);
      }
    }
    const prOwner = findPROwner(users, source, prAuthor);

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

  let approvalEvent;
  if (source === 'github') {
    approvalEvent = parseGitHubReviewEvent(data);
  } else if (source === 'gitlab') {
    approvalEvent = parseGitLabApprovalEvent(data);
  }

  if (approvalEvent) {
    const { prAuthor, state, reviewedBy } = approvalEvent;
    const prOwner = findPROwner(users, source, prAuthor);

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
      const reviewer = findUserByUsername(users, source, reviewerUsername);
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

  if (source === 'gitlab') {
    const pipelineEvent = parseGitLabPipelineEvent(data);

    if (pipelineEvent) {
      const { prAuthor, type: pipelineType } = pipelineEvent;
      const prOwner = findPROwner(users, source, prAuthor);

      if (!prOwner) {
        console.log('Ignoring pipeline event - pipeline owner not in configured users');
        return { processed: false, reason: 'pipeline owner not configured' };
      }

      const dedupResult = await checkPipelineDedup(pipelineEvent);

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

  let parsed;
  if (source === 'github') {
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

  const prOwner = findPROwner(users, source, prAuthor);
  const mentionedUsers = findMentionedUsers(users, commentBody, source);
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

async function handleWebhook(req, res, { users, addRepoIfNew, githubSecret, gitlabToken }) {
  try {
    const isGitLab = req.headers['x-gitlab-event'] || req.headers[GITLAB_TOKEN_HEADER] || _.has(req.body, 'object_kind');
    const source = isGitLab ? 'gitlab' : 'github';

    if (source === 'gitlab') {
      const objectKind = _.get(req.body, 'object_kind', 'unknown');
      console.log(`Received GitLab webhook: object_kind=${objectKind}`);

      const repoName = _.get(req.body, 'project.path_with_namespace', '');
      if (repoName) addRepoIfNew(`gitlab:${repoName}`);

      const token = req.headers[GITLAB_TOKEN_HEADER];
      if (!verifyGitLabToken(token, gitlabToken)) {
        console.error('Invalid GitLab token');
        return res.status(401).json({ error: 'Invalid token' });
      }

      const result = await processWebhook('gitlab', req.body, { users, addRepoIfNew });
      return res.json(result);
    }

    console.log('Received GitHub webhook');

    const repoName = _.get(req.body, 'repository.full_name', '');
    if (repoName) addRepoIfNew(`github:${repoName}`);

    const signature = req.headers[GITHUB_SIGNATURE_HEADER];
    if (!verifyGitHubSignature(req.body, signature, githubSecret)) {
      console.error('Invalid GitHub signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const result = await processWebhook('github', req.body, { users, addRepoIfNew });
    return res.json(result);
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export { processWebhook, handleWebhook };
