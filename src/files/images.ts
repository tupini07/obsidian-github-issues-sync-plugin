/**
 * Image handling for GitHub issues
 *
 * Strategy:
 * - On pull: Leave GitHub image URLs as-is (they may not display locally but markdown is preserved)
 * - On push: Upload local images to a GitHub repo and replace with raw URLs
 */

import { App, TFile, normalizePath, requestUrl } from "obsidian";
import type { PluginSettings } from "../types";

/** Regex patterns for finding images in markdown */
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** Obsidian wikilink image pattern: ![[filename]] or ![[filename|alt]] */
const WIKILINK_IMAGE_REGEX = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/** Check if a path is a local vault path (not a URL) */
function isLocalPath(path: string): boolean {
  return (
    !path.startsWith("http://") &&
    !path.startsWith("https://") &&
    !path.startsWith("data:")
  );
}

/** Get file extension from filename */
function getExtension(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "png";
  return ext;
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Compute a SHA-256 hash of an ArrayBuffer and return as hex string
 */
async function hashArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Find an image file in the vault by name
 * Obsidian can reference images by just filename, so we need to search
 */
async function findImageFile(
  app: App,
  imagePath: string
): Promise<TFile | null> {
  // First try direct path
  const directFile = app.vault.getAbstractFileByPath(normalizePath(imagePath));
  if (directFile instanceof TFile) {
    return directFile;
  }

  // Try with common image extensions if no extension
  if (!imagePath.includes(".")) {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
      const withExt = app.vault.getAbstractFileByPath(
        normalizePath(`${imagePath}.${ext}`)
      );
      if (withExt instanceof TFile) {
        return withExt;
      }
    }
  }

  // Search by filename in the whole vault
  const filename = imagePath.split("/").pop() || imagePath;
  const allFiles = app.vault.getFiles();

  for (const file of allFiles) {
    if (file.name === filename || file.basename === filename) {
      return file;
    }
  }

  return null;
}

/**
 * Check if an image already exists in the GitHub repo by its hash filename
 */
