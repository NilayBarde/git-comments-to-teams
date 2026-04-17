# PR Comment Notifier

A self-hosted webhook server that receives GitHub PR and GitLab MR events and posts notifications to Microsoft Teams.

## Features

- **Multi-User Support** — Route notifications to different Teams channels per user
- **Comments on YOUR PRs/MRs** — Get notified when someone comments on your code
- **@Mentions** — Get notified when someone mentions you or your team alias (e.g., `@bet-squad-web`)
- **MR/PR Merged** — Get notified when your merge request is merged
- **Approvals & Changes Requested** — Get notified on PR reviews
- **Review Requests** — Get notified when you're assigned as a reviewer
- **Pipeline Failures** — Get notified when a pipeline fails on your GitLab MR (deduplicated — same failures won't spam you)
- **Pipeline Recovery** — Get notified when a previously failing pipeline is fixed
- **CODEOWNERS Review Requests** — Auto-assigned review requests show "CODEOWNERS" instead of bot usernames
- **Per-User Notification Preferences** — Toggle each notification type on/off from the settings page, linked from every card
- **Bot Comment Control** — Opt-in to SonarQube and project bot comment notifications (off by default)
- **Self-Activity Toggles** — Optionally receive notifications for your own comments, merges, and self-assigned reviews
- **Self-Service Registration** — Users register, edit settings, and unregister via web UI
- **Webhook Health Monitoring** — Tracks last webhook per repo and alerts admins if repos go silent
- **Unified Webhook Endpoint** — Auto-detects GitHub vs GitLab payloads
- **Rich Adaptive Cards** — Beautiful formatting in Teams
- **GitHub + GitLab support** — Including enterprise instances

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd pr-comment-notifier
npm install
```

### 2. Configure Environment Variables

Create a `.env` file. The persistence backend is auto-detected from available tokens, or set explicitly:

```bash
# Persistence backend: 'local' (default), 'github', or 'gitlab'
# PERSISTENCE_BACKEND=local

# GitHub backend — persist config by committing to a GitHub repo
GITHUB_TOKEN=ghp_your_personal_access_token
GITHUB_REPO=YourUsername/your-config-repo

# GitLab backend — persist config by committing to a GitLab repo
# GITLAB_TOKEN=your-gitlab-project-access-token
# GITLAB_PROJECT_ID=12345
# GITLAB_URL=https://gitlab.disney.com

# Optional — webhook secrets for verification
GITHUB_WEBHOOK_SECRET=your-github-secret
GITLAB_WEBHOOK_TOKEN=your-gitlab-token

# Optional — admin webhook for health alerts
ADMIN_WEBHOOK_URL=https://your-admin-teams-webhook-url
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

Configure webhooks in your GitLab/GitHub repos to point to your Render URL. You can use either:

- **Unified endpoint** (recommended): `https://your-app.onrender.com/webhook`
- **Source-specific**: `https://your-app.onrender.com/webhook/github` or `https://your-app.onrender.com/webhook/gitlab`

---

## Notification Types

| Event | When You're Notified | Default |
|-------|---------------------|---------|
| **Comment** | Someone comments on YOUR MR/PR | On |
| **@Mention** | Someone @mentions you or your team alias in ANY MR/PR | On |
| **Approved** | YOUR MR/PR is approved by a reviewer | On |
| **Changes Requested** | A reviewer requests changes on YOUR MR/PR | On |
| **Merged** | YOUR MR/PR gets merged | On |
| **Review Requested** | You're assigned as a reviewer on an MR/PR | On |
| **Pipeline Failed** | A pipeline fails on YOUR GitLab MR (deduplicated — same jobs failing won't re-notify) | On |
| **Pipeline Recovered** | A previously failing pipeline passes on YOUR GitLab MR | On |
| **CODEOWNERS Reviews** | You're auto-assigned as a reviewer by CODEOWNERS | On |
| **SonarQube Comments** | SonarQube analysis posts a comment on your MR | Off |
| **Project Bot Comments** | AI review / project bot posts a comment on your MR | Off |
| **Self-Comments** | Your own comments on your PRs/MRs | Off |
| **Self-Merges** | When you merge your own PRs/MRs | Off |
| **Self-Review Requests** | When you add yourself as a reviewer | Off |

All preferences are configurable per user from the **Edit Settings** page. Every notification card includes a "Notifications" button linking to the settings page.

### Pipeline Deduplication

Pipeline notifications are smart about avoiding spam:

- **Duplicate failures suppressed** — If the same jobs keep failing on a branch, you only get notified once. Push a fix that breaks different jobs? You'll get a new notification.
- **Recovery detection** — When a previously failing pipeline goes green, you get a "Pipeline Fixed!" notification.
- **Consecutive passes ignored** — Green pipeline stays green? No notification.
- **State persisted** — Pipeline state is tracked in `pipeline-state.json` and survives server restarts.
- **Auto-cleanup** — State is cleared when an MR is merged, when a pipeline recovers, or after 30 days of inactivity.

---

## Self-Service Registration

Users manage their own configuration through a web UI — no admin needed.

| Page | URL | Description |
|------|-----|-------------|
| **Register** | `/register` | Sign up with your webhook URL, usernames, and preferences |
| **Edit Settings** | `/edit` | Update your webhook URL, usernames, aliases, and notification preferences |
| **Unregister** | `/unregister` | Remove yourself from the system |

During registration, the server sends a test notification to verify the Teams webhook URL works before saving.

---

## User Configuration

Each user in `users.json` has the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name for logging |
| `teamsWebhookUrl` | Yes | User's Teams Workflow webhook URL |
| `github.username` | For GitHub | GitHub username |
| `gitlab.username` | For GitLab | GitLab username |
| `gitlab.userId` | For GitLab | GitLab numeric user ID |
| `mentionAliases` | No | Array of team aliases to watch (e.g., `["frontend-team"]`) |
| `notifications` | No | Notification preferences object (see below) |

### Notification Preferences

The optional `notifications` object controls which events trigger notifications. When absent, defaults apply:

```json
{
  "name": "nilay",
  "teamsWebhookUrl": "https://...",
  "gitlab": { "username": "Nilay.Barde", "userId": 10957 },
  "notifications": {
    "comments": true,
    "mentions": true,
    "approvals": true,
    "merges": true,
    "pipelineFailures": true,
    "pipelineRecoveries": true,
    "reviewRequests": true,
    "codeownerReviewRequests": true,
    "sonarComments": false,
    "aiReviewComments": false,
    "selfComments": false,
    "selfMerges": false,
    "selfReviewRequests": false
  }
}
```

---

## Setting Up Teams Webhook

> **Note**: Microsoft has deprecated classic "Incoming Webhook" connectors. Use Teams Workflows instead.

1. Open **Microsoft Teams**
2. Create your own Team and Channel for notifications (or use an existing one)
3. Click **Apps** (left sidebar) → Search **Workflows**
4. Click the **Create** tab
5. Search for "**Send webhook alerts to a channel**" template
6. Select your Team and Channel, give it a name (e.g., "PR Notifications")
7. After saving, click **Copy webhook link** — that's your webhook URL

**Tip**: Create a private channel just for yourself if you want personal notifications.

## Finding Your GitLab User ID

The easiest way:

1. Go to your GitLab instance and log in
2. Open browser Developer Tools (Cmd+Option+I or F12)
3. Go to **Console** tab
4. Type: `gon.current_user_id`
5. Press Enter — that number is your User ID

Alternative via API:

```bash
curl "https://gitlab.com/api/v4/users?username=YOUR_USERNAME"
```

## Setting Up GitLab Webhook

1. Go to your GitLab **project** → **Settings** → **Webhooks**
   - (Or **group** settings to cover all projects in a group)
2. Configure:
   - **URL**: `https://your-app.onrender.com/webhook`
   - **Secret token**: (optional) create a token and set `GITLAB_WEBHOOK_TOKEN`
   - **Trigger**:
     - ✅ **Comments** (for comment and @mention notifications)
     - ✅ **Merge request events** (for merge, approval, and review request notifications)
     - ✅ **Pipeline events** (for pipeline failure/success notifications)
   - **Enable SSL verification**: Yes
3. Click **Add webhook**
4. Click **Test** → **Note events** to verify

## Setting Up GitHub Webhook

1. Go to your GitHub **repository** → **Settings** → **Webhooks** → **Add webhook**
   - (Or **organization** settings for all repos)
2. Configure:
   - **Payload URL**: `https://your-app.onrender.com/webhook`
   - **Content type**: `application/json`
   - **Secret**: (optional) create a secret and set `GITHUB_WEBHOOK_SECRET`
   - **Events**: Select "Let me select individual events" then check:
     - ✅ **Issue comments** (for comments)
     - ✅ **Pull request review comments** (for code review comments)
     - ✅ **Pull request reviews** (for approvals and changes requested)
     - ✅ **Pull requests** (for merge and review request notifications)
3. Click **Add webhook**

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Unified webhook — auto-detects GitHub vs GitLab |
| `/webhook/github` | POST | Receives GitHub webhook events |
| `/webhook/gitlab` | POST | Receives GitLab webhook events |
| `/register` | GET | Registration page |
| `/register` | POST | Register a new user |
| `/edit` | GET | Edit settings page |
| `/edit` | POST | Update user settings |
| `/unregister` | GET | Unregister page |
| `/unregister` | POST | Remove a user |
| `/api/user/:gitlabUsername` | GET | Fetch user config (used by edit page) |
| `/health` | GET | Health check with per-repo webhook timestamps |

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `PERSISTENCE_BACKEND` | No | `local` (default), `github`, or `gitlab`. Auto-detected from available tokens if not set. |
| `GITHUB_TOKEN` | `github` backend | GitHub personal access token for committing config changes |
| `GITHUB_REPO` | `github` backend | GitHub repo for persisting config (e.g., `NilayBarde/git-comments-to-teams`) |
| `GITLAB_TOKEN` | `gitlab` backend | GitLab project access token for committing config changes |
| `GITLAB_PROJECT_ID` | `gitlab` backend | GitLab project ID (numeric) for the config repo |
| `GITLAB_URL` | `gitlab` backend | GitLab instance URL (default: `https://gitlab.com`) |
| `GITLAB_WEBHOOK_TOKEN` | No | Secret token for GitLab webhook verification |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for GitHub webhook signature verification |
| `ADMIN_WEBHOOK_URL` | No | Teams webhook URL for admin health alerts |
| `PORT` | No | Server port (default: 3000) |

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

### Docker

Build and run with Docker:

```bash
docker build -t pr-comment-notifier .
docker run -p 3000:3000 --env-file .env pr-comment-notifier
```

For persistent local storage, mount a volume for the data files:

```bash
docker run -p 3000:3000 --env-file .env \
  -v $(pwd)/users.json:/app/users.json \
  -v $(pwd)/repos.json:/app/repos.json \
  -v $(pwd)/pipeline-state.json:/app/pipeline-state.json \
  pr-comment-notifier
```

---

## Troubleshooting

### Webhook not receiving events

1. Check Render logs for incoming requests
2. Verify the webhook URL is correct in GitHub/GitLab settings
3. Check webhook delivery logs in GitHub/GitLab for errors
4. Ensure SSL verification is enabled and your server has valid SSL (Render provides this)

### Getting "author not configured" errors

1. Check Render logs for the comparison — the PR/MR author isn't in your user config
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

### Notifications you don't want

Visit the **Edit Settings** page (`/edit`) and uncheck the notification types you want to disable.

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
fly secrets set GITHUB_TOKEN='ghp_...' GITHUB_REPO='YourUser/your-repo'
```

### Local with ngrok (Testing only)

```bash
ngrok http 3000
# Use the generated URL for webhooks
```

---

## License

MIT
