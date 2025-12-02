# GitHub Issues Sync

Sync GitHub Project issues to your Obsidian vault. Pull issues as markdown files, edit them with Obsidian's full editing experience, and push changes back to GitHub.

This is useful if you want to work on issue descriptions using Obsidian's linking, backlinks, and markdown features. The plugin syncs issues from a GitHub Project's current iteration, so it works nicely with sprint-based workflows.

## Features

- **Pull issues** from a GitHub Project (v2) into your vault as markdown files
- **Push edits** back to GitHub - change issue descriptions right from Obsidian
- **Iteration-aware** - automatically syncs issues from the current iteration
- **Filter by assignee** - optionally sync only issues assigned to you
- **Index file** - generates a board view grouped by status columns
- **Archive old issues** - move issues from past iterations to an archive folder
- **Image uploads** - local images get uploaded to a GitHub repo when pushing
- **Open in GitHub** - quick command to jump to the issue on GitHub
- **GitHub Enterprise support** - works with self-hosted GitHub instances

## Setup

### Authentication

The plugin supports two authentication methods:

**Personal Access Token (simpler)**
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a token with access to your organization/repos
3. Grant **Read and Write** access to "Issues" and **Read** access to "Projects"
4. Use the "Login to GitHub" command and paste your token

**GitHub App (device flow)**
1. Create a GitHub App in your org settings with Device Flow enabled
2. Grant Read permission for "Projects" and Read/Write for "Issues"
3. Install the app on your organization
4. Enter the Client ID in plugin settings
5. Use the "Login to GitHub" command and follow the browser flow

### Configuration

1. Set your **Project URL** - the full URL to your GitHub Project (e.g., `https://github.com/orgs/my-org/projects/14`)
2. Configure the **Sync folder** - where issues will be stored in your vault (default: `GitHub Issues`)
3. Optionally set up **Image hosting** - a GitHub repo where local images will be uploaded when pushing issues. This is necessary because as far as I could find, there's no way to directly manage the `user-attachments` of issues via the API. It's a bit hacky, but works alright.

## Commands

| Command | Description |
|---------|-------------|
| **Login to GitHub** | Authenticate with GitHub |
| **Logout from GitHub** | Clear your authentication |
| **Sync project (pull from GitHub)** | Pull all issues from the current iteration |
| **Sync current issue (push to GitHub)** | Push changes from the current file to GitHub |
| **Clean up old issues (archive)** | Move issues no longer in the iteration to archive |
| **Open current issue in GitHub** | Open the issue in your browser |

## Folder Structure

```
GitHub Issues/
├── Board.md              # Index file with issues grouped by status
├── _issues/
│   ├── 123-issue-title.md
│   ├── 124-another-issue.md
│   └── ...
└── _archive/             # Old issues get moved here
    └── ...
```

Each issue file contains frontmatter with the GitHub URL, and the body is the issue description in markdown.

## Image Handling

When you push an issue that contains local images (like `![[screenshot.png]]` or `![](path/to/image.png)`), the plugin will:

1. Upload the images to a GitHub repository you specify
2. Replace local paths with GitHub raw URLs in the pushed content
3. Keep the local paths in a hidden comment so they restore when you pull again

To enable this, set an **Image hosting repository** in settings (format: `owner/repo`).

## Notes

- The plugin uses GitHub's GraphQL API, so it needs appropriate token scopes
- Only issues (not draft issues or PRs) are synced
- Status field and iterations are read from your Project's configuration
- Works on mobile too (not desktop-only)

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```
