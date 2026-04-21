import 'dotenv/config';
import express from 'express';
import _ from 'lodash';
import {
  getUsers, putUser, deleteUser as dbDeleteUser,
  getRepos, putRepo as dbPutRepo
} from './lib/db.js';
import {
  NOTIFICATION_DEFAULTS,
  sanitizeNotifications,
  sanitizeUsername,
  looksLikeOwnServerUrl
} from './lib/helpers.js';
import { setBaseUrl, sendToTeams } from './services/cards.js';
import { getRegistrationPage, getUnregisterPage, getEditPage, getLandingPage } from './pages/pages.js';
import { handleWebhook } from './services/webhook.js';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITLAB_WEBHOOK_TOKEN = process.env.GITLAB_WEBHOOK_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://git-comments-to-teams.onrender.com';

setBaseUrl(BASE_URL);

let users = [];
let repos = [];
let dataLoaded = false;

async function loadData() {
  if (dataLoaded) return;
  try {
    users = await getUsers();
    if (!users || !Array.isArray(users) || users.length === 0) {
      console.warn('Warning: No users found. Visit /register to add users.');
      users = [];
    }
    users.forEach((user, index) => {
      if (!user.name) console.error(`Warning: User at index ${index} is missing "name" field`);
      if (!user.teamsWebhookUrl) console.error(`Warning: User "${user.name}" is missing "teamsWebhookUrl" field`);
    });
    console.log(`Loaded ${users.length} users`);
  } catch (error) {
    console.error('Error loading users:', error.message);
  }
  try {
    repos = await getRepos();
    if (repos.length) console.log(`Loaded ${repos.length} repos`);
  } catch (error) {
    console.error('Error loading repos:', error.message);
  }
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
  dataLoaded = true;
}

await loadData();

const app = express();

app.use(express.json());

// Basic auth for UI routes (only active when BASIC_AUTH_USER is set)
const OPEN_PATHS = ['/webhook', '/webhook/github', '/webhook/gitlab', '/health'];

app.use((req, res, next) => {
  const authUser = process.env.BASIC_AUTH_USER;
  const authPass = process.env.BASIC_AUTH_PASS;
  if (!authUser) return next();
  if (OPEN_PATHS.includes(req.path)) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="PR Comment Notifier"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === authUser && pass === authPass) return next();

  res.set('WWW-Authenticate', 'Basic realm="PR Comment Notifier"');
  return res.status(401).send('Invalid credentials');
});

// ── Repo tracking ──

async function addRepoIfNew(repoKey) {
  if (repos.includes(repoKey)) return;
  repos.push(repoKey);
  repos.sort();
  try {
    await dbPutRepo(repoKey);
    console.log(`New repo discovered and saved: ${repoKey}`);
  } catch (err) {
    console.error(`Failed to persist repo ${repoKey}:`, err.message);
  }
}

// ── Routes ──

app.get('/', (req, res) => {
  res.send(getLandingPage());
});

app.get('/register', (req, res) => {
  res.send(getRegistrationPage(BASE_URL));
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

    if (looksLikeOwnServerUrl(teamsWebhookUrl, BASE_URL)) {
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

    const updatedUsers = [...users, newUser];
    try {
      await putUser(newUser, updatedUsers);
    } catch (err) {
      console.error('Failed to save user:', err.message);
      return res.status(500).json({ error: 'Failed to save registration. Please try again or ask an admin to check the server logs.' });
    }

    users.push(newUser);

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
      await dbDeleteUser(removedUser.name, updatedUsers);
    } catch (err) {
      console.error('Failed to delete user:', err.message);
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
  res.send(getEditPage(BASE_URL));
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

    if (looksLikeOwnServerUrl(teamsWebhookUrl, BASE_URL)) {
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

    const updatedUsers = [...users];
    updatedUsers[userIndex] = updatedUser;

    try {
      await putUser(updatedUser, updatedUsers);
    } catch (err) {
      console.error('Failed to save user:', err.message);
      return res.status(500).json({ error: 'Failed to save changes. Ask an admin to check the server logs.' });
    }

    users[userIndex] = updatedUser;

    console.log(`User updated: ${updatedUser.name}`);
    res.json({ message: 'Settings saved! Changes take effect within about a minute.' });
  } catch (err) {
    console.error('Edit error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const webhookHandler = (req, res) => {
  handleWebhook(req, res, {
    users,
    addRepoIfNew,
    githubSecret: GITHUB_WEBHOOK_SECRET,
    gitlabToken: GITLAB_WEBHOOK_TOKEN
  });
};

app.post('/webhook', webhookHandler);
app.post('/webhook/github', webhookHandler);
app.post('/webhook/gitlab', webhookHandler);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    users: users.map(u => u.name),
    repos
  });
});

// Start server (skip in Lambda -- serverless-express handles it)
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`PR Comment Notifier running on port ${port}`);
    console.log(`Register: http://localhost:${port}/register`);
    console.log(`Webhook URL: http://localhost:${port}/webhook`);
    console.log(`Health check: http://localhost:${port}/health`);
  });
}

export { app };
