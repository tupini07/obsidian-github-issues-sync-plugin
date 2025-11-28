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
import { restoreLocalImages } from "./images";

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
 * Only includes the url - repo and issue_number are parsed from it
 */
export function generateFrontmatter(issue: GitHubIssue): string {
  const lines = ["---"];
  lines.push(`url: "${issue.url}"`);
  lines.push("---");

  return lines.join("\n");
}

/**
 * Generate the full markdown content for an issue file
 * Restores local image paths from hidden comments added during push
 */
export function generateIssueContent(issue: GitHubIssue): string {
  const frontmatter = generateFrontmatter(issue);
  // Body is the issue description - restore local image paths
  const body = restoreLocalImages(issue.body || "");

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
  let url: string | null = null;

  // Simple YAML parsing - we only need url now
  const lines = yamlContent.split("\n");
  for (const line of lines) {
    const match = line.match(/^url:\s*"?([^"]*)"?\s*$/);
    if (match) {
      url = match[1];
      break;
    }
  }

  if (!url) {
    return null;
  }

  // Parse repo and issue_number from url
  // Format: https://github.com/{owner}/{repo}/issues/{number}
  const urlMatch = url.match(/\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
  if (!urlMatch) {
    return null;
  }

  const [, owner, repoName, issueNum] = urlMatch;

  return {
    url,
    repo: `${owner}/${repoName}`,
    issue_number: parseInt(issueNum, 10),
  };
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
