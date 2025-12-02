/**
 * Sync operations - pull and push
 */

import { App, Notice, TFile } from "obsidian";
import { hasLocalImages, processImagesOnPush } from "../files/images";
import {
	archiveOldIssues,
	extractBody,
	parseFrontmatter,
	writeIndexFile,
	writeIssueFile,
} from "../files/issue-files";
import {
	fetchProjectIssues,
	fetchProjectMetadata,
	parseProjectUrl,
	updateIssue,
} from "../github/client";
import type { AuthState, PluginSettings } from "../types";

/**
 * Perform a full project sync (pull)
 * 1. Fetch project metadata
 * 2. Fetch all issues in current iteration
 * 3. Write issue files
 * 4. Write index file
 * 5. Optionally archive old issues
 */
export async function syncProject(
	app: App,
	settings: PluginSettings,
	authState: AuthState,
	options: { archiveOld?: boolean } = {}
): Promise<{ issueCount: number; archivedCount: number }> {
	if (!authState.accessToken) {
		throw new Error("Not authenticated. Please login to GitHub first.");
	}

	// Create a persistent notice that we'll update as sync progresses
	// Using 0 timeout makes it stay until we call hide()
	const progressNotice = new Notice("⏳ Syncing: Starting...", 0);

	const updateProgress = (message: string) => {
		progressNotice.setMessage(`⏳ Syncing: ${message}`);
	};

	try {
		// Parse project URL
		const projectInfo = parseProjectUrl(settings.projectUrl);
		if (!projectInfo) {
			progressNotice.hide();
			throw new Error(
				"Invalid project URL. Expected format: https://github.com/orgs/{org}/projects/{number}"
			);
		}

		updateProgress("Fetching project metadata...");

		// Fetch project metadata
		const metadata = await fetchProjectMetadata(
			authState.accessToken,
			settings.githubBaseUrl,
			projectInfo
		);

		updateProgress(
			`Fetching issues${metadata.currentIteration
				? ` for ${metadata.currentIteration.title}`
				: ""
			}...`
		);

		// Fetch issues (filtered to current iteration if available)
		let issues = await fetchProjectIssues(
			authState.accessToken,
			settings.githubBaseUrl,
			projectInfo,
			metadata.currentIteration?.id || null
		);

		// Filter to only user's issues if enabled
		if (settings.onlyMyIssues && authState.username) {
			const myUsername = authState.username.toLowerCase();
			issues = issues.filter((issue) =>
				issue.assignees.some((a) => a.toLowerCase() === myUsername)
			);
		}

		updateProgress(`Writing ${issues.length} issue files...`);

		// Write issue files
		for (let i = 0; i < issues.length; i++) {
			updateProgress(`Writing issue ${i + 1}/${issues.length}...`);
			await writeIssueFile(app, settings, issues[i]);
		}

		updateProgress("Writing index file...");

		// Write index file
		await writeIndexFile(
			app,
			settings,
			issues,
			metadata.statusField.options,
			metadata.title,
			metadata.currentIteration?.title || null
		);

		// Archive old issues if requested
		let archivedCount = 0;
		if (options.archiveOld) {
			updateProgress("Archiving old issues...");
			const currentIssueNumbers = new Set(issues.map((i) => i.number));
			archivedCount = await archiveOldIssues(app, settings, currentIssueNumbers);
		}

		// Hide progress notice and show completion
		progressNotice.hide();

		let message = `✅ Sync complete! ${issues.length} issues synced`;
		if (archivedCount > 0) {
			message += `, ${archivedCount} archived`;
		}
		message += ".";

		new Notice(message);

		return { issueCount: issues.length, archivedCount };
	} catch (error) {
		// Make sure to hide progress notice on error
		progressNotice.hide();
		throw error;
	}
}

/**
 * Push changes from the current issue file to GitHub
 */
