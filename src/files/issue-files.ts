/**
 * File operations for syncing issues to Obsidian
 */

import { App, TFile, TFolder, normalizePath } from "obsidian";
import type {
  GitHubIssue,
  IssueFrontmatter,
  PluginSettings,
  StatusOption,
} from "../types";
import { sanitizeFilename, generateIssueFilename } from "../types";

/**
 * Ensure a folder exists, creating it if necessary
 */
export async function ensureFolder(app: App, path: string): Promise<TFolder> {
  const normalizedPath = normalizePath(path);
  const folder = app.vault.getAbstractFileByPath(normalizedPath);

  if (folder instanceof TFolder) {
    return folder;
  }

  // Create the folder
  await app.vault.createFolder(normalizedPath);
  return app.vault.getAbstractFileByPath(normalizedPath) as TFolder;
}

/**
 * Generate frontmatter YAML string for an issue
 */
export function generateFrontmatter(issue: GitHubIssue): string {
  const frontmatter: IssueFrontmatter = {
    issue_number: issue.number,
    repo: issue.repository,
    title: issue.title,
    status: issue.status,
    url: issue.url,
    last_synced: new Date().toISOString(),
  };

  const lines = ["---"];
  lines.push(`issue_number: ${frontmatter.issue_number}`);
  lines.push(`repo: "${frontmatter.repo}"`);
  lines.push(`title: "${escapeYamlString(frontmatter.title)}"`);
  lines.push(`status: "${frontmatter.status}"`);
  lines.push(`url: "${frontmatter.url}"`);
  lines.push(`last_synced: "${frontmatter.last_synced}"`);
  lines.push("---");

  return lines.join("\n");
}

/**
 * Escape special characters in YAML strings
 */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Generate the full markdown content for an issue file
 */
export function generateIssueContent(issue: GitHubIssue): string {
  const frontmatter = generateFrontmatter(issue);
  // Body is the issue description
  const body = issue.body || "";

  return `${frontmatter}\n\n${body}`;
}

/**
 * Generate the index/board file content
 */
export function generateIndexContent(
  issues: GitHubIssue[],
  statusOptions: StatusOption[],
  projectTitle: string,
  iterationTitle: string | null,
  issuesFolder: string
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${projectTitle}`);
  if (iterationTitle) {
    lines.push(`**Current Iteration:** ${iterationTitle}`);
  }
  lines.push("");
  lines.push(`*Last synced: ${new Date().toLocaleString()}*`);
  lines.push("");

  // Group issues by status
  const issuesByStatus = new Map<string, GitHubIssue[]>();

  // Initialize all status groups in order
  for (const status of statusOptions) {
    issuesByStatus.set(status.name, []);
  }
  // Add "No Status" for issues without status
  issuesByStatus.set("No Status", []);

  // Group issues
  for (const issue of issues) {
    const statusIssues = issuesByStatus.get(issue.status) || [];
    statusIssues.push(issue);
    issuesByStatus.set(issue.status, statusIssues);
  }

  // Generate sections for each status
  for (const [status, statusIssues] of issuesByStatus) {
    // Skip empty sections
    if (statusIssues.length === 0) {
      continue;
    }

    lines.push(`## ${status}`);
    lines.push("");

    for (const issue of statusIssues) {
      const filename = generateIssueFilename(issue);
      // Use Obsidian wikilink format with subfolder path
      const linkPath = issuesFolder ? `${issuesFolder}/${filename}` : filename;
      lines.push(`- [[${linkPath}|${issue.title}]]`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse frontmatter from a markdown file
 */
export function parseFrontmatter(content: string): IssueFrontmatter | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const yamlContent = frontmatterMatch[1];
  const frontmatter: Partial<IssueFrontmatter> = {};

  // Simple YAML parsing for our known fields
  const lines = yamlContent.split("\n");
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (match) {
      const [, key, value] = match;
      switch (key) {
        case "issue_number":
          frontmatter.issue_number = parseInt(value, 10);
          break;
        case "repo":
          frontmatter.repo = value;
          break;
        case "title":
          frontmatter.title = value;
          break;
        case "status":
          frontmatter.status = value;
          break;
        case "url":
          frontmatter.url = value;
          break;
        case "last_synced":
          frontmatter.last_synced = value;
          break;
      }
    }
  }

  if (
    frontmatter.issue_number &&
    frontmatter.repo &&
    frontmatter.title &&
    frontmatter.url
  ) {
    return frontmatter as IssueFrontmatter;
  }

  return null;
}

/**
 * Extract the body content (after frontmatter) from a markdown file
 */
export function extractBody(content: string): string {
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1] : content;
}

