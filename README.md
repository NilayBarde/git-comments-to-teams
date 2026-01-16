# PR Comment Notifier

A self-hosted webhook server that receives GitHub PR and GitLab MR events and posts notifications to Microsoft Teams.

## Features

- **Multi-User Support** - Route notifications to different Teams channels per user
- **Comments on YOUR PRs/MRs** - Get notified when someone comments on your code
- **@Mentions** - Get notified when someone mentions you or your team (e.g., `@bet-squad-web`)
- **MR/PR Merged** - Get notified when your merge request is merged
- **Approvals & Changes Requested** - Get notified on PR reviews
- **Filters out self-comments** - No notifications for your own comments
- **Rich Adaptive Cards** - Beautiful formatting in Teams
- **GitHub + GitLab support** - Including enterprise instances

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd pr-comment-notifier
npm install
```

### 2. Configure Environment Variables

Create a `.env` file with your user configuration:

```bash
USERS_CONFIG='[{"name":"nilay","teamsWebhookUrl":"https://your-teams-webhook-url","github":{"username":"NilayBarde"},"gitlab":{"username":"nilay.barde","userId":12345},"mentionAliases":["frontend-team","bet-squad-web"]}]'

# Optional: webhook secrets for verification
GITHUB_WEBHOOK_SECRET=your-github-secret
GITLAB_WEBHOOK_TOKEN=your-gitlab-token
```

For multiple users, add more objects to the JSON array - each user gets their own Teams channel!

### 3. Deploy to Render (Recommended)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and sign up
3. Click **New** → **Web Service** → Connect your GitHub repo
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Add your environment variables in **Environment** tab
6. Deploy!

Your webhook URL will be: `https://your-app-name.onrender.com`

### 4. Set Up Webhooks

Configure webhooks in your GitLab/GitHub repos to point to your Render URL (see detailed instructions below).

---

## Notification Types

| Event | When You're Notified |
|-------|---------------------|
| **Comment** | Someone comments on YOUR MR/PR |
| **@Mention** | Someone @mentions you or your team alias in ANY MR/PR |
| **Approved** | YOUR MR/PR is approved by a reviewer ✅ |
| **Changes Requested** | A reviewer requests changes on YOUR MR/PR ⚠️ |
| **Merged** | YOUR MR/PR gets merged 🎉 |

---

## 🆕 New User? Start Here

Want to receive notifications? Follow these steps and send the info to the admin.

### Step 1: Create Your Teams Webhook

> **💡 Tip:** Create your own personal Team and Channel for these notifications! This keeps your PR alerts separate from work channels and gives you full control. Just click "Join or create a team" → "Create team" → "From scratch" → "Private", then add a channel for notifications.

1. Open **Microsoft Teams**
2. Click **Apps** (left sidebar) → Search **Workflows**
3. Click **Create** tab
4. Search for "**Send webhook alerts to a channel**" template
5. Click it and follow the setup:
   - Select your Team and Channel (use the personal one you created above!)
   - Give it a name (e.g., "My PR Notifications")
6. After saving, copy the **HTTP POST URL** - this is your webhook URL

### Step 2: Find Your Usernames & IDs

**GitHub Username:**

- Go to GitHub and look at your profile URL: `github.com/YOUR_USERNAME`

**GitLab Username:**

- Go to GitLab and look at your profile URL: `gitlab.com/YOUR_USERNAME`

**GitLab User ID (required for GitLab notifications):**

1. Log in to GitLab
2. Open browser Developer Tools (Cmd+Option+I or F12)
3. Go to **Console** tab
4. Type: `gon.current_user_id` and press Enter
5. That number is your User ID

### Step 3: Decide on Mention Aliases (Optional)

If you want to get notified when someone @mentions a team you're on, list those aliases.
For example, if people mention `@espn-core-web` and you want those notifications, include `"espn-core-web"`.

### Step 4: Send Your Info to the Admin

Copy this template and fill it out:

```
Name: [Your first name]
Teams Webhook URL: [paste your URL from Step 1]

GitHub Username: [your GitHub username, or leave blank if not using GitHub]

GitLab Username: [your GitLab username]
GitLab User ID: [the number from Step 2]

Mention Aliases (optional): [comma-separated list, e.g., "espn-core-web, bet-squad"]
```

The admin will create a config object like this and add you to the system:

```json
{
  "name": "yourname",
  "teamsWebhookUrl": "https://your-webhook-url",
  "github": { "username": "YourGitHubUsername" },
  "gitlab": { "username": "your.gitlab.username", "userId": 12345 },
  "mentionAliases": ["espn-core-web", "your-team"]
}
```

---

## Detailed Setup Instructions

### Setting Up Teams Webhook (Workflows)

> **Note**: Microsoft has deprecated classic "Incoming Webhook" connectors. Use Teams Workflows instead.

1. Open Microsoft Teams
2. Click **Apps** (left sidebar) → Search **Workflows**
3. Click **Create** tab
4. Search for "**Send webhook alerts to a channel**" template
5. Click it and follow the setup:
   - Select your Team and Channel
   - Give it a name (e.g., "PR Comment Alerts")
6. After saving, the workflow will show you the **HTTP POST URL**
7. Copy that URL - this is your `TEAMS_WEBHOOK_URL`

