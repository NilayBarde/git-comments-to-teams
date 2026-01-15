# PR Comment Notifier

A self-hosted webhook server that receives GitHub PR and GitLab MR comments and posts notifications to Microsoft Teams.

## Features

- Real-time notifications for comments on YOUR PRs/MRs only
- Filters out your own comments (no self-notifications)
- Rich Adaptive Card formatting in Teams
- Support for both GitHub and GitLab
- Webhook signature/token verification for security

## Quick Start

### 1. Install Dependencies

```bash
cd pr-comment-notifier
npm install
```

### 2. Create Configuration

```bash
cp config.example.json config.json
```

Edit `config.json` with your values:

```json
{
  "port": 3000,
  "teamsWebhookUrl": "YOUR_TEAMS_INCOMING_WEBHOOK_URL",
  "github": {
    "username": "YOUR_GITHUB_USERNAME",
    "webhookSecret": "YOUR_GITHUB_WEBHOOK_SECRET"
  },
  "gitlab": {
    "username": "YOUR_GITLAB_USERNAME",
    "userId": 12345,
    "webhookToken": "YOUR_GITLAB_WEBHOOK_TOKEN"
  }
}
```

### 3. Start the Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

## Setup Instructions

### Setting Up Teams Incoming Webhook

1. Open Microsoft Teams
2. Go to the channel where you want notifications
3. Click the `...` menu next to the channel name
4. Select **Connectors** (or **Workflows** > **Create a workflow**)
5. Search for **Incoming Webhook**
6. Click **Configure**
7. Give it a name (e.g., "PR Comments") and optionally upload an image
8. Click **Create**
9. Copy the webhook URL and paste it into your `config.json` as `teamsWebhookUrl`

### Setting Up GitHub Webhook

1. Go to your GitHub repository (or organization settings for all repos)
2. Navigate to **Settings** > **Webhooks** > **Add webhook**
3. Configure:
   - **Payload URL**: `https://your-server.com/webhook/github`
   - **Content type**: `application/json`
   - **Secret**: Create a secret and add it to your `config.json` as `github.webhookSecret`
   - **SSL verification**: Enable if using HTTPS
   - **Events**: Select "Let me select individual events" then check:
     - **Issue comments**
     - **Pull request review comments**
4. Click **Add webhook**

### Setting Up GitLab Webhook

1. Go to your GitLab project (or group settings for all projects)
2. Navigate to **Settings** > **Webhooks**
3. Configure:
   - **URL**: `https://your-server.com/webhook/gitlab`
   - **Secret token**: Create a token and add it to your `config.json` as `gitlab.webhookToken`
   - **Trigger**: Check **Comments** (Note events)
   - **Enable SSL verification**: Yes (if using HTTPS)
4. Click **Add webhook**

### Finding Your GitLab User ID

1. Go to your GitLab profile page
2. Look at the URL: `https://gitlab.com/users/your-username`
3. Or check the page - your ID is usually displayed on your profile
4. You can also use the API: `curl "https://gitlab.com/api/v4/users?username=YOUR_USERNAME"`

## Exposing to the Internet

For GitHub/GitLab to send webhooks to your server, it needs to be accessible from the internet. Options:

### Option A: ngrok (for testing)

```bash
ngrok http 3000
```

Use the generated URL (e.g., `https://abc123.ngrok.io`) as your webhook URL.

### Option B: Deploy to a Cloud Service

- **Heroku**: Free tier available
- **Railway**: Easy deployment
- **Render**: Free tier available
- **AWS/GCP/Azure**: For production use

### Option C: Use Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/github` | POST | Receives GitHub webhook events |
| `/webhook/gitlab` | POST | Receives GitLab webhook events |
| `/health` | GET | Health check endpoint |

## Troubleshooting

### Webhook not receiving events

1. Check that your server is accessible from the internet
2. Verify the webhook URL is correct in GitHub/GitLab settings
3. Check the webhook delivery logs in GitHub/GitLab for errors

### Not receiving Teams notifications

1. Verify your Teams webhook URL is correct
2. Check server logs for errors
3. Test the webhook URL manually:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"Test message"}]}}]}' \
     YOUR_TEAMS_WEBHOOK_URL
   ```

### Notifications for wrong PRs

1. Verify your username is correct in `config.json`
2. For GitLab, ensure both `username` and `userId` are correct
3. Check that usernames are lowercase (GitHub) or match exactly (GitLab)

## License

MIT
