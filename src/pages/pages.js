const TOGGLE_CSS = `
  .toggle { display: flex; align-items: center; gap: .5rem; font-weight: 400; font-size: .9rem; margin-bottom: .5rem; cursor: pointer; }
  .toggle input[type="checkbox"] { width: 1rem; height: 1rem; cursor: pointer; }`;

const NOTIF_CHECKBOXES_HTML = `
    <div class="field">
      <label>Notification Preferences</label>
      <div class="hint">Choose which events you want to be notified about</div>
      <label class="toggle"><input type="checkbox" id="notif-comments" checked> Comments on your PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-mentions" checked> @mentions in comments</label>
      <label class="toggle"><input type="checkbox" id="notif-approvals" checked> Approvals and change requests</label>
      <label class="toggle"><input type="checkbox" id="notif-merges" checked> PRs/MRs merged</label>
      <label class="toggle"><input type="checkbox" id="notif-pipelineFailures" checked> Pipeline failures</label>
      <label class="toggle"><input type="checkbox" id="notif-pipelineRecoveries" checked> Pipeline recovered (fixed after failure)</label>
      <label class="toggle"><input type="checkbox" id="notif-reviewRequests" checked> Review requests</label>
      <label class="toggle"><input type="checkbox" id="notif-codeownerReviewRequests" checked> CODEOWNERS auto-assigned review requests</label>
      <hr style="margin:.75rem 0;border:none;border-top:1px solid #e0e0e0">
      <div class="hint">Bot comments (off by default)</div>
      <label class="toggle"><input type="checkbox" id="notif-sonarComments"> SonarQube analysis comments</label>
      <label class="toggle"><input type="checkbox" id="notif-aiReviewComments"> AI review / project bot comments</label>
      <hr style="margin:.75rem 0;border:none;border-top:1px solid #e0e0e0">
      <div class="hint">Self-activity (off by default)</div>
      <label class="toggle"><input type="checkbox" id="notif-selfComments"> Your own comments on your PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-selfMerges"> When you merge your own PRs/MRs</label>
      <label class="toggle"><input type="checkbox" id="notif-selfReviewRequests"> When you add yourself as a reviewer</label>
    </div>`;

const NOTIF_COLLECT_JS = `{
          comments: document.getElementById('notif-comments').checked,
          mentions: document.getElementById('notif-mentions').checked,
          approvals: document.getElementById('notif-approvals').checked,
          merges: document.getElementById('notif-merges').checked,
          pipelineFailures: document.getElementById('notif-pipelineFailures').checked,
          pipelineRecoveries: document.getElementById('notif-pipelineRecoveries').checked,
          reviewRequests: document.getElementById('notif-reviewRequests').checked,
          codeownerReviewRequests: document.getElementById('notif-codeownerReviewRequests').checked,
          sonarComments: document.getElementById('notif-sonarComments').checked,
          aiReviewComments: document.getElementById('notif-aiReviewComments').checked,
          selfComments: document.getElementById('notif-selfComments').checked,
          selfMerges: document.getElementById('notif-selfMerges').checked,
          selfReviewRequests: document.getElementById('notif-selfReviewRequests').checked
        }`;

function getRegistrationPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Sign Up</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 1.25rem; }
  .card h2 { font-size: 1.05rem; margin-bottom: .75rem; }
  details summary { cursor: pointer; font-weight: 600; font-size: .95rem; padding: .5rem 0; }
  details[open] summary { margin-bottom: .5rem; }
  .steps { padding-left: 1.25rem; }
  .steps li { margin-bottom: .5rem; line-height: 1.5; font-size: .9rem; color: #333; }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"], input[type="url"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #4f6ef7; box-shadow: 0 0 0 3px rgba(79,110,247,.12); }
  .field { margin-bottom: 1rem; }
  .field:last-child { margin-bottom: 0; }
  button { width: 100%; padding: .7rem; background: #4f6ef7; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #3b5de7; }
  button:disabled { background: #a0b0f0; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
  .optional-tag { font-weight: 400; color: #999; font-size: .8rem; }
  ${TOGGLE_CSS}
</style>
</head>
<body>
<div class="container">
  <h1>PR Comment Notifier</h1>
  <p class="subtitle">Sign up to get Teams notifications for comments, reviews, merges, and pipeline events on your MRs/PRs.</p>
  <div style="font-size:.85rem;margin-bottom:1rem"><a href="/" style="color:#4f6ef7;text-decoration:none">Home</a> · <a href="/edit" style="color:#4f6ef7;text-decoration:none">Edit settings</a> · <a href="/unregister" style="color:#4f6ef7;text-decoration:none">Unregister</a></div>

  <div class="card">
    <details>
      <summary>How to create your Teams Webhook URL</summary>
      <ol class="steps">
        <li>Open <strong>Microsoft Teams</strong></li>
        <li>Create a private Team &amp; Channel for your notifications (or use an existing one)</li>
        <li>Click <strong>Apps</strong> (left sidebar) → search <strong>Workflows</strong></li>
        <li>Click the <strong>Create</strong> tab</li>
        <li>Search for "<strong>Send webhook alerts to a channel</strong>" and select it</li>
        <li>Choose your Team and Channel, give it a name (e.g. "PR Notifications")</li>
        <li>After saving, click <strong>Copy webhook link</strong> — that's your webhook URL</li>
      </ol>
    </details>
  </div>

  <form id="regForm" class="card">
    <h2>Your Details</h2>

    <div class="field">
      <label for="teamsWebhookUrl">Teams Webhook URL</label>
      <div class="hint">The URL you copied from the Workflows step above</div>
      <input type="url" id="teamsWebhookUrl" name="teamsWebhookUrl" placeholder="https://..." required>
    </div>

    <div class="field">
      <label for="gitlabUsername">GitLab Username <span class="optional-tag">optional</span></label>
      <div class="hint">Go to <a href="https://gitlab.disney.com/-/user_settings/profile" target="_blank" style="color:#4f6ef7">your GitLab profile</a> — your username is shown under your name (e.g. @Nilay.Barde)</div>
      <input type="text" id="gitlabUsername" name="gitlabUsername" placeholder="e.g. Nilay.Barde">
    </div>

    <div class="field">
      <label for="gitlabUserId">GitLab User ID <span class="optional-tag">required if GitLab username is set</span></label>
      <details style="margin-bottom:.5rem"><summary style="font-size:.8rem;color:#4f6ef7;cursor:pointer;font-weight:400">How do I find my GitLab User ID?</summary><ol class="steps" style="margin-top:.5rem"><li>Go to <a href="https://gitlab.disney.com" target="_blank" style="color:#4f6ef7">gitlab.disney.com</a> (must be on VPN)</li><li>Open Developer Tools (Cmd+Option+I or F12)</li><li>Go to the <strong>Console</strong> tab</li><li>Type <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">gon.current_user_id</code> and press Enter</li><li>The number shown is your User ID</li></ol></details>
      <input type="text" id="gitlabUserId" name="gitlabUserId" placeholder="e.g. 10957" inputmode="numeric">
    </div>

    <div class="field">
      <label for="githubUsername">GitHub Username <span class="optional-tag">optional</span></label>
      <input type="text" id="githubUsername" name="githubUsername" placeholder="e.g. NilayBarde">
    </div>

    <div class="field">
      <label for="mentionAliases">Mention Aliases <span class="optional-tag">optional, comma-separated</span></label>
      <div class="hint">Team aliases you want to be notified for (without the @), e.g. espn-core-web</div>
      <input type="text" id="mentionAliases" name="mentionAliases" placeholder="e.g. espn-core-web, bet-squad">
    </div>

    ${NOTIF_CHECKBOXES_HTML}

    <button type="submit" id="submitBtn">Sign Up</button>
    <div id="msg"></div>
  </form>
</div>

<script>
document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = 'Registering…';
  msg.className = 'msg';
  msg.textContent = '';

  const webhookUrl = document.getElementById('teamsWebhookUrl').value.trim();
  const gitlabUser = document.getElementById('gitlabUsername').value.trim();
  const gitlabId = document.getElementById('gitlabUserId').value.trim();
  const githubUser = document.getElementById('githubUsername').value.trim();
  const strip = s => s.trim().replace(/^@/, '');
  const aliases = document.getElementById('mentionAliases').value
    .split(',').map(strip).filter(Boolean);

  try {
    let parsedOk = false;
    try {
      const host = new URL(webhookUrl).hostname;
      parsedOk = true;
      if (host.endsWith('onrender.com') || host === 'localhost' || host === new URL('${baseUrl}').hostname) {
        throw new Error('That looks like this server\\x27s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate — see the instructions above.');
      }
    } catch (urlErr) {
      if (parsedOk) throw urlErr;
      throw new Error('Please enter a valid URL for the Teams webhook.');
    }

    if (!gitlabUser && !githubUser) {
      throw new Error('Please enter at least one username (GitLab or GitHub).');
    }
    if (gitlabUser && !gitlabId) {
      throw new Error('GitLab User ID is required when a GitLab username is provided.');
    }
    if (gitlabId && isNaN(Number(gitlabId))) {
      throw new Error('GitLab User ID must be a number (e.g. 12345).');
    }

    const res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamsWebhookUrl: webhookUrl,
        gitlabUsername: gitlabUser,
        gitlabUserId: gitlabId,
        githubUsername: githubUser,
        mentionAliases: aliases,
        notifications: ${NOTIF_COLLECT_JS}
      })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Done!';
    } else {
      throw new Error(data.error || 'Registration failed');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Sign Up';
  }
});
</script>
</body>
</html>`;
}

function getUnregisterPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Unsubscribe</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #e45; box-shadow: 0 0 0 3px rgba(228,68,85,.12); }
  .field { margin-bottom: 1rem; }
  button { width: 100%; padding: .7rem; background: #e44; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #c33; }
  button:disabled { background: #e9a; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
</style>
</head>
<body>
<div class="container">
  <h1>Unsubscribe</h1>
  <p class="subtitle">Remove yourself from PR Comment Notifier. You'll stop receiving Teams notifications.</p>
  <div style="font-size:.85rem;margin-bottom:1rem"><a href="/" style="color:#4f6ef7;text-decoration:none">Home</a> · <a href="/register" style="color:#4f6ef7;text-decoration:none">Register</a> · <a href="/edit" style="color:#4f6ef7;text-decoration:none">Edit settings</a></div>
  <form id="unregForm" class="card">
    <div class="field">
      <label for="gitlabUsername">Your GitLab Username</label>
      <div class="hint">The GitLab username you registered with (e.g. Nilay.Barde)</div>
      <input type="text" id="gitlabUsername" name="gitlabUsername" placeholder="e.g. Nilay.Barde" required>
    </div>
    <button type="submit" id="submitBtn">Unsubscribe</button>
    <div id="msg"></div>
  </form>
</div>
<script>
document.getElementById('unregForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = 'Removing…';
  msg.className = 'msg';
  msg.textContent = '';
  try {
    const res = await fetch('/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitlabUsername: document.getElementById('gitlabUsername').value.trim() })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Done';
    } else {
      throw new Error(data.error || 'Failed to unsubscribe');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Unsubscribe';
  }
});
</script>
</body>
</html>`;
}

function getEditPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier — Edit Settings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 1.25rem; }
  label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .35rem; color: #333; }
  .hint { font-size: .8rem; color: #777; margin-bottom: .5rem; }
  input[type="text"], input[type="url"] { width: 100%; padding: .6rem .75rem; border: 1px solid #d0d0d0; border-radius: 8px; font-size: .9rem; transition: border-color .15s; }
  input:focus { outline: none; border-color: #4f6ef7; box-shadow: 0 0 0 3px rgba(79,110,247,.12); }
  input:read-only { background: #f5f5f5; color: #888; }
  .field { margin-bottom: 1rem; }
  button { width: 100%; padding: .7rem; background: #4f6ef7; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: #3b5de7; }
  button:disabled { background: #a0b0f0; cursor: not-allowed; }
  .msg { margin-top: 1rem; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; line-height: 1.5; }
  .msg.success { background: #e6f9ed; color: #1a7a3a; }
  .msg.error { background: #fde8e8; color: #b91c1c; }
  .optional-tag { font-weight: 400; color: #999; font-size: .8rem; }
  .hidden { display: none; }
  .nav { font-size: .85rem; margin-bottom: 1rem; }
  .nav a { color: #4f6ef7; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  ${TOGGLE_CSS}
</style>
</head>
<body>
<div class="container">
  <h1>Edit Settings</h1>
  <p class="subtitle">Update your PR Comment Notifier configuration.</p>
  <div class="nav"><a href="/">Home</a> · <a href="/register">Register</a> · <a href="/unregister">Unregister</a></div>

  <div id="lookupCard" class="card">
    <div class="field">
      <label for="lookupUsername">Your GitLab Username</label>
      <input type="text" id="lookupUsername" placeholder="e.g. Nilay.Barde" required>
    </div>
    <button id="lookupBtn" onclick="lookupUser()">Look Up</button>
    <div id="lookupMsg"></div>
  </div>

  <form id="editForm" class="card hidden">
    <div class="field">
      <label>GitLab Username</label>
      <input type="text" id="gitlabUsername" readonly>
    </div>

    <div class="field">
      <label for="teamsWebhookUrl">Teams Webhook URL</label>
      <input type="url" id="teamsWebhookUrl" required>
    </div>

    <div class="field">
      <label for="githubUsername">GitHub Username <span class="optional-tag">optional</span></label>
      <input type="text" id="githubUsername" placeholder="e.g. NilayBarde">
    </div>

    <div class="field">
      <label for="mentionAliases">Mention Aliases <span class="optional-tag">optional, comma-separated</span></label>
      <div class="hint">Team aliases you want to be notified for (without the @), e.g. espn-core-web</div>
      <input type="text" id="mentionAliases" placeholder="e.g. espn-core-web, bet-squad">
    </div>

    ${NOTIF_CHECKBOXES_HTML}

    <button type="submit" id="saveBtn">Save Changes</button>
    <div id="editMsg"></div>
  </form>
</div>

<script>
async function lookupUser() {
  const btn = document.getElementById('lookupBtn');
  const msg = document.getElementById('lookupMsg');
  const username = document.getElementById('lookupUsername').value.trim();
  if (!username) return;
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  msg.className = 'msg';
  msg.textContent = '';
  try {
    const res = await fetch('/api/user/' + encodeURIComponent(username));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'User not found');
    document.getElementById('gitlabUsername').value = data.gitlab?.username || '';
    document.getElementById('teamsWebhookUrl').value = data.teamsWebhookUrl || '';
    document.getElementById('githubUsername').value = data.github?.username || '';
    document.getElementById('mentionAliases').value = (data.mentionAliases || []).join(', ');
    const notifs = data.notifications || {};
    document.getElementById('notif-comments').checked = notifs.comments !== false;
    document.getElementById('notif-mentions').checked = notifs.mentions !== false;
    document.getElementById('notif-approvals').checked = notifs.approvals !== false;
    document.getElementById('notif-merges').checked = notifs.merges !== false;
    document.getElementById('notif-pipelineFailures').checked = notifs.pipelineFailures !== false;
    document.getElementById('notif-pipelineRecoveries').checked = notifs.pipelineRecoveries !== false;
    document.getElementById('notif-reviewRequests').checked = notifs.reviewRequests !== false;
    document.getElementById('notif-codeownerReviewRequests').checked = notifs.codeownerReviewRequests !== false;
    document.getElementById('notif-sonarComments').checked = notifs.sonarComments === true;
    document.getElementById('notif-aiReviewComments').checked = notifs.aiReviewComments === true;
    document.getElementById('notif-selfComments').checked = notifs.selfComments === true;
    document.getElementById('notif-selfMerges').checked = notifs.selfMerges === true;
    document.getElementById('notif-selfReviewRequests').checked = notifs.selfReviewRequests === true;
    document.getElementById('lookupCard').classList.add('hidden');
    document.getElementById('editForm').classList.remove('hidden');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Look Up';
  }
}

document.getElementById('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
  const msg = document.getElementById('editMsg');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msg.className = 'msg';
  msg.textContent = '';
  const webhookUrl = document.getElementById('teamsWebhookUrl').value.trim();
  const strip = s => s.trim().replace(/^@/, '');
  const aliases = document.getElementById('mentionAliases').value
    .split(',').map(strip).filter(Boolean);
  try {
    let parsedOk = false;
    try {
      const host = new URL(webhookUrl).hostname;
      parsedOk = true;
      if (host.endsWith('onrender.com') || host === 'localhost' || host === new URL('${baseUrl}').hostname) {
        throw new Error('That looks like this server\\x27s URL, not a Teams webhook URL. Please paste the workflow URL from Power Automate.');
      }
    } catch (urlErr) {
      if (parsedOk) throw urlErr;
      throw new Error('Please enter a valid URL for the Teams webhook.');
    }

    const res = await fetch('/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gitlabUsername: document.getElementById('gitlabUsername').value.trim(),
        teamsWebhookUrl: webhookUrl,
        githubUsername: document.getElementById('githubUsername').value.trim(),
        mentionAliases: aliases,
        notifications: ${NOTIF_COLLECT_JS}
      })
    });
    const data = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = data.message;
      btn.textContent = 'Saved!';
    } else {
      throw new Error(data.error || 'Save failed');
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
});
</script>
</body>
</html>`;
}

function getLandingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Comment Notifier</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; color: #1a1a2e; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
  .container { max-width: 540px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .subtitle { color: #555; margin-bottom: 1.5rem; font-size: .95rem; line-height: 1.5; }
  .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 1.25rem; }
  .card h2 { font-size: 1.05rem; margin-bottom: .5rem; }
  .card p { font-size: .9rem; color: #555; line-height: 1.5; margin-bottom: .75rem; }
  .card a { display: inline-block; padding: .5rem 1rem; background: #4f6ef7; color: #fff; border-radius: 8px; font-size: .9rem; font-weight: 600; text-decoration: none; transition: background .15s; }
  .card a:hover { background: #3b5de7; }
  .features { margin-top: .25rem; }
  .features li { font-size: .85rem; color: #444; line-height: 1.6; margin-bottom: .25rem; list-style: none; }
  .features li::before { content: "✓ "; color: #4f6ef7; font-weight: 700; }
  .footer { text-align: center; font-size: .8rem; color: #999; margin-top: .5rem; }
  .footer a { color: #4f6ef7; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <h1>PR Comment Notifier</h1>
  <p class="subtitle">Get Microsoft Teams notifications for comments, reviews, merges, and pipeline events on your GitHub PRs and GitLab MRs.</p>

  <div class="card">
    <h2>New here?</h2>
    <p>Sign up with your Teams webhook URL and choose which notifications you want.</p>
    <a href="/register">Register</a>
  </div>

  <div class="card">
    <h2>Already registered?</h2>
    <p>Update your webhook URL, usernames, aliases, or notification preferences.</p>
    <a href="/edit">Edit Settings</a>
  </div>

  <div class="card">
    <h2>Want to leave?</h2>
    <p>Remove yourself from the notification system.</p>
    <a href="/unregister">Unregister</a>
  </div>

  <div class="card">
    <h2>What you get</h2>
    <ul class="features">
      <li>Comments and @mentions on your MRs/PRs</li>
      <li>Approvals and changes requested</li>
      <li>Merge notifications</li>
      <li>Review request assignments</li>
      <li>Pipeline failures with smart deduplication</li>
      <li>Pipeline recovery alerts when builds are fixed</li>
      <li>Per-notification type toggles</li>
    </ul>
  </div>

  <p class="footer"><a href="/health">Health check</a></p>
</div>
</body>
</html>`;
}

export {
  getRegistrationPage,
  getUnregisterPage,
  getEditPage,
  getLandingPage
};