**Tip**: Create a private channel just for yourself if you want personal notifications.

### Finding Your GitLab User ID

The easiest way:

1. Go to your GitLab instance and log in
2. Open browser Developer Tools (Cmd+Option+I or F12)
3. Go to **Console** tab
4. Type: `gon.current_user_id`
5. Press Enter - that number is your User ID

Alternative via API:

```bash
curl "https://gitlab.com/api/v4/users?username=YOUR_USERNAME"
```

### Setting Up GitLab Webhook

1. Go to your GitLab **project** → **Settings** → **Webhooks**
   - (Or **group** settings to cover all projects in a group)
2. Configure:
   - **URL**: `https://your-app.onrender.com/webhook/gitlab`
   - **Secret token**: (optional) create a token and set `GITLAB_WEBHOOK_TOKEN`
   - **Trigger**:
     - ✅ **Comments** (for comment and @mention notifications)
     - ✅ **Merge request events** (for merge notifications)
   - **Enable SSL verification**: Yes
3. Click **Add webhook**
4. Click **Test** → **Note events** to verify

### Setting Up GitHub Webhook

1. Go to your GitHub **repository** → **Settings** → **Webhooks** → **Add webhook**
   - (Or **organization** settings for all repos)
2. Configure:
   - **Payload URL**: `https://your-app.onrender.com/webhook/github`
   - **Content type**: `application/json`
   - **Secret**: (optional) create a secret and set `GITHUB_WEBHOOK_SECRET`
   - **Events**: Select "Let me select individual events" then check:
     - ✅ **Issue comments** (for comments)
     - ✅ **Pull request review comments** (for code review comments)
     - ✅ **Pull request reviews** (for approvals and changes requested)
     - ✅ **Pull requests** (for merge notifications)
3. Click **Add webhook**

---

## Local Development

For local testing:

```bash
# Start the server
npm start

# Or with auto-reload
npm run dev
```

To test webhooks locally, use the test script:

```bash
node test-webhook.js gitlab
node test-webhook.js github
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `USERS_CONFIG` | Yes | JSON array of user configurations (see below) |
| `GITLAB_WEBHOOK_TOKEN` | No | Secret token for GitLab webhook verification |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for GitHub webhook signature verification |
| `PORT` | No | Server port (default: 3000) |

### USERS_CONFIG Structure

Each user in the `USERS_CONFIG` array has the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name for logging |
| `teamsWebhookUrl` | Yes | User's Teams Workflow webhook URL |
| `github.username` | For GitHub | GitHub username |
| `gitlab.username` | For GitLab | GitLab username |
| `gitlab.userId` | For GitLab | GitLab numeric user ID |
| `mentionAliases` | No | Array of team aliases to watch (e.g., `["frontend-team"]`) |

**Example with multiple users:**

```json
[
  {
    "name": "nilay",
    "teamsWebhookUrl": "https://...",
    "github": { "username": "NilayBarde" },
    "gitlab": { "username": "nilay.barde", "userId": 10957 },
    "mentionAliases": ["frontend-team"]
  },
  {
    "name": "john",
    "teamsWebhookUrl": "https://...",
    "github": { "username": "johndoe" },
    "gitlab": { "username": "john.doe", "userId": 12345 }
  }
]
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/github` | POST | Receives GitHub webhook events |
| `/webhook/gitlab` | POST | Receives GitLab webhook events |
| `/health` | GET | Health check endpoint |

---

## Troubleshooting

### Webhook not receiving events

1. Check Render logs for incoming requests
2. Verify the webhook URL is correct in GitHub/GitLab settings
3. Check webhook delivery logs in GitHub/GitLab for errors
4. Ensure SSL verification is enabled and your server has valid SSL (Render provides this)

### Getting "author not configured" errors

1. Check Render logs for the comparison - the PR/MR author isn't in your `USERS_CONFIG`
2. Verify `gitlab.userId` in your user config matches your actual GitLab user ID (check with `gon.current_user_id` in browser console)
3. For GitHub, verify `github.username` matches exactly (case-insensitive)

### Not receiving Teams notifications

1. Verify your Teams webhook URL is correct and the Workflow is active
2. Check Render logs for errors sending to Teams
3. Test the webhook URL manually:

   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"Test message"}]}}]}' \
     YOUR_TEAMS_WEBHOOK_URL
   ```

### @Mentions not working

1. Check that `mentionAliases` is set correctly in your user config (JSON array of strings)
2. Verify the alias matches exactly how it appears in GitLab/GitHub (e.g., `@bet-squad-web`)
3. Check Render logs for "Processing mention" messages

---

## Deployment Alternatives

### Render (Recommended)

- Free tier available
- Auto-deploys from GitHub
- Easy environment variable management

### Railway

- $5/month free credit
- Requires GitHub account verification
- No cold starts

### Fly.io

```bash
brew install flyctl
fly auth login
fly launch
fly secrets set USERS_CONFIG='[{"name":"you","teamsWebhookUrl":"https://...","gitlab":{"username":"you","userId":12345}}]'
```

### Local with ngrok (Testing only)

```bash
ngrok http 3000
# Use the generated URL for webhooks
```

---

## License

MIT