async function imageExistsInRepo(
  settings: PluginSettings,
  accessToken: string,
  filename: string
): Promise<boolean> {
  const [owner, repo] = settings.imageHostingRepo.split("/");
  const branch = settings.imageHostingBranch || "main";
  const baseUrl = settings.githubBaseUrl
    ? `https://${settings.githubBaseUrl}/api/v3`
    : "https://api.github.com";

  const apiUrl = `${baseUrl}/repos/${owner}/${repo}/contents/images/${filename}?ref=${branch}`;

  try {
    const response = await requestUrl({
      url: apiUrl,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
      },
      throw: false,
    });

    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Upload an image to the GitHub repo
 * Returns the raw URL for the image
 */
async function uploadImageToRepo(
  settings: PluginSettings,
  accessToken: string,
  filename: string,
  content: string // base64 encoded
): Promise<string> {
  const [owner, repo] = settings.imageHostingRepo.split("/");
  const branch = settings.imageHostingBranch || "main";
  const baseUrl = settings.githubBaseUrl
    ? `https://${settings.githubBaseUrl}/api/v3`
    : "https://api.github.com";

  const apiUrl = `${baseUrl}/repos/${owner}/${repo}/contents/images/${filename}`;

  const response = await requestUrl({
    url: apiUrl,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Upload image ${filename}`,
      content: content,
      branch: branch,
    }),
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Failed to upload image: ${response.status}`);
  }

  // Build blob URL with ?raw=true
  // Format: https://github.com/owner/repo/blob/branch/images/filename?raw=true
  // For GHE: https://{baseUrl}/owner/repo/blob/branch/images/filename?raw=true
  const githubHost = settings.githubBaseUrl || "github.com";

  return `https://${githubHost}/${owner}/${repo}/blob/${branch}/images/${filename}?raw=true`;
}

/**
 * Process a local image: upload to GitHub repo and return the raw URL
 */
async function processLocalImage(
  app: App,
  settings: PluginSettings,
  accessToken: string,
  imagePath: string
): Promise<string | null> {
  const file = await findImageFile(app, imagePath);
  if (!file) {
    console.warn(`Image not found: ${imagePath}`);
    return null;
  }

  try {
    // Read image content
    const buffer = await app.vault.readBinary(file);
    const base64Content = arrayBufferToBase64(buffer);

    // Generate hash-based filename
    const hash = await hashArrayBuffer(buffer);
    const ext = getExtension(file.name);
    const filename = `${hash.substring(0, 16)}.${ext}`;

    // Check if already uploaded
    const exists = await imageExistsInRepo(settings, accessToken, filename);
    if (exists) {
      console.log(`Image already exists in repo: ${filename}`);  
      // Return the blob URL without re-uploading
      const [owner, repo] = settings.imageHostingRepo.split("/");
      const branch = settings.imageHostingBranch || "main";
      const githubHost = settings.githubBaseUrl || "github.com";
      return `https://${githubHost}/${owner}/${repo}/blob/${branch}/images/${filename}?raw=true`;
    }

    // Upload to GitHub
    const rawUrl = await uploadImageToRepo(
      settings,
      accessToken,
      filename,
      base64Content
    );
    console.log(`Uploaded image: ${filename} -> ${rawUrl}`);
    return rawUrl;
  } catch (error) {
    console.error(`Failed to process image ${imagePath}:`, error);
    return null;
  }
}

/**
 * Process images in issue content for push: upload local images to GitHub repo
 * and replace with raw URLs. Adds hidden comments to preserve local paths.
 */
export async function processImagesOnPush(
  app: App,
  settings: PluginSettings,
  accessToken: string,
  content: string
): Promise<{ content: string; uploadedCount: number; skippedCount: number }> {
  // Check if image hosting is configured
  if (!settings.imageHostingRepo) {
    console.log("Image hosting repo not configured, skipping image upload");
    return { content, uploadedCount: 0, skippedCount: 0 };
  }

  let modifiedContent = content;
  let uploadedCount = 0;
  let skippedCount = 0;

  // Process Obsidian wikilink images: ![[image.png]] or ![[image.png|alt text]]
  const wikiMatches: Array<{ full: string; path: string; alt: string }> = [];
  let match;

  while ((match = WIKILINK_IMAGE_REGEX.exec(content)) !== null) {
    wikiMatches.push({
      full: match[0],
      path: match[1],
      alt: match[2] || match[1],
    });
  }
  WIKILINK_IMAGE_REGEX.lastIndex = 0;

  for (const wm of wikiMatches) {
    const rawUrl = await processLocalImage(app, settings, accessToken, wm.path);
    if (rawUrl) {
      // Replace wikilink with standard markdown image + hidden comment for restoration
      // Format: <!-- obsidian-local: path -->\n![alt](url)
      modifiedContent = modifiedContent.replace(
        wm.full,
        `<!-- obsidian-local: ${wm.path} -->\n![${wm.alt}](${rawUrl})`
      );
      uploadedCount++;
    } else {
      skippedCount++;
    }
  }

  // Process standard markdown images with local paths: ![alt](local/path.png)
  const mdMatches: Array<{ full: string; alt: string; path: string }> = [];

  while ((match = MARKDOWN_IMAGE_REGEX.exec(content)) !== null) {
    if (isLocalPath(match[2])) {
      mdMatches.push({
        full: match[0],
        alt: match[1],
        path: match[2],
      });
    }
  }
  MARKDOWN_IMAGE_REGEX.lastIndex = 0;

  for (const mm of mdMatches) {
    const rawUrl = await processLocalImage(
      app,
      settings,
      accessToken,
      mm.path
    );
    if (rawUrl) {
      // Replace with URL + hidden comment for restoration
      modifiedContent = modifiedContent.replace(
        mm.full,
        `<!-- obsidian-local: ${mm.path} -->\n![${mm.alt}](${rawUrl})`
      );
      uploadedCount++;
    } else {
      skippedCount++;
    }
  }

  return { content: modifiedContent, uploadedCount, skippedCount };
}

/**
 * Pattern to match our hidden comment + newline + image that follows
 * Matches: <!-- obsidian-local: path -->\n![alt](url)
 */
const LOCAL_IMAGE_COMMENT_REGEX = /<!-- obsidian-local: ([^>]+) -->\n!\[[^\]]*\]\([^)]+\)/g;

/**
 * Process images on pull: restore local Obsidian paths from hidden comments
 * Converts: <!-- obsidian-local: image.png -->![alt](https://...) 
 * Back to:  ![[image.png]]
 */
export function restoreLocalImages(content: string): string {
  return content.replace(LOCAL_IMAGE_COMMENT_REGEX, (_match, localPath) => {
    // Restore as Obsidian wikilink
    return `![[${localPath.trim()}]]`;
  });
}

/**
 * Check if content has any local image references (wikilinks or local paths)
 */
export function hasLocalImages(content: string): boolean {
  // Check for wikilink images
  if (WIKILINK_IMAGE_REGEX.test(content)) {
    WIKILINK_IMAGE_REGEX.lastIndex = 0;
    return true;
  }

  // Check for local path images
  let match;
  while ((match = MARKDOWN_IMAGE_REGEX.exec(content)) !== null) {
    if (isLocalPath(match[2])) {
      MARKDOWN_IMAGE_REGEX.lastIndex = 0;
      return true;
    }
  }
  MARKDOWN_IMAGE_REGEX.lastIndex = 0;

  return false;
}