export async function pushCurrentIssue(
	app: App,
	settings: PluginSettings,
	authState: AuthState,
	file: TFile
): Promise<void> {
	if (!authState.accessToken) {
		throw new Error("Not authenticated. Please login to GitHub first.");
	}

	// Read and parse the file
	const content = await app.vault.read(file);
	const frontmatter = parseFrontmatter(content);

	if (!frontmatter) {
		throw new Error(
			"This file does not appear to be a synced issue. Missing frontmatter."
		);
	}

	// Extract body (the description)
	const originalBody = extractBody(content);
	let bodyForGitHub = originalBody;

	// Upload local images to GitHub repo and replace with raw URLs (only for GitHub, not local file)
	if (hasLocalImages(originalBody)) {
		if (settings.imageHostingRepo) {
			new Notice("Uploading images to GitHub...");
			const imageResult = await processImagesOnPush(
				app,
				settings,
				authState.accessToken,
				originalBody
			);
			bodyForGitHub = imageResult.content;
			if (imageResult.uploadedCount > 0) {
				new Notice(`Uploaded ${imageResult.uploadedCount} image(s) to GitHub`);
			}
			if (imageResult.skippedCount > 0) {
				new Notice(
					`Skipped ${imageResult.skippedCount} image(s) (not found)`,
					5000
				);
			}
		} else {
			new Notice(
				"Warning: Local images found but no image hosting repo configured. Images will not display on GitHub.",
				8000
			);
		}
	}

	// Parse repo owner and name (already parsed from url in frontmatter)
	const repoParts = frontmatter.repo.split("/");
	if (repoParts.length !== 2) {
		throw new Error(`Invalid repo format: ${frontmatter.repo}`);
	}

	const [owner, repo] = repoParts;

	new Notice(`Pushing changes to issue #${frontmatter.issue_number}...`);

	// Update the issue on GitHub
	// For title, we use the file name (without extension and issue number prefix)
	// Actually, let's use the title from frontmatter since user might have changed it
	// Or better: use the file name as the new title (since filename = title in Obsidian)
	// Strip issue number prefix: "(123) Title" -> "Title"
	const newTitle = file.basename.replace(/^\(\d+\)\s*/, "").trim();

	await updateIssue(
		authState.accessToken,
		settings.githubBaseUrl,
		owner,
		repo,
		frontmatter.issue_number,
		newTitle,
		bodyForGitHub
	);

	// Update the frontmatter (keep original body with local image paths)
	const updatedFrontmatter = `---
url: "${frontmatter.url}"
---`;

	const newContent = `${updatedFrontmatter}\n\n${originalBody}`;
	await app.vault.modify(file, newContent);

	new Notice(`Issue #${frontmatter.issue_number} updated successfully!`);
}

/**
 * Archive issues that are not in the current iteration
 */
export async function cleanupOldIssues(
	app: App,
	settings: PluginSettings,
	authState: AuthState
): Promise<number> {
	if (!authState.accessToken) {
		throw new Error("Not authenticated. Please login to GitHub first.");
	}

	// Parse project URL
	const projectInfo = parseProjectUrl(settings.projectUrl);
	if (!projectInfo) {
		throw new Error("Invalid project URL.");
	}

	new Notice("Fetching current iteration issues...");

	// Fetch project metadata to get current iteration
	const metadata = await fetchProjectMetadata(
		authState.accessToken,
		settings.githubBaseUrl,
		projectInfo
	);

	// Fetch current issues
	const issues = await fetchProjectIssues(
		authState.accessToken,
		settings.githubBaseUrl,
		projectInfo,
		metadata.currentIteration?.id || null
	);

	const currentIssueNumbers = new Set(issues.map((i) => i.number));

	// Archive old issues
	const archivedCount = await archiveOldIssues(
		app,
		settings,
		currentIssueNumbers
	);

	if (archivedCount > 0) {
		new Notice(`Archived ${archivedCount} old issue(s).`);
	} else {
		new Notice("No old issues to archive.");
	}

	return archivedCount;
}
