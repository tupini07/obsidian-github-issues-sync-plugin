/**
 * GitHub Issues Sync Plugin for Obsidian
 *
 * Syncs GitHub Project issues to Obsidian markdown files,
 * allowing you to edit issue descriptions using Obsidian's editor.
 */

import { App, MarkdownView, Modal, Notice, Plugin, TFile } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  AuthState,
  DEFAULT_AUTH_STATE,
} from "./types";
import { SettingsTab } from "./settings";
import { performDeviceFlow } from "./github/auth";
import { syncProject, pushCurrentIssue, cleanupOldIssues } from "./sync/sync";
import { parseFrontmatter } from "./files/issue-files";

export default class GitHubIssuesSyncPlugin extends Plugin {
  settings: PluginSettings;
  authState: AuthState;

  async onload() {
    await this.loadSettings();
    await this.loadAuthState();

    // Settings tab
    this.addSettingTab(new SettingsTab(this.app, this));

    // Command: Login to GitHub
    this.addCommand({
      id: "login-to-github",
      name: "Login to GitHub",
      callback: () => this.login(),
    });

    // Command: Logout from GitHub
    this.addCommand({
      id: "logout-from-github",
      name: "Logout from GitHub",
      callback: () => this.logout(),
    });

    // Command: Sync Project (pull)
    this.addCommand({
      id: "sync-project",
      name: "Sync project (pull from GitHub)",
      callback: () => this.syncProjectCommand(),
    });

    // Command: Sync Current Issue (push)
    this.addCommand({
      id: "sync-current-issue",
      name: "Sync current issue (push to GitHub)",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file && this.isIssueFileSync(file)) {
          if (!checking) {
            this.pushCurrentIssueCommand(file);
          }
          return true;
        }
        return false;
      },
    });

    // Command: Cleanup old issues
    this.addCommand({
      id: "cleanup-old-issues",
      name: "Clean up old issues (archive)",
      callback: () => this.cleanupOldIssuesCommand(),
    });

    // Command: Open current issue in GitHub
    this.addCommand({
      id: "open-in-github",
      name: "Open current issue in GitHub",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file && this.isIssueFileSync(file)) {
          if (!checking) {
            this.openInGitHub(file);
          }
          return true;
        }
        return false;
      },
    });
  }

  onunload() {
    // Cleanup if needed
  }

  // ===========================================================================
  // Settings & Auth State Persistence
  // ===========================================================================

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      _auth: this.authState, // Store auth state alongside settings
    });
  }

  async loadAuthState() {
    const data = await this.loadData();
    this.authState = Object.assign(
      {},
      DEFAULT_AUTH_STATE,
      data?._auth || {}
    );
  }

  async saveAuthState() {
    await this.saveSettings(); // Auth state is stored with settings
  }

  // ===========================================================================
  // Authentication
  // ===========================================================================

  async login(): Promise<void> {
    if (this.settings.authMethod === "pat") {
      await this.loginWithPat();
    } else {
      await this.loginWithOAuth();
    }
  }

  private async loginWithPat(): Promise<void> {
    // Show a modal to input the PAT
    const modal = new PatInputModal(this.app, async (token: string) => {
      if (!token) {
        new Notice("No token provided.");
        return;
      }

      try {
        new Notice("Validating token...");
        
        // Validate the token by fetching user info
        const { getAuthenticatedUser } = await import("./github/auth");
        const userInfo = await getAuthenticatedUser(token, this.settings.githubBaseUrl);

        this.authState = {
          accessToken: token,
          refreshToken: null,
          expiresAt: null, // PATs don't have built-in expiry we can detect
          username: userInfo.login,
        };
        await this.saveAuthState();
        new Notice(`Logged in as ${userInfo.login}!`);
      } catch (error) {
        console.error("Login failed:", error);
        new Notice(`Login failed: ${error instanceof Error ? error.message : "Invalid token"}`);
      }
    });
    modal.open();
  }

  private async loginWithOAuth(): Promise<void> {
    if (!this.settings.clientId) {
      new Notice(
        "Please configure your GitHub App Client ID in settings first."
      );
      return;
    }

    let deviceFlowModal: DeviceFlowModal | undefined;

    try {
      new Notice("Starting GitHub login...");

      const authState = await performDeviceFlow(
        this.settings.clientId,
        this.settings.githubBaseUrl,
        (userCode: string, verificationUri: string) => {
          // Show modal with the code
          deviceFlowModal = new DeviceFlowModal(this.app, userCode, verificationUri);
          deviceFlowModal.open();
        }
      );

      // Close the modal now that auth is complete
      deviceFlowModal?.close();

      if (authState) {
        this.authState = authState;
        await this.saveAuthState();
        new Notice(`Logged in as ${authState.username}!`);
      }
    } catch (error) {
      // Close modal on error too
      deviceFlowModal?.close();
      console.error("Login failed:", error);
      new Notice(`Login failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async logout(): Promise<void> {
    this.authState = { ...DEFAULT_AUTH_STATE };
    await this.saveAuthState();
    new Notice("Logged out from GitHub.");
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  async syncProjectCommand(): Promise<void> {
    if (!this.validateConfig()) return;

    try {
      await syncProject(this.app, this.settings, this.authState, {
        archiveOld: false, // Don't auto-archive, let user do it explicitly
      });
    } catch (error) {
      console.error("Sync failed:", error);
      new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async pushCurrentIssueCommand(file: TFile): Promise<void> {
    if (!this.authState.accessToken) {
      new Notice("Please login to GitHub first.");
      return;
    }

    try {
      await pushCurrentIssue(this.app, this.settings, this.authState, file);
    } catch (error) {
      console.error("Push failed:", error);
      new Notice(`Push failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async cleanupOldIssuesCommand(): Promise<void> {
    if (!this.validateConfig()) return;

    try {
      await cleanupOldIssues(this.app, this.settings, this.authState);
    } catch (error) {
      console.error("Cleanup failed:", error);
      new Notice(`Cleanup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async openInGitHub(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const frontmatter = parseFrontmatter(content);

      if (frontmatter?.url) {
        window.open(frontmatter.url, "_blank");
      } else {
        new Notice("Could not find issue URL in frontmatter.");
      }
    } catch (error) {
      console.error("Failed to open in GitHub:", error);
      new Notice("Failed to open issue in GitHub.");
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private validateConfig(): boolean {
    if (!this.authState.accessToken) {
      new Notice("Please login to GitHub first.");
      return false;
    }

    if (!this.settings.projectUrl) {
      new Notice("Please configure your project URL in settings.");
      return false;
    }

    return true;
  }

  /**
   * Synchronous check if a file is in the sync folder (for checkCallback)
   * This is a heuristic - we check if it's in the issues folder and is markdown
   */
  private isIssueFileSync(file: TFile): boolean {
    if (file.extension !== "md") return false;
    
    // Build the issues folder path
    const issuesFolderPath = this.settings.issuesFolder 
      ? `${this.settings.syncFolder}/${this.settings.issuesFolder}`
      : this.settings.syncFolder;
    
    // Check if file is in the issues folder
    if (!file.path.startsWith(issuesFolderPath + "/")) return false;
    
    // Exclude the index file (in case it's at the issues folder level)
    if (file.basename === this.settings.indexFileName) return false;
    
    // Exclude archived files
    if (file.path.includes(`/${this.settings.archiveFolder}/`)) return false;
    
    return true;
  }
}

/**
 * Modal shown during device flow authentication
 */
class DeviceFlowModal extends Modal {
  userCode: string;
  verificationUri: string;

  constructor(app: App, userCode: string, verificationUri: string) {
    super(app);
    this.userCode = userCode;
    this.verificationUri = verificationUri;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Login to GitHub" });

    contentEl.createEl("p", {
      text: "A browser window has been opened. Please enter this code:",
    });

    const codeEl = contentEl.createEl("div", {
      cls: "github-issues-sync-code",
    });
    codeEl.createEl("code", {
      text: this.userCode,
      cls: "github-issues-sync-code-text",
    });

    // Add some styling
    codeEl.style.textAlign = "center";
    codeEl.style.padding = "20px";
    codeEl.style.margin = "20px 0";
    codeEl.style.backgroundColor = "var(--background-secondary)";
    codeEl.style.borderRadius = "8px";

    const codeText = codeEl.querySelector("code");
    if (codeText) {
      codeText.style.fontSize = "24px";
      codeText.style.fontWeight = "bold";
      codeText.style.letterSpacing = "4px";
    }

    contentEl.createEl("p", {
      text: `If the browser didn't open, go to: ${this.verificationUri}`,
    });

    contentEl.createEl("p", {
      text: "This dialog will close automatically once you've authorized the app.",
      cls: "mod-muted",
    });

    // Copy button
    const buttonContainer = contentEl.createEl("div", {
      cls: "github-issues-sync-buttons",
    });
    buttonContainer.style.textAlign = "center";

    const copyButton = buttonContainer.createEl("button", {
      text: "Copy Code",
    });
    copyButton.onclick = () => {
      navigator.clipboard.writeText(this.userCode);
      new Notice("Code copied to clipboard!");
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Modal for entering a Personal Access Token
 */
class PatInputModal extends Modal {
  private onSubmit: (token: string) => void;

  constructor(app: App, onSubmit: (token: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Enter Personal Access Token" });

    contentEl.createEl("p", {
      text: "Paste your GitHub Personal Access Token (PAT) below.",
    });

    const instructionsEl = contentEl.createEl("div", {
      cls: "mod-muted",
    });
    instructionsEl.style.marginBottom = "1em";
    instructionsEl.style.fontSize = "0.85em";
    instructionsEl.innerHTML = `
      <p>Your token needs these permissions:</p>
      <ul style="margin: 0.5em 0; padding-left: 1.5em;">
        <li><strong>repo</strong> - to read/write issues</li>
        <li><strong>read:project</strong> - to read project boards</li>
      </ul>
      <p>Create a token at: Settings → Developer settings → Personal access tokens</p>
    `;

    // Token input
    const inputContainer = contentEl.createEl("div");
    inputContainer.style.marginBottom = "1em";

    const tokenInput = inputContainer.createEl("input", {
      type: "password",
      placeholder: "ghp_xxxxxxxxxxxx or github_pat_xxxx",
    });
    tokenInput.style.width = "100%";
    tokenInput.style.padding = "8px";
    tokenInput.style.marginBottom = "0.5em";

    // Show/hide toggle
    const showToggle = inputContainer.createEl("label");
    showToggle.style.fontSize = "0.85em";
    showToggle.style.cursor = "pointer";
    const checkbox = showToggle.createEl("input", { type: "checkbox" });
    checkbox.style.marginRight = "0.5em";
    showToggle.appendText("Show token");
    checkbox.onchange = () => {
      tokenInput.type = checkbox.checked ? "text" : "password";
    };

    // Buttons
    const buttonContainer = contentEl.createEl("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "8px";

    const cancelButton = buttonContainer.createEl("button", {
      text: "Cancel",
    });
    cancelButton.onclick = () => this.close();

    const submitButton = buttonContainer.createEl("button", {
      text: "Login",
      cls: "mod-cta",
    });
    submitButton.onclick = () => {
      const token = tokenInput.value.trim();
      this.close();
      this.onSubmit(token);
    };

    // Allow Enter to submit
    tokenInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        const token = tokenInput.value.trim();
        this.close();
        this.onSubmit(token);
      }
    };

    // Focus the input
    tokenInput.focus();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