/**
 * Get the issues folder path
 */
export function getIssuesFolderPath(settings: PluginSettings): string {
  return normalizePath(`${settings.syncFolder}/${settings.issuesFolder}`);
}

/**
 * Write or update an issue file
 */
export async function writeIssueFile(
  app: App,
  settings: PluginSettings,
  issue: GitHubIssue
): Promise<TFile> {
  const folderPath = getIssuesFolderPath(settings);
  await ensureFolder(app, folderPath);

  const filename = generateIssueFilename(issue);
  const filePath = normalizePath(`${folderPath}/${filename}.md`);

  const content = generateIssueContent(issue);

  // Check if file exists
  const existingFile = app.vault.getAbstractFileByPath(filePath);

  if (existingFile instanceof TFile) {
    await app.vault.modify(existingFile, content);
    return existingFile;
  } else {
    return await app.vault.create(filePath, content);
  }
}

/**
 * Write the index/board file
 */
export async function writeIndexFile(
  app: App,
  settings: PluginSettings,
  issues: GitHubIssue[],
  statusOptions: StatusOption[],
  projectTitle: string,
  iterationTitle: string | null
): Promise<TFile> {
  const folderPath = normalizePath(settings.syncFolder);
  await ensureFolder(app, folderPath);

  const filePath = normalizePath(
    `${folderPath}/${settings.indexFileName}.md`
  );

  const content = generateIndexContent(
    issues,
    statusOptions,
    projectTitle,
    iterationTitle,
    settings.issuesFolder
  );

  // Check if file exists
  const existingFile = app.vault.getAbstractFileByPath(filePath);

  if (existingFile instanceof TFile) {
    await app.vault.modify(existingFile, content);
    return existingFile;
  } else {
    return await app.vault.create(filePath, content);
  }
}

/**
 * Get all issue files in the issues folder
 */
export async function getIssueFiles(
  app: App,
  settings: PluginSettings
): Promise<TFile[]> {
  const folderPath = getIssuesFolderPath(settings);
  const folder = app.vault.getAbstractFileByPath(folderPath);

  if (!(folder instanceof TFolder)) {
    return [];
  }

  const issueFiles: TFile[] = [];
  const indexFileName = `${settings.indexFileName}.md`;

  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      // Skip the index file
      if (child.name === indexFileName) {
        continue;
      }

      // Check if it has our frontmatter
      const content = await app.vault.read(child);
      const frontmatter = parseFrontmatter(content);
      if (frontmatter) {
        issueFiles.push(child);
      }
    }
  }

  return issueFiles;
}

/**
 * Archive issue files that are no longer in the current iteration
 */
export async function archiveOldIssues(
  app: App,
  settings: PluginSettings,
  currentIssueNumbers: Set<number>
): Promise<number> {
  const issueFiles = await getIssueFiles(app, settings);
  const issuesFolderPath = getIssuesFolderPath(settings);
  const archivePath = normalizePath(
    `${issuesFolderPath}/${settings.archiveFolder}`
  );

  let archivedCount = 0;

  for (const file of issueFiles) {
    const content = await app.vault.read(file);
    const frontmatter = parseFrontmatter(content);

    if (frontmatter && !currentIssueNumbers.has(frontmatter.issue_number)) {
      // Move to archive
      await ensureFolder(app, archivePath);
      const newPath = normalizePath(`${archivePath}/${file.name}`);

      await app.vault.rename(file, newPath);
      archivedCount++;
    }
  }

  return archivedCount;
}
