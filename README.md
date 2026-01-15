# PR Comment Notifier

A self-hosted webhook server that receives GitHub PR and GitLab MR events and posts notifications to Microsoft Teams.

## Features

- **Comments on YOUR PRs/MRs** - Get notified when someone comments on your code
- **@Mentions** - Get notified when someone mentions you or your team (e.g., `@bet-squad-web`)
- **MR/PR Merged** - Get notified when your merge request is merged
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

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Teams webhook URL (required)
TEAMS_WEBHOOK_URL=https://your-webhook-url...

# GitLab config
GITLAB_USERNAME=your-gitlab-username
GITLAB_USER_ID=12345

# GitHub config  
GITHUB_USERNAME=your-github-username

# Team aliases to watch for @mentions (comma-separated)
MENTION_ALIASES=bet-squad-web,frontend-team

# Optional: for testing, set to 'true' to receive your own comments
ALLOW_SELF_COMMENTS=false
```

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
| **Merged** | YOUR MR/PR gets merged |

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
| `TEAMS_WEBHOOK_URL` | Yes | Your Teams Workflow webhook URL |
| `GITLAB_USERNAME` | For GitLab | Your GitLab username |
| `GITLAB_USER_ID` | For GitLab | Your GitLab numeric user ID |
| `GITLAB_WEBHOOK_TOKEN` | No | Secret token for webhook verification |
| `GITHUB_USERNAME` | For GitHub | Your GitHub username |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for webhook signature verification |
| `MENTION_ALIASES` | No | Comma-separated team aliases to watch (e.g., `bet-squad-web,frontend-team`) |
| `ALLOW_SELF_COMMENTS` | No | Set to `true` to receive your own comments (for testing) |
| `PORT` | No | Server port (default: 3000) |

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

### Getting "not your PR/MR" errors

1. Check Render logs for the comparison values:

   ```
   GitLab MR comparison: author_id="XXXXX" vs configured userId="YYYYY"
   ```

2. Verify `GITLAB_USER_ID` matches your actual user ID (check with `gon.current_user_id` in browser console)
3. For GitHub, verify `GITHUB_USERNAME` matches exactly (case-sensitive for some instances)

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

1. Check that `MENTION_ALIASES` is set correctly (comma-separated, no spaces around commas)
2. Verify the alias matches exactly how it appears in GitLab/GitHub (e.g., `@bet-squad-web`)
3. Check Render logs for "Mention detected" messages

### Testing with your own comments

Set `ALLOW_SELF_COMMENTS=true` in your environment variables to receive notifications for your own comments (useful for testing). Remember to remove this after testing!

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
fly secrets set TEAMS_WEBHOOK_URL=... GITLAB_USERNAME=... GITLAB_USER_ID=...
```

### Local with ngrok (Testing only)

```bash
ngrok http 3000
# Use the generated URL for webhooks
```

---

## License

MIT
