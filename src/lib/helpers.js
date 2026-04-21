import _ from 'lodash';

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

function looksLikeOwnServerUrl(url, baseUrl) {
  try {
    const host = new URL(url).hostname;
    const ownHost = new URL(baseUrl).hostname;
    return host === ownHost || host.endsWith('onrender.com') || host === 'localhost';
  } catch {
    return false;
  }
}

function findPROwner(users, source, prAuthor) {
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

function findUserByUsername(users, source, username) {
  const usernameLower = String(username).toLowerCase();
  return users.find(user => {
    const configuredName = source === 'github'
      ? _.get(user, 'github.username', '')
      : _.get(user, 'gitlab.username', '');
    return configuredName.toLowerCase() === usernameLower;
  });
}

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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMentionedUsers(users, commentBody, source) {
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

export {
  NOTIFICATION_DEFAULTS,
  DISABLED_BY_PREFS,
  sanitizeNotifications,
  sanitizeUsername,
  looksLikeOwnServerUrl,
  findPROwner,
  findUserByUsername,
  isCommentAuthor,
  classifyBotComment,
  isCodeownerBot,
  humanizeRequester,
  userWantsNotification,
  findMentionedUsers
};
