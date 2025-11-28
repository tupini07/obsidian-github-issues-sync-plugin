/**
 * Core type definitions for the GitHub Issues Sync plugin
 */

// ============================================================================
// Plugin Settings
// ============================================================================

/** Authentication method */
export type AuthMethod = "pat" | "oauth";

export interface PluginSettings {
  /** Authentication method: 'pat' for Personal Access Token, 'oauth' for GitHub App device flow */
  authMethod: AuthMethod;

  /** OAuth/GitHub App Client ID (only needed for oauth method) */
  clientId: string;

  /** GitHub Enterprise/EMU base URL. Empty string = github.com */
  githubBaseUrl: string;

  /** GitHub Project URL (e.g., https://github.com/orgs/my-org/projects/14) */
  projectUrl: string;

  /** Folder path in vault where issues are synced */
  syncFolder: string;

  /** Name of the index/board file */
  indexFileName: string;

  /** Subfolder for issue files (relative to syncFolder) */
  issuesFolder: string;

  /** Subfolder for archived issues (relative to issuesFolder) */
  archiveFolder: string;

  /** Only sync issues assigned to the authenticated user */
  onlyMyIssues: boolean;

  /** Repository for hosting uploaded images (format: owner/repo) */
  imageHostingRepo: string;

  /** Branch to use for image uploads (default: main) */
  imageHostingBranch: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  authMethod: "pat",
  clientId: "",
  githubBaseUrl: "",
  projectUrl: "",
  syncFolder: "GitHub Issues",
  indexFileName: "Board",
  issuesFolder: "_issues",
  archiveFolder: "_archive",
  onlyMyIssues: false,
  imageHostingRepo: "",
  imageHostingBranch: "main",
};

// ============================================================================
// Authentication
// ============================================================================

export interface AuthState {
  /** OAuth access token */
  accessToken: string | null;

  /** Refresh token (if using expiring tokens) */
  refreshToken: string | null;

  /** Token expiry timestamp (ISO string) */
  expiresAt: string | null;

  /** Authenticated GitHub username */
  username: string | null;
}

export const DEFAULT_AUTH_STATE: AuthState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  username: null,
};

/** Response from device code request */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Response from token exchange */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
}

// ============================================================================
// GitHub Project & Issue Data
// ============================================================================

/** Parsed project URL info */
export interface ProjectInfo {
  /** 'orgs' or 'users' */
  ownerType: "orgs" | "users";

  /** Organization or username */
  owner: string;

  /** Project number */
  projectNumber: number;
}

/** Status field option from the project */
export interface StatusOption {
  id: string;
  name: string;
  color?: string;
}

/** Iteration field from the project */
export interface Iteration {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}

/** Project metadata */
export interface ProjectMetadata {
  id: string;
  title: string;
  statusField: {
    id: string;
    options: StatusOption[];
  };
  iterationField: {
    id: string;
    iterations: Iteration[];
  } | null;
  currentIteration: Iteration | null;
}

/** Issue data from GitHub */
export interface GitHubIssue {
  /** Issue number */
  number: number;

  /** Issue title */
  title: string;

  /** Issue body/description (markdown) */
  body: string;

  /** Repository in format "owner/repo" */
  repository: string;

  /** Full URL to the issue */
  url: string;

  /** Current status in the project */
  status: string;

  /** State (OPEN, CLOSED) */
  state: "OPEN" | "CLOSED";

  /** Assignee logins */
  assignees: string[];

  /** Label names */
  labels: string[];
}

/** Issue as stored in local markdown frontmatter */
export interface IssueFrontmatter {
  issue_number: number;
  repo: string;
  title: string;
  status: string;
  url: string;
  last_synced: string;
}

// ============================================================================
// File Utilities
// ============================================================================

/**
 * Characters that are invalid in filenames across Windows, macOS, and Linux
 */
export const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Reserved filenames on Windows
 */
export const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Sanitize a string to be a valid filename
 * @param name - The original string (e.g., issue title)
 * @returns A sanitized filename-safe string
 */
export function sanitizeFilename(name: string): string {
  // Replace invalid characters with dashes
  let sanitized = name.replace(INVALID_FILENAME_CHARS, "-");

  // Replace multiple consecutive dashes with single dash
  sanitized = sanitized.replace(/-+/g, "-");

  // Trim dashes and spaces from start/end
  sanitized = sanitized.replace(/^[-\s]+|[-\s]+$/g, "");

  // Handle Windows reserved names by appending underscore
  if (WINDOWS_RESERVED_NAMES.test(sanitized)) {
    sanitized = `${sanitized}_`;
  }

  // Ensure filename isn't empty
  if (!sanitized) {
    sanitized = "untitled";
  }

  // Truncate to reasonable length (Obsidian/filesystem limits)
  // Leave room for .md extension
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  return sanitized;
}

/**
 * Generate a unique filename for an issue
 * Uses title as filename, with issue number as disambiguation suffix if needed
 */
export function generateIssueFilename(issue: GitHubIssue): string {
  const sanitizedTitle = sanitizeFilename(issue.title);

  // We'll add issue number as suffix to ensure uniqueness
  // Format: "Issue Title (123)"
  return `${sanitizedTitle} (${issue.number})`;
}
