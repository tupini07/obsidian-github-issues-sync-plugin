/**
 * Settings tab for the GitHub Issues Sync plugin
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type GitHubIssuesSyncPlugin from "./main";
import type { AuthMethod } from "./types";

export class SettingsTab extends PluginSettingTab {
  plugin: GitHubIssuesSyncPlugin;

  constructor(app: App, plugin: GitHubIssuesSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ========================================================================
    // Authentication Section
    // ========================================================================
    containerEl.createEl("h2", { text: "Authentication" });

    // Auth method selector
    new Setting(containerEl)
      .setName("Authentication method")
      .setDesc("Choose how to authenticate with GitHub")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("pat", "Personal Access Token (simpler)")
          .addOption("oauth", "GitHub App (device flow)")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async (value) => {
            this.plugin.settings.authMethod = value as AuthMethod;
            await this.plugin.saveSettings();
            // Re-render to show appropriate fields
            this.display();
          })
      );

    // Show auth method specific settings
    if (this.plugin.settings.authMethod === "pat") {
      this.renderPatSettings(containerEl);
    } else {
      this.renderOAuthSettings(containerEl);
    }

    new Setting(containerEl)
      .setName("GitHub Enterprise URL")
      .setDesc(
        "Leave empty for github.com. For GitHub Enterprise/EMU, enter the base URL (e.g., github.mycompany.com)"
      )
      .addText((text) =>
        text
          .setPlaceholder("github.com")
          .setValue(this.plugin.settings.githubBaseUrl)
          .onChange(async (value) => {
            // Remove protocol and trailing slashes
            let url = value.trim();
            url = url.replace(/^https?:\/\//, "");
            url = url.replace(/\/+$/, "");
            this.plugin.settings.githubBaseUrl = url;
            await this.plugin.saveSettings();
          })
      );

    // Auth status display
    const authStatusEl = containerEl.createDiv({ cls: "setting-item" });
    this.renderAuthStatus(authStatusEl);

    // ========================================================================
    // Project Configuration
    // ========================================================================
    containerEl.createEl("h2", { text: "Project Configuration" });

    new Setting(containerEl)
      .setName("Project URL")
      .setDesc(
        "Full URL to your GitHub Project (e.g., https://github.com/orgs/my-org/projects/14)"
      )
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/orgs/.../projects/...")
          .setValue(this.plugin.settings.projectUrl)
          .onChange(async (value) => {
            this.plugin.settings.projectUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ========================================================================
    // Folder Configuration
    // ========================================================================
    containerEl.createEl("h2", { text: "Folder Configuration" });

    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Folder in your vault where issues will be synced")
      .addText((text) =>
        text
          .setPlaceholder("GitHub Issues")
          .setValue(this.plugin.settings.syncFolder)
          .onChange(async (value) => {
            this.plugin.settings.syncFolder = value.trim() || "GitHub Issues";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Index file name")
      .setDesc("Name of the board/index file (without .md extension)")
      .addText((text) =>
        text
          .setPlaceholder("Board")
          .setValue(this.plugin.settings.indexFileName)
          .onChange(async (value) => {
            this.plugin.settings.indexFileName = value.trim() || "Board";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Issues folder")
      .setDesc("Subfolder for issue files (keeps the navigation cleaner)")
      .addText((text) =>
        text
          .setPlaceholder("_issues")
          .setValue(this.plugin.settings.issuesFolder)
          .onChange(async (value) => {
            this.plugin.settings.issuesFolder = value.trim() || "_issues";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc(
        "Subfolder for archived issues (issues no longer in current iteration)"
      )
      .addText((text) =>
        text
          .setPlaceholder("_archive")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim() || "_archive";
            await this.plugin.saveSettings();
          })
      );

    // ========================================================================
    // Sync Options
    // ========================================================================
    containerEl.createEl("h2", { text: "Sync Options" });

    new Setting(containerEl)
      .setName("Only sync my issues")
      .setDesc(
        "When enabled, only issues assigned to you will be synced. Otherwise, all issues in the iteration are synced."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.onlyMyIssues)
          .onChange(async (value) => {
            this.plugin.settings.onlyMyIssues = value;
            await this.plugin.saveSettings();
          })
      );

    // ========================================================================
    // Image Hosting Configuration
    // ========================================================================
    containerEl.createEl("h2", { text: "Image Hosting" });

    const imageInstructionsEl = containerEl.createEl("div", {
      cls: "setting-item-description",
    });
    imageInstructionsEl.style.marginBottom = "1em";
    imageInstructionsEl.innerHTML = `
      <p>When pushing issues, local images will be uploaded to a GitHub repository and referenced via raw URLs.</p>
      <p><strong>Setup:</strong> Create a repository to host images (can be private), then enter it below.</p>
    `;

    new Setting(containerEl)
      .setName("Image hosting repository")
      .setDesc(
        "Repository for uploading images (format: owner/repo). Leave empty to skip image uploads."
      )
      .addText((text) =>
        text
          .setPlaceholder("my-org/image-bucket")
          .setValue(this.plugin.settings.imageHostingRepo)
          .onChange(async (value) => {
            this.plugin.settings.imageHostingRepo = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image hosting branch")
      .setDesc("Branch to upload images to")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.imageHostingBranch)
          .onChange(async (value) => {
            this.plugin.settings.imageHostingBranch = value.trim() || "main";
            await this.plugin.saveSettings();
          })
      );
  }

  private renderAuthStatus(containerEl: HTMLElement): void {
    containerEl.empty();

    const authState = this.plugin.authState;
    const isLoggedIn = !!authState.accessToken;

    const settingEl = new Setting(containerEl).setName("Login status");

    if (isLoggedIn) {
      let statusDesc = `Logged in${authState.username ? ` as ${authState.username}` : ""}`;
      
      // TODO: Check if token is expired and warn user
      if (authState.expiresAt) {
        const expiresAt = new Date(authState.expiresAt);
        if (expiresAt < new Date()) {
          statusDesc += " (token expired - please re-login)";
        }
      }

      settingEl.setDesc(statusDesc).addButton((button) =>
        button
          .setButtonText("Logout")
          .setWarning()
          .onClick(async () => {
            await this.plugin.logout();
            this.renderAuthStatus(containerEl);
          })
      );
    } else {
      settingEl.setDesc("Not logged in").addButton((button) =>
        button.setButtonText("Login to GitHub").onClick(async () => {
          await this.plugin.login();
          this.renderAuthStatus(containerEl);
        })
      );
    }
  }

  private renderPatSettings(containerEl: HTMLElement): void {
    const instructionsEl = containerEl.createEl("div", {
      cls: "setting-item-description",
    });
    instructionsEl.style.marginBottom = "1em";
    instructionsEl.innerHTML = `
      <strong>PAT Setup:</strong>
      <ol style="margin: 0.5em 0; padding-left: 1.5em;">
        <li>Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens</li>
        <li>Create a new token with access to your organization</li>
        <li>Grant <strong>Read</strong> access to "Projects" and "Issues"</li>
        <li>Click "Login to GitHub" below and paste your token</li>
      </ol>
      <em>Note: Your org may require PATs to be renewed periodically (e.g., every 7 days).</em>
    `;
  }

  private renderOAuthSettings(containerEl: HTMLElement): void {
    const instructionsEl = containerEl.createEl("div", {
      cls: "setting-item-description",
    });
    instructionsEl.style.marginBottom = "1em";
    instructionsEl.innerHTML = `
      <strong>GitHub App Setup:</strong>
      <ol style="margin: 0.5em 0; padding-left: 1.5em;">
        <li>Create a <strong>GitHub App</strong> in your org settings</li>
        <li>Enable <strong>Device Flow</strong> in the app settings</li>
        <li>Grant <strong>Read</strong> permission for "Projects" and "Issues"</li>
        <li>Install the app on your organization (may need admin approval)</li>
        <li>Copy the <strong>Client ID</strong> below</li>
      </ol>
    `;

    new Setting(containerEl)
      .setName("GitHub App Client ID")
      .setDesc("The Client ID from your GitHub App settings page.")
      .addText((text) =>
        text
          .setPlaceholder("Iv1.abc123...")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
